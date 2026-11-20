//! # ream-graphql
//!
//! GraphQL query parser and validator for the Ream framework.
//! Uses `graphql-parser` crate for spec-compliant parsing.
//!
//! Queries are parsed and validated in Rust before crossing the NAPI boundary.
//! Invalid queries never reach the TypeScript resolver layer.
//!
//! What is checked here, against the document alone (graphql-js rule names):
//! UniqueFragmentNames, KnownFragmentNames, NoFragmentCycles,
//! UniqueVariableNames, NoUndefinedVariables, and the operation selection of
//! `getOperation` (operationName). The checks that need the schema — known
//! arguments, required arguments — run in the TypeScript engine against the
//! argument map [`parse_schema_arg_types`] extracts.
//!
//! Expansion of fragment spreads is bounded WHILE it runs (see
//! [`ParseLimits`]): a few hundred bytes of nested spreads used to expand to
//! 2^n fields before any limit looked at the result.
//!
//! @implements MISS-28

use graphql_parser::query::{
    parse_query, Definition, Document, FragmentDefinition, OperationDefinition, Selection,
    SelectionSet, Type, Value, VariableDefinition as QueryVariableDefinition,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Key a variable reference travels under in an argument value:
/// `{ "$var": "id" }` for `$id`.
///
/// Not the string `"$id"` it used to be: a string literal written by the
/// client (`name: "$role"`) was then indistinguishable from a reference and got
/// replaced by that variable. A GraphQL name cannot start with `$` (spec §2.1.9),
/// so no object literal can produce this key.
pub const VARIABLE_REFERENCE_KEY: &str = "$var";

/// Parsed field from a GraphQL query.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedField {
    pub name: String,
    pub alias: Option<String>,
    /// A `serde_json::Map` (ordered by name), not a `HashMap`: the order an
    /// argument error is reported in must not change from one run to the next.
    pub args: serde_json::Map<String, serde_json::Value>,
    pub sub_fields: Vec<ParsedField>,
}

/// A variable the selected operation declares (`query Q($id: ID! = 1)`).
#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedVariable {
    pub name: String,
    /// The declared type as written: `ID!`, `[Int!]`.
    #[serde(rename = "type")]
    pub var_type: String,
    /// The named type under the list / non-null wrappers.
    pub named_type: String,
    /// Declared non-null at the outermost level.
    pub non_null: bool,
    pub default_value: Option<serde_json::Value>,
}

/// Result of parsing a GraphQL query.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParseResult {
    pub operation_type: String, // "query", "mutation", "subscription"
    pub operation_name: Option<String>,
    pub fields: Vec<ParsedField>,
    pub variables: Vec<ParsedVariable>,
    pub errors: Vec<String>,
}

impl ParseResult {
    fn failed(errors: Vec<String>) -> Self {
        Self {
            operation_type: "query".to_string(),
            operation_name: None,
            fields: vec![],
            variables: vec![],
            errors,
        }
    }
}

/// How much a query may expand to. Checked while fragments are being expanded,
/// so the work done on a hostile document stops at the limit instead of after
/// the whole tree exists.
#[derive(Debug, Clone, Copy)]
pub struct ParseLimits {
    /// Deepest field nesting allowed (top-level fields are depth 1).
    pub max_depth: usize,
    /// Most fields the expanded selection may hold (aliases count). The same
    /// number also caps how many fragments (spreads and inline fragments) are
    /// expanded, so a chain that doubles spreads without adding fields is
    /// bounded too.
    pub max_fields: usize,
}

impl Default for ParseLimits {
    /// The GraphQL engine's defaults (`maxDepth`, `maxComplexity`).
    fn default() -> Self {
        Self {
            max_depth: 12,
            max_fields: 1000,
        }
    }
}

/// Parse a GraphQL query string with the default [`ParseLimits`] and no
/// operation name.
pub fn parse_graphql_query(query: &str) -> ParseResult {
    parse_graphql_operation(query, None, ParseLimits::default())
}

