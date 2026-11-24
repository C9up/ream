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
//! `getOperation` (operationName). The checks that need the schema — fields on
//! the right type, leaf selections, known and required arguments — run in the
//! TypeScript engine against the type map [`parse_schema_types`] extracts.
//!
//! Expansion of fragment spreads is bounded WHILE it runs (see
//! [`ParseLimits`]): a few hundred bytes of nested spreads used to expand to
//! 2^n fields before any limit looked at the result. The errors collected are
//! bounded too: validation stops at `max_errors`, as graphql-js does.
//!
//! @implements MISS-28

use graphql_parser::query::{
    parse_query, Definition, Document, FragmentDefinition, OperationDefinition, Selection,
    SelectionSet, Type, TypeCondition, Value, VariableDefinition as QueryVariableDefinition,
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
    /// The type condition of the fragment the field was expanded from, as an
    /// index into [`ParseResult::type_conditions`]; `None` for a field written
    /// directly in its selection set.
    pub condition: Option<usize>,
}

/// One fragment type condition (`... on User`, `fragment F on User`) a field
/// was expanded under.
///
/// Fragments are inlined, so the condition is what is left to say which type
/// a field was selected on. Both members are indexes, never the name itself:
/// a fragment spread a thousand times would otherwise copy its type name a
/// thousand times into the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TypeConditionLink {
    /// The type named, as an index into [`ParseResult::type_names`].
    pub name: usize,
    /// The condition of the fragment this one sits in, when there is one.
    pub parent: Option<usize>,
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
    /// The distinct type names the fragments condition on.
    pub type_names: Vec<String>,
    /// The type conditions [`ParsedField::condition`] points into.
    pub type_conditions: Vec<TypeConditionLink>,
    pub errors: Vec<String>,
}