/// Parse a GraphQL document and expand the operation to execute.
///
/// `operation_name` picks the operation as graphql-js `getOperation` does: the
/// named one, the only one when there is a single operation, and an error
/// otherwise. Returns the operation type, its top-level fields with their
/// arguments (fragments expanded), its declared variables, and any error.
pub fn parse_graphql_operation(
    query: &str,
    operation_name: Option<&str>,
    limits: ParseLimits,
) -> ParseResult {
    let doc: Document<String> = match parse_query::<String>(query) {
        Ok(doc) => doc,
        Err(e) => return ParseResult::failed(vec![format!("Parse error: {}", e)]),
    };

    let fragments = match collect_fragments(&doc) {
        Ok(fragments) => fragments,
        Err(errors) => return ParseResult::failed(errors),
    };
    let fragment_errors = check_fragment_spreads(&fragments);
    if !fragment_errors.is_empty() {
        return ParseResult::failed(fragment_errors);
    }

    let operation = match select_operation(&doc, operation_name) {
        Ok(operation) => operation,
        Err(error) => return ParseResult::failed(vec![error]),
    };
    let (operation_type, name, variable_definitions, selection_set) = match operation {
        OperationDefinition::Query(q) => (
            "query",
            q.name.clone(),
            &q.variable_definitions[..],
            &q.selection_set,
        ),
        OperationDefinition::Mutation(m) => (
            "mutation",
            m.name.clone(),
            &m.variable_definitions[..],
            &m.selection_set,
        ),
        OperationDefinition::Subscription(s) => (
            "subscription",
            s.name.clone(),
            &s.variable_definitions[..],
            &s.selection_set,
        ),
        OperationDefinition::SelectionSet(ss) => ("query", None, &[][..], ss),
    };

    let mut errors = Vec::new();
    let variables = parse_variable_definitions(variable_definitions, &mut errors);
    let declared: HashSet<&str> = variables.iter().map(|v| v.name.as_str()).collect();

    let mut expander = Expander {
        fragments: &fragments,
        declared: &declared,
        operation_name: name.as_deref(),
        limits,
        field_count: 0,
        fragment_count: 0,
        errors: &mut errors,
    };
    let fields = match expander.expand(selection_set, 1) {
        Ok(fields) => fields,
        // A limit stops everything: what was expanded so far is dropped.
        Err(limit) => return ParseResult::failed(vec![limit]),
    };

    ParseResult {
        operation_type: operation_type.to_string(),
        operation_name: name,
        fields,
        variables,
        errors,
    }
}

/// Named fragments by name (UniqueFragmentNames).
fn collect_fragments<'d>(
    doc: &'d Document<'d, String>,
) -> Result<HashMap<String, &'d FragmentDefinition<'d, String>>, Vec<String>> {
    let mut fragments: HashMap<String, &FragmentDefinition<String>> = HashMap::new();
    let mut errors = Vec::new();
    for def in &doc.definitions {
        if let Definition::Fragment(frag) = def {
            if fragments.insert(frag.name.clone(), frag).is_some() {
                errors.push(format!(
                    "There can be only one fragment named \"{}\".",
                    frag.name
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(fragments)
    } else {
        Err(errors)
    }
}

/// The fragment names a selection set spreads, nested selections included.
fn spreads_of<'a>(selection_set: &'a SelectionSet<String>, out: &mut Vec<&'a str>) {
    for sel in &selection_set.items {
        match sel {
            Selection::Field(f) => spreads_of(&f.selection_set, out),
            Selection::FragmentSpread(spread) => out.push(spread.fragment_name.as_str()),
            Selection::InlineFragment(inline) => spreads_of(&inline.selection_set, out),
        }
    }
}

/// KnownFragmentNames and NoFragmentCycles, over every fragment of the
/// document, each visited once. Iterative, so a long chain of fragments cannot
/// exhaust the stack.
fn check_fragment_spreads(fragments: &HashMap<String, &FragmentDefinition<String>>) -> Vec<String> {
    let mut errors = Vec::new();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for (name, frag) in fragments {
        let mut spreads = Vec::new();
        spreads_of(&frag.selection_set, &mut spreads);
        for spread in &spreads {
            if !fragments.contains_key(*spread) {
                errors.push(format!("Unknown fragment \"{spread}\"."));
            }
        }
        spreads.retain(|spread| fragments.contains_key(*spread));
        edges.insert(name.as_str(), spreads);
    }

    // Three-colour depth-first search: a spread reaching a fragment still on
    // the path is a cycle.
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        OnPath,
        Done,
    }
    let mut marks: HashMap<&str, Mark> = HashMap::new();
    let mut names: Vec<&str> = edges.keys().copied().collect();
    names.sort_unstable();
    for start in names {
        if marks.contains_key(start) {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(start, 0)];
        marks.insert(start, Mark::OnPath);
        while let Some((node, next)) = stack.last_mut() {
            let targets = edges.get(*node).map(Vec::as_slice).unwrap_or(&[]);
            match targets.get(*next) {
                Some(target) => {
                    *next += 1;
                    match marks.get(target) {
                        Some(Mark::OnPath) => {
                            let message =
                                format!("Cannot spread fragment \"{target}\" within itself.");
                            if !errors.contains(&message) {
                                errors.push(message);
                            }
                        }
                        Some(Mark::Done) => {}
                        None => {
                            marks.insert(target, Mark::OnPath);
                            stack.push((target, 0));
                        }
                    }
                }
                None => {
                    marks.insert(*node, Mark::Done);
                    stack.pop();
                }
            }
        }
    }
    errors
}

/// The operation to run (graphql-js `getOperation`).
fn select_operation<'d>(
    doc: &'d Document<'d, String>,
    operation_name: Option<&str>,
) -> Result<&'d OperationDefinition<'d, String>, String> {
    let operations: Vec<&OperationDefinition<String>> = doc
        .definitions
        .iter()
        .filter_map(|def| match def {
            Definition::Operation(op) => Some(op),
            Definition::Fragment(_) => None,
        })
        .collect();
    match operation_name {
        Some(wanted) => operations
            .into_iter()
            .find(|op| operation_name_of(op) == Some(wanted))
            .ok_or_else(|| format!("Unknown operation named \"{wanted}\".")),
        None => match operations.as_slice() {
            [only] => Ok(*only),
            [] => Err("Must provide an operation.".to_string()),
            _ => Err(
                "Must provide operation name if query contains multiple operations.".to_string(),
            ),
        },
    }
}

fn operation_name_of<'a>(op: &'a OperationDefinition<String>) -> Option<&'a str> {
    match op {
        OperationDefinition::Query(q) => q.name.as_deref(),
        OperationDefinition::Mutation(m) => m.name.as_deref(),
        OperationDefinition::Subscription(s) => s.name.as_deref(),
        OperationDefinition::SelectionSet(_) => None,
    }
}

/// The operation's variable definitions (UniqueVariableNames), defaults
/// converted.
fn parse_variable_definitions(
    definitions: &[QueryVariableDefinition<String>],
    errors: &mut Vec<String>,
) -> Vec<ParsedVariable> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for def in definitions {
        if !seen.insert(def.name.as_str()) {
            errors.push(format!(
                "There can be only one variable named \"${}\".",
                def.name
            ));
            continue;
        }
        let default_value = def.default_value.as_ref().and_then(|value| {
            graphql_value_to_json(value, false)
                .map_err(|error| {
                    errors.push(format!("Variable \"${}\" default value: {error}", def.name))
                })
                .ok()
        });
        out.push(ParsedVariable {
            name: def.name.clone(),
            var_type: type_to_string(&def.var_type),
            named_type: named_type(&def.var_type),
            non_null: matches!(def.var_type, Type::NonNullType(_)),
            default_value,
        });
    }
    out
}

fn type_to_string(t: &Type<String>) -> String {
    match t {
        Type::NamedType(name) => name.clone(),
        Type::ListType(inner) => format!("[{}]", type_to_string(inner)),
        Type::NonNullType(inner) => format!("{}!", type_to_string(inner)),
    }
}

fn named_type(t: &Type<String>) -> String {
    match t {
        Type::NamedType(name) => name.clone(),
        Type::ListType(inner) | Type::NonNullType(inner) => named_type(inner),
    }
}

/// Expands the operation's selection set into fields, fragments inlined,
/// within the budget of [`ParseLimits`].
struct Expander<'a, 'd> {
    fragments: &'a HashMap<String, &'d FragmentDefinition<'d, String>>,
    declared: &'a HashSet<&'a str>,
    operation_name: Option<&'a str>,
    limits: ParseLimits,
    field_count: usize,
    fragment_count: usize,
    errors: &'a mut Vec<String>,
}