impl ParseResult {
    fn failed(errors: Vec<String>) -> Self {
        Self {
            operation_type: "query".to_string(),
            operation_name: None,
            fields: vec![],
            variables: vec![],
            type_names: vec![],
            type_conditions: vec![],
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
    /// Most validation errors collected before the parse stops (graphql-js
    /// `maxErrors`). One argument naming thousands of undeclared variables
    /// costs one field: without this bound the reply held one message per
    /// variable.
    pub max_errors: usize,
}

impl Default for ParseLimits {
    /// The GraphQL engine's defaults (`maxDepth`, `maxComplexity`,
    /// `maxErrors`).
    fn default() -> Self {
        Self {
            max_depth: 12,
            max_fields: 1000,
            max_errors: 100,
        }
    }
}

/// What graphql-js answers once `maxErrors` is reached.
pub const TOO_MANY_ERRORS: &str =
    "Too many validation errors, error limit reached. Validation aborted.";

/// Why the parse stopped before the operation was expanded in full.
enum Stop {
    /// A [`ParseLimits`] budget is spent: only this message is reported.
    Limit(String),
    /// The document is invalid, or the error limit is reached: the messages
    /// are in the [`ErrorSink`].
    Invalid,
}

/// The validation errors of one parse: each message once, and no more than
/// the limit.
///
/// A set tells whether a message was already reported. Scanning the list for
/// it made N distinct errors cost N²/2 string comparisons on the thread that
/// serves every request.
struct ErrorSink {
    messages: Vec<String>,
    seen: HashSet<String>,
    max: usize,
}

impl ErrorSink {
    fn new(max: usize) -> Self {
        Self {
            messages: Vec::new(),
            seen: HashSet::new(),
            max: max.max(1),
        }
    }

    /// Record `message`. `Err` once the limit is reached: the caller stops
    /// validating, and the last message says so.
    fn push(&mut self, message: String) -> Result<(), Stop> {
        if self.seen.contains(&message) {
            return Ok(());
        }
        if self.messages.len() >= self.max {
            self.messages.push(TOO_MANY_ERRORS.to_string());
            return Err(Stop::Invalid);
        }
        self.seen.insert(message.clone());
        self.messages.push(message);
        Ok(())
    }

    fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }
}

/// The type conditions met while expanding, each stored once.
#[derive(Default)]
struct ConditionTable {
    names: Vec<String>,
    name_index: HashMap<String, usize>,
    links: Vec<TypeConditionLink>,
    link_index: HashMap<TypeConditionLink, usize>,
}

impl ConditionTable {
    /// The index of the condition `on`, under `parent`.
    fn enter(&mut self, on: &str, parent: Option<usize>) -> usize {
        let name = match self.name_index.get(on) {
            Some(index) => *index,
            None => {
                self.names.push(on.to_string());
                self.name_index.insert(on.to_string(), self.names.len() - 1);
                self.names.len() - 1
            }
        };
        let link = TypeConditionLink { name, parent };
        match self.link_index.get(&link) {
            Some(index) => *index,
            None => {
                self.links.push(link);
                self.link_index.insert(link, self.links.len() - 1);
                self.links.len() - 1
            }
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

    let mut errors = ErrorSink::new(limits.max_errors);
    match expand_operation(&doc, operation_name, limits, &mut errors) {
        Ok(mut result) => {
            result.errors = errors.messages;
            result
        }
        // A limit stops everything: what was expanded so far is dropped.
        Err(Stop::Limit(limit)) => ParseResult::failed(vec![limit]),
        Err(Stop::Invalid) => ParseResult::failed(errors.messages),
    }
}

/// The operation `operation_name` picks, expanded. Every error goes to
/// `errors`; `Err` when the parse cannot or must not go on.
fn expand_operation<'d>(
    doc: &'d Document<'d, String>,
    operation_name: Option<&str>,
    limits: ParseLimits,
    errors: &mut ErrorSink,
) -> Result<ParseResult, Stop> {
    let fragments = collect_fragments(doc, errors)?;
    check_fragment_spreads(&fragments, errors)?;

    let operation = match select_operation(doc, operation_name) {
        Ok(operation) => operation,
        Err(error) => {
            errors.push(error)?;
            return Err(Stop::Invalid);
        }
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

    let variables = parse_variable_definitions(variable_definitions, errors)?;
    let declared: HashSet<&str> = variables.iter().map(|v| v.name.as_str()).collect();

    let mut expander = Expander {
        fragments: &fragments,
        declared: &declared,
        operation_name: name.as_deref(),
        limits,
        field_count: 0,
        fragment_count: 0,
        conditions: ConditionTable::default(),
        errors,
    };
    let fields = expander.expand(selection_set, 1, None)?;
    let conditions = expander.conditions;

    Ok(ParseResult {
        operation_type: operation_type.to_string(),
        operation_name: name,
        fields,
        variables,
        type_names: conditions.names,
        type_conditions: conditions.links,
        errors: Vec::new(),
    })
}

/// Named fragments by name (UniqueFragmentNames).
fn collect_fragments<'d>(
    doc: &'d Document<'d, String>,
    errors: &mut ErrorSink,
) -> Result<HashMap<String, &'d FragmentDefinition<'d, String>>, Stop> {
    let mut fragments: HashMap<String, &FragmentDefinition<String>> = HashMap::new();
    for def in &doc.definitions {
        if let Definition::Fragment(frag) = def {
            if fragments.insert(frag.name.clone(), frag).is_some() {
                errors.push(format!(
                    "There can be only one fragment named \"{}\".",
                    frag.name
                ))?;
            }
        }
    }
    if errors.is_empty() {
        Ok(fragments)
    } else {
        Err(Stop::Invalid)
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
fn check_fragment_spreads(
    fragments: &HashMap<String, &FragmentDefinition<String>>,
    errors: &mut ErrorSink,
) -> Result<(), Stop> {
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    // By name, so the errors kept under the limit are the same on every run.
    let mut by_name: Vec<(&String, &&FragmentDefinition<String>)> = fragments.iter().collect();
    by_name.sort_unstable_by_key(|(name, _)| *name);
    for (name, frag) in by_name {
        let mut spreads = Vec::new();
        spreads_of(&frag.selection_set, &mut spreads);
        for spread in &spreads {
            if !fragments.contains_key(*spread) {
                errors.push(format!("Unknown fragment \"{spread}\"."))?;
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
                            errors.push(format!(
                                "Cannot spread fragment \"{target}\" within itself."
                            ))?;
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
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Stop::Invalid)
    }
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
    errors: &mut ErrorSink,
) -> Result<Vec<ParsedVariable>, Stop> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for def in definitions {
        if !seen.insert(def.name.as_str()) {
            errors.push(format!(
                "There can be only one variable named \"${}\".",
                def.name
            ))?;
            continue;
        }
        let default_value = match &def.default_value {
            Some(value) => match graphql_value_to_json(value, false) {
                Ok(json) => Some(json),
                Err(error) => {
                    errors.push(format!("Variable \"${}\" default value: {error}", def.name))?;
                    None
                }
            },
            None => None,
        };
        out.push(ParsedVariable {
            name: def.name.clone(),
            var_type: type_to_string(&def.var_type),
            named_type: named_type(&def.var_type),
            non_null: matches!(def.var_type, Type::NonNullType(_)),
            default_value,
        });
    }
    Ok(out)
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
    conditions: ConditionTable,
    errors: &'a mut ErrorSink,
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
    fn spend_fragment(&mut self) -> Result<(), Stop> {
        self.fragment_count += 1;
        if self.fragment_count > self.limits.max_fields {
            return Err(Stop::Limit(self.too_complex()));
        }
        Ok(())
    }

    /// `condition` is the type condition of the fragment `selection_set`
    /// belongs to, when it is a fragment's.
    fn expand(
        &mut self,
        selection_set: &SelectionSet<String>,
        depth: usize,
        condition: Option<usize>,
    ) -> Result<Vec<ParsedField>, Stop> {
        let mut fields = Vec::new();
        for sel in &selection_set.items {
            match sel {
                Selection::Field(f) => {
                    if depth > self.limits.max_depth {
                        return Err(Stop::Limit(format!(
                            "Query is too deep (max depth {})",
                            self.limits.max_depth
                        )));
                    }
                    self.field_count += 1;
                    if self.field_count > self.limits.max_fields {
                        return Err(Stop::Limit(self.too_complex()));
                    }
                    let mut args = serde_json::Map::new();
                    for (name, value) in &f.arguments {
                        self.check_variables(value)?;
                        let json = match graphql_value_to_json(value, true) {
                            Ok(json) => json,
                            Err(error) => {
                                self.errors.push(format!(
                                    "Argument \"{name}\" of \"{}\": {error}",
                                    f.name
                                ))?;
                                serde_json::Value::Null
                            }
                        };
                        args.insert(name.clone(), json);
                    }
                    // A field's own selection set is on the field's type: the
                    // fragment the field sits in says nothing about it.
                    let sub_fields = self.expand(&f.selection_set, depth + 1, None)?;
                    fields.push(ParsedField {
                        name: f.name.clone(),
                        alias: f.alias.clone(),
                        args,
                        sub_fields,
                        condition,
                    });
                }
                Selection::FragmentSpread(spread) => {
                    self.spend_fragment()?;
                    // No cycle remains: fragments spreading themselves were
                    // refused before expansion started. Unknown targets in a
                    // fragment were too; one in the operation is caught here.
                    match self.fragments.get(&spread.fragment_name) {
                        Some(frag) => {
                            let TypeCondition::On(on) = &frag.type_condition;
                            let inner = self.conditions.enter(on, condition);
                            let mut expanded =
                                self.expand(&frag.selection_set, depth, Some(inner))?;
                            fields.append(&mut expanded);
                        }
                        None => {
                            self.errors
                                .push(format!("Unknown fragment \"{}\".", spread.fragment_name))?;
                        }
                    }
                }
                Selection::InlineFragment(inline) => {
                    self.spend_fragment()?;
                    // `... { a }` has no condition of its own: the enclosing
                    // one still applies.
                    let inner = match &inline.type_condition {
                        Some(TypeCondition::On(on)) => Some(self.conditions.enter(on, condition)),
                        None => condition,
                    };
                    let mut expanded = self.expand(&inline.selection_set, depth, inner)?;
                    fields.append(&mut expanded);
                }
            }
        }
        Ok(fields)
    }

    /// NoUndefinedVariables: every `$name` an argument uses is declared by the
    /// operation.
    fn check_variables(&mut self, value: &Value<String>) -> Result<(), Stop> {
        match value {
            Value::Variable(name) => {
                if !self.declared.contains(name.as_str()) {
                    let message = match self.operation_name {
                        Some(op) => {
                            format!("Variable \"${name}\" is not defined by operation \"{op}\".")
                        }
                        None => format!("Variable \"${name}\" is not defined."),
                    };
                    self.errors.push(message)?;
                }
            }
            Value::List(items) => {
                for item in items {
                    self.check_variables(item)?;
                }
            }
            Value::Object(obj) => {
                for item in obj.values() {
                    self.check_variables(item)?;
                }
            }
            _ => {}
        }
        Ok(())
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

/// One field an object or interface type declares.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SchemaField {
    /// The declared return type as written: `[Task!]!`, `User`.
    #[serde(rename = "type")]
    pub field_type: String,
    /// The named type under the list / non-null wrappers.
    pub named_type: String,
    /// Ordered by name, so the errors about them come in a stable order.
    pub args: BTreeMap<String, SchemaArg>,
}

/// What a named type of the schema is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TypeKind {
    Object,
    Interface,
    Union,
    Scalar,
    Enum,
    Input,
}

/// One named type of the schema.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SchemaType {
    pub kind: TypeKind,
    /// Object and interface types: the fields they declare.
    pub fields: BTreeMap<String, SchemaField>,
    /// Object and interface types: the interfaces they implement.
    pub interfaces: Vec<String>,
    /// Union types: their member types.
    pub members: Vec<String>,
}

impl SchemaType {
    fn new(kind: TypeKind) -> Self {
        Self {
            kind,
            fields: BTreeMap::new(),
            interfaces: Vec::new(),
            members: Vec::new(),
        }
    }
}

/// The scalars every schema has without declaring them.
const BUILT_IN_SCALARS: [&str; 5] = ["Int", "Float", "String", "Boolean", "ID"];

/// Extract the types of a GraphQL SDL schema: every object, interface and
/// union type with the fields it declares (their return types and arguments),
/// and the scalar, enum and input types by name. `extend` definitions are
/// merged into the type they extend.
///
/// This is what the TypeScript engine checks a selection against at every
/// depth, coerces argument values with, and reads a resolver's result by: a
/// field no type declares is neither accepted nor copied out.
///
/// `Err` when the SDL does not parse, declares a type twice, or names a type
/// it does not declare where the engine has to know what it is (a field's
/// return type, a union member, an implemented interface): an engine that
/// cannot tell an object from a scalar must not guess which fields it has.
pub fn parse_schema_types(sdl: &str) -> Result<BTreeMap<String, SchemaType>, String> {
    use graphql_parser::schema::{
        parse_schema, Definition as SchemaDef, Field, TypeDefinition, TypeExtension,
    };

    fn add_fields(
        target: &mut SchemaType,
        type_name: &str,
        fields: &[Field<String>],
    ) -> Result<(), String> {
        for field in fields {
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
            target.fields.insert(
                field.name.clone(),
                SchemaField {
                    field_type: type_to_string(&field.field_type),
                    named_type: named_type(&field.field_type),
                    args,
                },
            );
        }
        Ok(())
    }

    fn define<'t>(
        types: &'t mut BTreeMap<String, SchemaType>,
        name: &str,
        kind: TypeKind,
    ) -> Result<&'t mut SchemaType, String> {
        if types.contains_key(name) {
            return Err(format!("There can be only one type named \"{name}\"."));
        }
        Ok(types
            .entry(name.to_string())
            .or_insert_with(|| SchemaType::new(kind)))
    }

    /// The type an `extend` adds to. One that extends a type the document
    /// does not define is taken as its definition.
    fn extend<'t>(
        types: &'t mut BTreeMap<String, SchemaType>,
        name: &str,
        kind: TypeKind,
    ) -> Result<&'t mut SchemaType, String> {
        let target = types
            .entry(name.to_string())
            .or_insert_with(|| SchemaType::new(kind));
        if target.kind != kind {
            return Err(format!(
                "Cannot extend \"{name}\" as a different kind of type."
            ));
        }
        Ok(target)
    }

    let doc = parse_schema::<String>(sdl).map_err(|e| format!("Schema parse error: {e}"))?;
    let mut types: BTreeMap<String, SchemaType> = BTreeMap::new();
    // Definitions first: an `extend` may come before the type it extends.
    for def in &doc.definitions {
        if let SchemaDef::TypeDefinition(definition) = def {
            match definition {
                TypeDefinition::Object(obj) => {
                    let target = define(&mut types, &obj.name, TypeKind::Object)?;
                    target
                        .interfaces
                        .extend(obj.implements_interfaces.iter().cloned());
                    add_fields(target, &obj.name, &obj.fields)?;
                }
                TypeDefinition::Interface(interface) => {
                    let target = define(&mut types, &interface.name, TypeKind::Interface)?;
                    target
                        .interfaces
                        .extend(interface.implements_interfaces.iter().cloned());
                    add_fields(target, &interface.name, &interface.fields)?;
                }
                TypeDefinition::Union(union) => {
                    let target = define(&mut types, &union.name, TypeKind::Union)?;
                    target.members.extend(union.types.iter().cloned());
                }
                TypeDefinition::Scalar(scalar) => {
                    define(&mut types, &scalar.name, TypeKind::Scalar)?;
                }
                TypeDefinition::Enum(en) => {
                    define(&mut types, &en.name, TypeKind::Enum)?;
                }
                TypeDefinition::InputObject(input) => {
                    define(&mut types, &input.name, TypeKind::Input)?;
                }
            }
        }
    }
    for def in &doc.definitions {
        if let SchemaDef::TypeExtension(extension) = def {
            match extension {
                TypeExtension::Object(ext) => {
                    let target = extend(&mut types, &ext.name, TypeKind::Object)?;
                    target
                        .interfaces
                        .extend(ext.implements_interfaces.iter().cloned());
                    add_fields(target, &ext.name, &ext.fields)?;
                }
                TypeExtension::Interface(ext) => {
                    let target = extend(&mut types, &ext.name, TypeKind::Interface)?;
                    target
                        .interfaces
                        .extend(ext.implements_interfaces.iter().cloned());
                    add_fields(target, &ext.name, &ext.fields)?;
                }
                TypeExtension::Union(ext) => {
                    let target = extend(&mut types, &ext.name, TypeKind::Union)?;
                    target.members.extend(ext.types.iter().cloned());
                }
                TypeExtension::Scalar(ext) => {
                    extend(&mut types, &ext.name, TypeKind::Scalar)?;
                }
                TypeExtension::Enum(ext) => {
                    extend(&mut types, &ext.name, TypeKind::Enum)?;
                }
                TypeExtension::InputObject(ext) => {
                    extend(&mut types, &ext.name, TypeKind::Input)?;
                }
            }
        }
    }

    // Every name the engine has to resolve is declared, and is of a kind that
    // can stand there.
    let kind_of = |name: &str| -> Option<TypeKind> {
        match types.get(name) {
            Some(found) => Some(found.kind),
            None if BUILT_IN_SCALARS.contains(&name) => Some(TypeKind::Scalar),
            None => None,
        }
    };
    for (type_name, definition) in &types {
        for (field_name, field) in &definition.fields {
            match kind_of(&field.named_type) {
                None => return Err(format!("Unknown type \"{}\".", field.named_type)),
                Some(TypeKind::Input) => {
                    return Err(format!(
                        "The type of {type_name}.{field_name} must be an output type, not the input type \"{}\".",
                        field.named_type
                    ))
                }
                Some(_) => {}
            }
        }
        for interface in &definition.interfaces {
            if kind_of(interface) != Some(TypeKind::Interface) {
                return Err(format!(
                    "Type {type_name} can only implement interface types, and \"{interface}\" is not one."
                ));
            }
        }
        for member in &definition.members {
            if kind_of(member) != Some(TypeKind::Object) {
                return Err(format!(
                    "Union type {type_name} can only include object types, and \"{member}\" is not one."
                ));
            }
        }
    }
    Ok(types)
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
            max_fields: 50,
            ..ParseLimits::default()
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
            ..ParseLimits::default()
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
    fn test_schema_types_are_extracted() {
        let sdl = "type Query { task(id: Int!, tag: String, size: Int! = 10): Task count(ids: [ID!]): Int tasks: [Task!]! } type Task { id: Int } extend type Query { me: Task }";
        let types = parse_schema_types(sdl).expect("schema parses");
        let query = types.get("Query").expect("Query");
        assert_eq!(query.kind, TypeKind::Object);
        let task = query.fields.get("task").expect("Query.task");
        assert_eq!(task.field_type, "Task");
        let id = task.args.get("id").expect("id");
        assert_eq!(id.named_type, "Int");
        assert_eq!(id.arg_type, "Int!");
        assert!(id.required);
        assert!(!task.args.get("tag").expect("tag").required);
        // Non-null with a default is not required (graphql-js isRequiredArgument).
        let size = task.args.get("size").expect("size");
        assert!(!size.required);
        assert_eq!(size.default_value, Some(serde_json::json!(10)));
        // List + NonNull are unwrapped to the underlying named type.
        let count = query.fields.get("count").expect("Query.count");
        assert_eq!(count.args.get("ids").expect("ids").named_type, "ID");
        // The return type is kept as written, next to its named type.
        let tasks = query.fields.get("tasks").expect("Query.tasks");
        assert_eq!(tasks.field_type, "[Task!]!");
        assert_eq!(tasks.named_type, "Task");
        // A field with no arguments is listed with none, so an argument sent
        // to it can be refused.
        let task_type = types.get("Task").expect("Task");
        assert_eq!(task_type.fields.get("id").map(|f| f.args.len()), Some(0));
        // `extend type` fields are included.
        assert!(query.fields.contains_key("me"));
    }

    #[test]
    fn abstract_types_and_leaf_types_are_listed_by_kind() {
        let sdl = "scalar Date enum Status { OPEN DONE } input Filter { status: Status } \
            interface Node { id: ID! } \
            type User implements Node { id: ID! name: String joined: Date } \
            type Task implements Node { id: ID! status: Status } \
            union Result = User | Task \
            type Query { node: Node search(filter: Filter): [Result!] } \
            extend union Result = Query";
        let types = parse_schema_types(sdl).expect("schema parses");
        assert_eq!(types["Date"].kind, TypeKind::Scalar);
        assert_eq!(types["Status"].kind, TypeKind::Enum);
        assert_eq!(types["Filter"].kind, TypeKind::Input);
        assert_eq!(types["Node"].kind, TypeKind::Interface);
        assert!(types["Node"].fields.contains_key("id"));
        assert_eq!(types["User"].interfaces, vec!["Node".to_string()]);
        assert_eq!(types["Result"].kind, TypeKind::Union);
        assert_eq!(
            types["Result"].members,
            vec!["User".to_string(), "Task".to_string(), "Query".to_string()]
        );
        // What crosses to the engine is lower-case.
        let json = serde_json::to_value(&types["Result"]).expect("serializes");
        assert_eq!(json["kind"], "union");
    }

    #[test]
    fn an_unparseable_schema_is_an_error() {
        assert!(parse_schema_types("type Query {").is_err());
    }

    #[test]
    fn a_schema_naming_a_type_it_does_not_declare_is_an_error() {
        // The engine could not tell whether `owner` is an object to project
        // or a scalar to send whole.
        assert_eq!(
            parse_schema_types("type Query { owner: Usr }"),
            Err("Unknown type \"Usr\".".to_string())
        );
        assert!(parse_schema_types("type Query { a: Int } union U = Query | Missing").is_err());
        assert!(parse_schema_types("type Query implements Missing { a: Int }").is_err());
        // An input type is not something a field can return.
        assert!(parse_schema_types("input In { a: Int } type Query { a: In }").is_err());
        assert_eq!(
            parse_schema_types("type Query { a: Int } type Query { b: Int }"),
            Err("There can be only one type named \"Query\".".to_string())
        );
        assert!(parse_schema_types("type Query { a: Int } extend union Query = Query").is_err());
    }

    #[test]
    fn a_field_carries_the_type_condition_of_its_fragment() {
        let result = parse_graphql_query(
            "{ node { id ... on User { name ... on Node { id } } ...T ... { plain } } } \
             fragment T on Task { title owner { id } }",
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.type_names, vec!["User", "Node", "Task"]);
        assert_eq!(
            result.type_conditions,
            vec![
                TypeConditionLink {
                    name: 0,
                    parent: None
                },
                TypeConditionLink {
                    name: 1,
                    parent: Some(0)
                },
                TypeConditionLink {
                    name: 2,
                    parent: None
                },
            ]
        );
        let conditions: Vec<(&str, Option<usize>)> = result.fields[0]
            .sub_fields
            .iter()
            .map(|f| (f.name.as_str(), f.condition))
            .collect();
        assert_eq!(
            conditions,
            vec![
                ("id", None),
                ("name", Some(0)),
                ("id", Some(1)),
                ("title", Some(2)),
                ("owner", Some(2)),
                // `... { plain }` has no condition of its own.
                ("plain", None),
            ]
        );
        // A field's own selection starts again from the field's type.
        let owner = &result.fields[0].sub_fields[4];
        assert_eq!(owner.sub_fields[0].condition, None);
    }

    #[test]
    fn a_fragment_spread_many_times_stores_its_condition_once() {
        let spreads = "...F ".repeat(200);
        let result = parse_graphql_query(&format!(
            "{{ node {{ {spreads} }} }} fragment F on User {{ id }}"
        ));
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.fields[0].sub_fields.len(), 200);
        assert_eq!(result.type_names.len(), 1);
        assert_eq!(result.type_conditions.len(), 1);
    }

    /// `{ f(a: [$v0 $v1 … ]) }`: one field, `n` undeclared variables.
    fn undeclared_variables(n: usize) -> String {
        let names: Vec<String> = (0..n).map(|i| format!("$v{i}")).collect();
        format!("{{ f(a: [{}]) }}", names.join(" "))
    }

    #[test]
    fn validation_stops_at_the_error_limit() {
        let result = parse_graphql_query(&undeclared_variables(250));
        // The first 100, then the notice: nothing past it is looked at.
        assert_eq!(result.errors.len(), 101);
        assert_eq!(result.errors[0], "Variable \"$v0\" is not defined.");
        assert_eq!(result.errors[99], "Variable \"$v99\" is not defined.");
        assert_eq!(result.errors[100], TOO_MANY_ERRORS);
        assert!(result.fields.is_empty());

        let under = parse_graphql_query(&undeclared_variables(100));
        assert_eq!(under.errors.len(), 100);
        assert!(!under.errors.contains(&TOO_MANY_ERRORS.to_string()));
    }

    #[test]
    fn the_error_limit_is_a_parse_limit() {
        let limits = ParseLimits {
            max_errors: 3,
            ..ParseLimits::default()
        };
        let result = parse_graphql_operation(&undeclared_variables(10), None, limits);
        assert_eq!(result.errors.len(), 4);
        assert_eq!(result.errors[3], TOO_MANY_ERRORS);
    }

    #[test]
    fn the_error_limit_covers_every_kind_of_error() {
        let limits = ParseLimits {
            max_errors: 2,
            ..ParseLimits::default()
        };
        // Unknown fragments spread by the operation.
        let unknown = parse_graphql_operation("{ ...A ...B ...C ...D }", None, limits);
        assert_eq!(unknown.errors.len(), 3);
        assert_eq!(unknown.errors[2], TOO_MANY_ERRORS);
        // Unknown fragments spread by a fragment.
        let nested = parse_graphql_operation(
            "{ ...F } fragment F on Query { ...A ...B ...C ...D }",
            None,
            limits,
        );
        assert_eq!(
            nested.errors.last().map(String::as_str),
            Some(TOO_MANY_ERRORS)
        );
        // Duplicate fragment names.
        let duplicates = parse_graphql_operation(
            "{ a } fragment A on Q { a } fragment A on Q { a } fragment B on Q { a } \
             fragment B on Q { a } fragment C on Q { a } fragment C on Q { a }",
            None,
            limits,
        );
        assert_eq!(duplicates.errors.len(), 3);
        // Fragment cycles.
        let cycles = parse_graphql_operation(
            "{ a } fragment A on Q { ...A } fragment B on Q { ...B } fragment C on Q { ...C }",
            None,
            limits,
        );
        assert_eq!(cycles.errors.len(), 3);
        assert_eq!(cycles.errors[2], TOO_MANY_ERRORS);
        // Duplicate variables, and literals out of range.
        let variables = parse_graphql_operation(
            "query($a: Int $a: Int $b: Int $b: Int $c: Int $c: Int) { a }",
            None,
            limits,
        );
        assert_eq!(variables.errors.len(), 3);
        let literals = parse_graphql_operation("{ f(a: 1e400, b: 1e400, c: 1e400) }", None, limits);
        assert_eq!(literals.errors.len(), 3);
    }

    #[test]
    fn a_repeated_error_is_reported_once() {
        let result = parse_graphql_query("{ a(x: $v) b(x: $v) c(x: [$v $v]) ...M ...M }");
        assert_eq!(
            result.errors,
            vec![
                "Variable \"$v\" is not defined.".to_string(),
                "Unknown fragment \"M\".".to_string()
            ]
        );
    }
}