impl Expander<'_, '_> {
    fn too_complex(&self) -> String {
        format!(
            "Query is too complex (max {} fields)",
            self.limits.max_fields
        )
    }

    /// Spend one fragment expansion. A fragment spread twice by the fragment
    /// above it is expanded twice — that is what selecting it twice means —
    /// so the count, not a "visited" set, is what bounds a doubling chain.
    fn spend_fragment(&mut self) -> Result<(), String> {
        self.fragment_count += 1;
        if self.fragment_count > self.limits.max_fields {
            return Err(self.too_complex());
        }
        Ok(())
    }

    fn expand(
        &mut self,
        selection_set: &SelectionSet<String>,
        depth: usize,
    ) -> Result<Vec<ParsedField>, String> {
        let mut fields = Vec::new();
        for sel in &selection_set.items {
            match sel {
                Selection::Field(f) => {
                    if depth > self.limits.max_depth {
                        return Err(format!(
                            "Query is too deep (max depth {})",
                            self.limits.max_depth
                        ));
                    }
                    self.field_count += 1;
                    if self.field_count > self.limits.max_fields {
                        return Err(self.too_complex());
                    }
                    let mut args = serde_json::Map::new();
                    for (name, value) in &f.arguments {
                        self.check_variables(value);
                        let json = graphql_value_to_json(value, true).unwrap_or_else(|error| {
                            self.errors
                                .push(format!("Argument \"{name}\" of \"{}\": {error}", f.name));
                            serde_json::Value::Null
                        });
                        args.insert(name.clone(), json);
                    }
                    let sub_fields = self.expand(&f.selection_set, depth + 1)?;
                    fields.push(ParsedField {
                        name: f.name.clone(),
                        alias: f.alias.clone(),
                        args,
                        sub_fields,
                    });
                }
                Selection::FragmentSpread(spread) => {
                    self.spend_fragment()?;
                    // No cycle remains: fragments spreading themselves were
                    // refused before expansion started. Unknown targets in a
                    // fragment were too; one in the operation is caught here.
                    match self.fragments.get(&spread.fragment_name) {
                        Some(frag) => {
                            let mut expanded = self.expand(&frag.selection_set, depth)?;
                            fields.append(&mut expanded);
                        }
                        None => {
                            let message = format!("Unknown fragment \"{}\".", spread.fragment_name);
                            if !self.errors.contains(&message) {
                                self.errors.push(message);
                            }
                        }
                    }
                }
                Selection::InlineFragment(inline) => {
                    self.spend_fragment()?;
                    let mut expanded = self.expand(&inline.selection_set, depth)?;
                    fields.append(&mut expanded);
                }
            }
        }
        Ok(fields)
    }

    /// NoUndefinedVariables: every `$name` an argument uses is declared by the
    /// operation.
    fn check_variables(&mut self, value: &Value<String>) {
        match value {
            Value::Variable(name) => {
                if !self.declared.contains(name.as_str()) {
                    let message = match self.operation_name {
                        Some(op) => {
                            format!("Variable \"${name}\" is not defined by operation \"{op}\".")
                        }
                        None => format!("Variable \"${name}\" is not defined."),
                    };
                    if !self.errors.contains(&message) {
                        self.errors.push(message);
                    }
                }
            }
            Value::List(items) => items.iter().for_each(|item| self.check_variables(item)),
            Value::Object(obj) => obj.values().for_each(|item| self.check_variables(item)),
            _ => {}
        }
    }
}

/// The largest integer a JavaScript number holds exactly (2^53 - 1).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Convert a GraphQL Value to serde_json::Value, refusing a literal the
/// resolver would receive as a different value: an integer past what a
/// JavaScript number holds exactly, or a float that is not finite. Both used
/// to be substituted (rounded, or turned into null) without a word.
///
/// A variable becomes `{ "$var": name }` (see [`VARIABLE_REFERENCE_KEY`]) where
/// `allow_variables` holds; a default value must be constant, so there it is an
/// error.
fn graphql_value_to_json(
    value: &Value<String>,
    allow_variables: bool,
) -> Result<serde_json::Value, String> {
    Ok(match value {
        Value::String(s) => serde_json::Value::String(s.clone()),
        Value::Int(n) => match n.as_i64() {
            Some(int) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&int) => {
                serde_json::Value::Number(serde_json::Number::from(int))
            }
            _ => return Err("integer literal out of range".to_owned()),
        },
        Value::Float(f) => match serde_json::Number::from_f64(*f) {
            Some(number) => serde_json::Value::Number(number),
            None => return Err("float literal is not a finite number".to_owned()),
        },
        Value::Boolean(b) => serde_json::Value::Bool(*b),
        Value::Null => serde_json::Value::Null,
        Value::Enum(e) => serde_json::Value::String(e.clone()),
        Value::List(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| graphql_value_to_json(item, allow_variables))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(obj) => serde_json::Value::Object(
            obj.iter()
                .map(|(k, v)| {
                    graphql_value_to_json(v, allow_variables).map(|json| (k.clone(), json))
                })
                .collect::<Result<_, _>>()?,
        ),
        Value::Variable(name) => {
            if !allow_variables {
                return Err(format!(
                    "a default value cannot use the variable \"${name}\""
                ));
            }
            let mut reference = serde_json::Map::new();
            reference.insert(
                VARIABLE_REFERENCE_KEY.to_string(),
                serde_json::Value::String(name.clone()),
            );
            serde_json::Value::Object(reference)
        }
    })
}

/// Validate a query against the document-level rules (see the crate doc),
/// with the default limits. Returns the errors, empty when valid.
pub fn validate_query(query: &str) -> Vec<String> {
    let result = parse_graphql_query(query);
    result.errors
}

/// One declared argument of a schema field.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SchemaArg {
    /// The declared type as written: `Int!`, `[ID!]`.
    #[serde(rename = "type")]
    pub arg_type: String,
    /// The named type under the list / non-null wrappers — what input
    /// coercion keys on.
    pub named_type: String,
    /// Non-null with no default: a call must pass it (graphql-js
    /// `isRequiredArgument`).
    pub required: bool,
    pub default_value: Option<serde_json::Value>,
}

/// Extract the declared arguments of every object field from a GraphQL SDL
/// schema, `type` definitions and `extend type` alike.
///
/// Returns `{ "Type.field": { "argName": SchemaArg } }`, with an entry for
/// every field — one declaring no argument maps to an empty object — so the
/// TypeScript engine can both coerce argument values to their declared types
/// and refuse an argument the field does not declare. `Err` when the SDL does
/// not parse: an engine that cannot tell which arguments exist must not guess.
pub fn parse_schema_arg_types(
    sdl: &str,
) -> Result<HashMap<String, BTreeMap<String, SchemaArg>>, String> {
    use graphql_parser::schema::{
        parse_schema, Definition as SchemaDef, Field, TypeDefinition, TypeExtension,
    };

    fn add_fields(
        out: &mut HashMap<String, BTreeMap<String, SchemaArg>>,
        type_name: &str,
        fields: &[Field<String>],
    ) -> Result<(), String> {
        for field in fields {
            // Ordered by name, so the errors about them come in a stable order.
            let mut args = BTreeMap::new();
            for arg in &field.arguments {
                let default_value = match &arg.default_value {
                    Some(value) => Some(graphql_value_to_json(value, false).map_err(|error| {
                        format!(
                            "{type_name}.{}({}:) default value: {error}",
                            field.name, arg.name
                        )
                    })?),
                    None => None,
                };
                args.insert(
                    arg.name.clone(),
                    SchemaArg {
                        arg_type: type_to_string(&arg.value_type),
                        named_type: named_type(&arg.value_type),
                        required: matches!(arg.value_type, Type::NonNullType(_))
                            && default_value.is_none(),
                        default_value,
                    },
                );
            }
            out.insert(format!("{type_name}.{}", field.name), args);
        }
        Ok(())
    }

    let doc = parse_schema::<String>(sdl).map_err(|e| format!("Schema parse error: {e}"))?;
    let mut out: HashMap<String, BTreeMap<String, SchemaArg>> = HashMap::new();
    for def in &doc.definitions {
        match def {
            SchemaDef::TypeDefinition(TypeDefinition::Object(obj)) => {
                add_fields(&mut out, &obj.name, &obj.fields)?
            }
            SchemaDef::TypeExtension(TypeExtension::Object(ext)) => {
                add_fields(&mut out, &ext.name, &ext.fields)?
            }
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_query() {
        let result = parse_graphql_query("{ tasks { id title } }");
        assert_eq!(result.operation_type, "query");
        assert_eq!(result.fields.len(), 1);
        assert_eq!(result.fields[0].name, "tasks");
        assert_eq!(result.fields[0].sub_fields.len(), 2);
    }

    #[test]
    fn test_parse_mutation_with_args() {
        let result = parse_graphql_query(
            r#"
            mutation {
                createTask(title: "Fix bug", urgency: "high") {
                    id
                    title
                }
            }
        "#,
        );
        assert_eq!(result.operation_type, "mutation");
        assert_eq!(result.fields[0].name, "createTask");
        assert_eq!(result.fields[0].args.get("title").unwrap(), "Fix bug");
        assert_eq!(result.fields[0].args.get("urgency").unwrap(), "high");
    }

    #[test]
    fn test_parse_query_with_variables() {
        let result = parse_graphql_query(
            r#"
            query GetTask($id: ID!, $limit: [Int!] = [10]) {
                task(id: $id, limit: $limit) {
                    id
                    title
                    status
                }
            }
        "#,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.operation_type, "query");
        assert_eq!(result.operation_name, Some("GetTask".to_string()));
        assert_eq!(result.fields[0].name, "task");
        assert_eq!(
            result.fields[0].args["id"],
            serde_json::json!({ "$var": "id" })
        );
        assert_eq!(result.variables.len(), 2);
        assert_eq!(result.variables[0].name, "id");
        assert_eq!(result.variables[0].var_type, "ID!");
        assert_eq!(result.variables[0].named_type, "ID");
        assert!(result.variables[0].non_null);
        assert_eq!(result.variables[1].var_type, "[Int!]");
        assert!(!result.variables[1].non_null);
        assert_eq!(
            result.variables[1].default_value,
            Some(serde_json::json!([10]))
        );
    }

    #[test]
    fn a_string_literal_starting_with_a_dollar_is_not_a_variable() {
        let result =
            parse_graphql_query(r#"query Q($role: String) { update(name: "$role") { id } }"#);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.fields[0].args["name"], serde_json::json!("$role"));
    }

    #[test]
    fn a_variable_the_operation_does_not_declare_is_refused() {
        let named = parse_graphql_query("query Q { task(id: $id) { id } }");
        assert_eq!(
            named.errors,
            vec!["Variable \"$id\" is not defined by operation \"Q\".".to_string()]
        );
        let anonymous = parse_graphql_query("{ task(filter: { ids: [$id] }) { id } }");
        assert_eq!(
            anonymous.errors,
            vec!["Variable \"$id\" is not defined.".to_string()]
        );
        let in_fragment = parse_graphql_query(
            "query Q($a: ID) { task { ...F } } fragment F on Task { sub(id: $b) { id } }",
        );
        assert!(in_fragment.errors[0].contains("\"$b\""));
    }

    #[test]
    fn a_duplicate_variable_is_refused() {
        let result = parse_graphql_query("query Q($a: ID, $a: Int) { task(id: $a) { id } }");
        assert!(result
            .errors
            .contains(&"There can be only one variable named \"$a\".".to_string()));
    }

    #[test]
    fn operation_name_picks_the_operation_to_run() {
        let doc = "query A { a } mutation B { b }";
        let picked = parse_graphql_operation(doc, Some("A"), ParseLimits::default());
        assert!(picked.errors.is_empty(), "{:?}", picked.errors);
        assert_eq!(picked.operation_type, "query");
        assert_eq!(picked.fields[0].name, "a");

        let other = parse_graphql_operation(doc, Some("B"), ParseLimits::default());
        assert_eq!(other.operation_type, "mutation");
        assert_eq!(other.fields[0].name, "b");

        let unnamed = parse_graphql_operation(doc, None, ParseLimits::default());
        assert_eq!(
            unnamed.errors,
            vec!["Must provide operation name if query contains multiple operations.".to_string()]
        );
        assert!(unnamed.fields.is_empty());

        let unknown = parse_graphql_operation(doc, Some("C"), ParseLimits::default());
        assert_eq!(
            unknown.errors,
            vec!["Unknown operation named \"C\".".to_string()]
        );

        let none = parse_graphql_query("fragment F on Query { a }");
        assert_eq!(none.errors, vec!["Must provide an operation.".to_string()]);
    }

    #[test]
    fn an_integer_literal_past_a_safe_integer_is_refused() {
        for literal in [
            "99999999999999999999",
            "9007199254740992",
            "-9007199254740992",
        ] {
            let result = parse_graphql_query(&format!("{{ items(limit: {literal}) {{ id }} }}"));
            assert!(!result.errors.is_empty(), "{literal} was accepted");
        }
        let result = parse_graphql_query("{ items(limit: 9007199254740991) { id } }");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(
            result.fields[0].args["limit"],
            serde_json::json!(9_007_199_254_740_991_i64)
        );
    }

    #[test]
    fn a_float_literal_that_is_not_finite_is_refused() {
        let result = parse_graphql_query("{ items(ratio: 1e400) { id } }");
        assert!(!result.errors.is_empty());
        let nested = parse_graphql_query("{ items(filter: { ratios: [1.5, 1e400] }) { id } }");
        assert!(!nested.errors.is_empty());
    }

    #[test]
    fn test_parse_invalid_query() {
        let result = parse_graphql_query("{ invalid {{ }");
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn test_parse_nested_fields() {
        let result = parse_graphql_query("{ users { posts { comments { text } } } }");
        assert_eq!(result.fields[0].name, "users");
        assert_eq!(result.fields[0].sub_fields[0].name, "posts");
        assert_eq!(
            result.fields[0].sub_fields[0].sub_fields[0].name,
            "comments"
        );
        assert_eq!(
            result.fields[0].sub_fields[0].sub_fields[0].sub_fields[0].name,
            "text"
        );
    }

    #[test]
    fn test_parse_aliased_field() {
        let result = parse_graphql_query("{ myTasks: tasks { id } }");
        assert_eq!(result.fields[0].name, "tasks");
        assert_eq!(result.fields[0].alias, Some("myTasks".to_string()));
    }

    #[test]
    fn test_fragment_spread_is_expanded() {
        let result = parse_graphql_query(
            "query { task { ...TaskFields } } fragment TaskFields on Task { id title }",
        );
        assert!(result.errors.is_empty());
        let task = &result.fields[0];
        assert_eq!(task.name, "task");
        // The spread expanded into the fragment's fields.
        let names: Vec<&str> = task.sub_fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "title"]);
    }

    #[test]
    fn test_fragment_spread_mixed_with_explicit_fields() {
        let result = parse_graphql_query(
            "query { task { id ...Rest } } fragment Rest on Task { title status }",
        );
        let task = &result.fields[0];
        let names: Vec<&str> = task.sub_fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "title", "status"]);
    }

    #[test]
    fn test_inline_fragment_is_expanded() {
        let result = parse_graphql_query("query { node { ... on Task { id title } } }");
        let node = &result.fields[0];
        let names: Vec<&str> = node.sub_fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["id", "title"]);
    }

    #[test]
    fn a_cyclic_fragment_is_refused() {
        let result = parse_graphql_query("query { task { ...A } } fragment A on Task { id ...A }");
        assert_eq!(
            result.errors,
            vec!["Cannot spread fragment \"A\" within itself.".to_string()]
        );
        assert!(result.fields.is_empty());
        let indirect = parse_graphql_query(
            "query { task { ...A } } fragment A on Task { ...B } fragment B on Task { id ...A }",
        );
        assert_eq!(indirect.errors.len(), 1, "{:?}", indirect.errors);
        assert!(indirect.errors[0].starts_with("Cannot spread fragment"));
    }

    #[test]
    fn an_unknown_fragment_is_refused() {
        let result = parse_graphql_query("query { task { id ...Missing } }");
        assert_eq!(
            result.errors,
            vec!["Unknown fragment \"Missing\".".to_string()]
        );
        let in_fragment =
            parse_graphql_query("query { task { ...A } } fragment A on Task { ...Missing }");
        assert_eq!(
            in_fragment.errors,
            vec!["Unknown fragment \"Missing\".".to_string()]
        );
    }

    #[test]
    fn a_duplicate_fragment_name_is_refused() {
        let result = parse_graphql_query(
            "query { task { ...A } } fragment A on Task { id } fragment A on Task { title }",
        );
        assert_eq!(
            result.errors,
            vec!["There can be only one fragment named \"A\".".to_string()]
        );
    }

    /// `query { ...F0 } fragment F0 { ...F1 ...F1 } … fragment Fn { a }`.
    fn doubling_chain(n: usize) -> String {
        let mut doc = String::from("query { ...F0 }\n");
        for i in 0..n {
            doc.push_str(&format!(
                "fragment F{i} on Query {{ ...F{0} ...F{0} }}\n",
                i + 1
            ));
        }
        doc.push_str(&format!("fragment F{n} on Query {{ a }}\n"));
        doc
    }

    #[test]
    fn a_doubling_fragment_chain_stops_at_the_limit_instead_of_expanding() {
        // 2^40 fields if expanded; ~1.6 KB of source.
        let doc = doubling_chain(40);
        assert!(doc.len() < 2_000);
        let started = std::time::Instant::now();
        let result = parse_graphql_query(&doc);
        let elapsed = started.elapsed();
        assert_eq!(
            result.errors,
            vec!["Query is too complex (max 1000 fields)".to_string()]
        );
        assert!(result.fields.is_empty());
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "took {elapsed:?}"
        );
    }

    #[test]
    fn a_chain_of_spreads_that_adds_no_field_is_bounded_too() {
        // Every fragment spreads the next twice; the last one selects a field
        // only once the budget is gone, so it is the fragment count that stops it.
        let doc = doubling_chain(30);
        let limits = ParseLimits {
            max_depth: 12,
            max_fields: 50,
        };
        let result = parse_graphql_operation(&doc, None, limits);
        assert_eq!(
            result.errors,
            vec!["Query is too complex (max 50 fields)".to_string()]
        );
    }

    #[test]
    fn a_fragment_used_within_the_limits_is_expanded_in_full() {
        let doc = doubling_chain(3); // 8 fields
        let result = parse_graphql_query(&doc);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.fields.len(), 8);
    }

    #[test]
    fn depth_is_bounded_while_expanding() {
        let limits = ParseLimits {
            max_depth: 2,
            max_fields: 1000,
        };
        let deep = parse_graphql_operation("{ a { b { c } } }", None, limits);
        assert_eq!(
            deep.errors,
            vec!["Query is too deep (max depth 2)".to_string()]
        );
        let through_fragment =
            parse_graphql_operation("{ a { ...F } } fragment F on A { b { c } }", None, limits);
        assert_eq!(
            through_fragment.errors,
            vec!["Query is too deep (max depth 2)".to_string()]
        );
        let ok = parse_graphql_operation("{ a { b } }", None, limits);
        assert!(ok.errors.is_empty());
    }

    #[test]
    fn test_schema_arg_types_are_extracted() {
        let sdl = "type Query { task(id: Int!, tag: String, size: Int! = 10): Task count(ids: [ID!]): Int } type Task { id: Int } extend type Query { me: Task }";
        let types = parse_schema_arg_types(sdl).expect("schema parses");
        let task = types.get("Query.task").expect("Query.task args");
        let id = task.get("id").expect("id");
        assert_eq!(id.named_type, "Int");
        assert_eq!(id.arg_type, "Int!");
        assert!(id.required);
        assert!(!task.get("tag").expect("tag").required);
        // Non-null with a default is not required (graphql-js isRequiredArgument).
        let size = task.get("size").expect("size");
        assert!(!size.required);
        assert_eq!(size.default_value, Some(serde_json::json!(10)));
        // List + NonNull are unwrapped to the underlying named type.
        let count = types.get("Query.count").expect("Query.count args");
        assert_eq!(count.get("ids").expect("ids").named_type, "ID");
        // A field with no arguments is listed with none, so an argument sent
        // to it can be refused.
        assert_eq!(types.get("Task.id").map(BTreeMap::len), Some(0));
        // `extend type` fields are included.
        assert!(types.contains_key("Query.me"));
    }

    #[test]
    fn an_unparseable_schema_is_an_error() {
        assert!(parse_schema_arg_types("type Query {").is_err());
    }
}
