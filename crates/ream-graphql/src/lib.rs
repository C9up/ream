//! # ream-graphql
//!
//! GraphQL query parser and validator for the Ream framework.
//! Uses `graphql-parser` crate for spec-compliant parsing.
//!
//! Queries are parsed and validated in Rust before crossing the NAPI boundary.
//! Invalid queries never reach the TypeScript resolver layer.
//!
//! @implements MISS-28

use graphql_parser::query::{
    parse_query, Definition, Document, FragmentDefinition, OperationDefinition, Selection, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Parsed field from a GraphQL query.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedField {
    pub name: String,
    pub alias: Option<String>,
    pub args: HashMap<String, serde_json::Value>,
    pub sub_fields: Vec<ParsedField>,
}

/// Result of parsing a GraphQL query.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParseResult {
    pub operation_type: String, // "query", "mutation", "subscription"
    pub operation_name: Option<String>,
    pub fields: Vec<ParsedField>,
    pub errors: Vec<String>,
}

/// Parse a GraphQL query string into a structured result.
///
/// Returns operation type, top-level fields with arguments, and any parse errors.
/// This runs in Rust — invalid queries are rejected before NAPI crossing.
pub fn parse_graphql_query(query: &str) -> ParseResult {
    let doc: Document<String> = match parse_query::<String>(query) {
        Ok(doc) => doc,
        Err(e) => {
            return ParseResult {
                operation_type: "query".to_string(),
                operation_name: None,
                fields: vec![],
                errors: vec![format!("Parse error: {}", e)],
            };
        }
    };

    let mut result = ParseResult {
        operation_type: "query".to_string(),
        operation_name: None,
        fields: vec![],
        errors: vec![],
    };

    // Collect named fragment definitions first so spreads can be expanded inline
    // wherever they appear in the operation's selection set.
    let mut fragments: HashMap<String, &FragmentDefinition<String>> = HashMap::new();
    for def in &doc.definitions {
        if let Definition::Fragment(frag) = def {
            fragments.insert(frag.name.clone(), frag);
        }
    }

    for def in &doc.definitions {
        match def {
            Definition::Operation(op) => {
                let mut visiting: HashSet<String> = HashSet::new();
                match op {
                    OperationDefinition::Query(q) => {
                        result.operation_type = "query".to_string();
                        result.operation_name = q.name.clone();
                        result.fields = extract_fields(
                            &q.selection_set.items,
                            &fragments,
                            &mut visiting,
                            &mut result.errors,
                        );
                    }
                    OperationDefinition::Mutation(m) => {
                        result.operation_type = "mutation".to_string();
                        result.operation_name = m.name.clone();
                        result.fields = extract_fields(
                            &m.selection_set.items,
                            &fragments,
                            &mut visiting,
                            &mut result.errors,
                        );
                    }
                    OperationDefinition::Subscription(s) => {
                        result.operation_type = "subscription".to_string();
                        result.operation_name = s.name.clone();
                        result.fields = extract_fields(
                            &s.selection_set.items,
                            &fragments,
                            &mut visiting,
                            &mut result.errors,
                        );
                    }
                    OperationDefinition::SelectionSet(ss) => {
                        result.operation_type = "query".to_string();
                        result.fields = extract_fields(
                            &ss.items,
                            &fragments,
                            &mut visiting,
                            &mut result.errors,
                        );
                    }
                }
            }
            Definition::Fragment(_) => {
                // Collected above; nothing to emit at the top level.
            }
        }
    }

    result
}

/// Extract fields from a selection set, expanding fragment spreads and inline
/// fragments inline. `visiting` tracks the named fragments currently being
/// expanded so a cyclic fragment (`fragment A on T { ...A }`) is skipped instead
/// of recursing forever.
fn extract_fields(
    selections: &[Selection<String>],
    fragments: &HashMap<String, &FragmentDefinition<String>>,
    visiting: &mut HashSet<String>,
    errors: &mut Vec<String>,
) -> Vec<ParsedField> {
    let mut fields = Vec::new();

    for sel in selections {
        match sel {
            Selection::Field(f) => {
                let args = f
                    .arguments
                    .iter()
                    .map(|(name, value)| {
                        let json = graphql_value_to_json(value).unwrap_or_else(|error| {
                            errors.push(format!("Argument \"{name}\" of \"{}\": {error}", f.name));
                            serde_json::Value::Null
                        });
                        (name.clone(), json)
                    })
                    .collect();

                let sub_fields =
                    extract_fields(&f.selection_set.items, fragments, visiting, errors);

                fields.push(ParsedField {
                    name: f.name.clone(),
                    alias: f.alias.clone(),
                    args,
                    sub_fields,
                });
            }
            Selection::FragmentSpread(spread) => {
                let name = &spread.fragment_name;
                // Cycle guard: skip a fragment already being expanded on this path.
                if visiting.contains(name) {
                    continue;
                }
                if let Some(frag) = fragments.get(name) {
                    visiting.insert(name.clone());
                    let mut expanded =
                        extract_fields(&frag.selection_set.items, fragments, visiting, errors);
                    visiting.remove(name);
                    fields.append(&mut expanded);
                }
                // Unknown fragment name → nothing to expand (spec would error;
                // here it simply contributes no fields).
            }
            Selection::InlineFragment(inline) => {
                // Inline fragments (`... on Type { ... }` / `... { ... }`) have no
                // name to cycle on; expand their selection set in place.
                let mut expanded =
                    extract_fields(&inline.selection_set.items, fragments, visiting, errors);
                fields.append(&mut expanded);
            }
        }
    }

    fields
}

/// The largest integer a JavaScript number holds exactly (2^53 - 1).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Convert a GraphQL Value to serde_json::Value, refusing a literal the
/// resolver would receive as a different value: an integer past what a
/// JavaScript number holds exactly, or a float that is not finite. Both used
/// to be substituted (rounded, or turned into null) without a word.
fn graphql_value_to_json(value: &Value<String>) -> Result<serde_json::Value, String> {
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
                .map(graphql_value_to_json)
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(obj) => serde_json::Value::Object(
            obj.iter()
                .map(|(k, v)| graphql_value_to_json(v).map(|json| (k.clone(), json)))
                .collect::<Result<_, _>>()?,
        ),
        Value::Variable(name) => {
            // Variable references: store as "$varName" for TS-side resolution
            serde_json::Value::String(format!("${}", name))
        }
    })
}

/// Validate that a query only references known operation types.
/// Schema validation is a future enhancement.
pub fn validate_query(query: &str) -> Vec<String> {
    let result = parse_graphql_query(query);
    result.errors
}

/// Extract the declared argument scalar types from a GraphQL SDL schema.
///
/// Returns `{ "Type.field": { "argName": "ScalarTypeName" } }` so the TypeScript
/// engine can coerce incoming argument values to their schema-declared types
/// (e.g. a string literal `"5"` for an `Int` arg → number). List/non-null
/// wrappers are unwrapped to the underlying named type; coercion is applied
/// element-wise when the value is an array.
pub fn parse_schema_arg_types(sdl: &str) -> HashMap<String, HashMap<String, String>> {
    use graphql_parser::schema::{
        parse_schema, Definition as SchemaDef, Type as SchemaType, TypeDefinition,
    };

    fn named_type(t: &SchemaType<String>) -> String {
        match t {
            SchemaType::NamedType(name) => name.clone(),
            SchemaType::ListType(inner) => named_type(inner),
            SchemaType::NonNullType(inner) => named_type(inner),
        }
    }

    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    let doc = match parse_schema::<String>(sdl) {
        Ok(d) => d,
        Err(_) => return out,
    };
    for def in &doc.definitions {
        if let SchemaDef::TypeDefinition(TypeDefinition::Object(obj)) = def {
            for field in &obj.fields {
                if field.arguments.is_empty() {
                    continue;
                }
                let mut args = HashMap::new();
                for arg in &field.arguments {
                    args.insert(arg.name.clone(), named_type(&arg.value_type));
                }
                out.insert(format!("{}.{}", obj.name, field.name), args);
            }
        }
    }
    out
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
            query GetTask($id: ID!) {
                task(id: $id) {
                    id
                    title
                    status
                }
            }
        "#,
        );
        assert_eq!(result.operation_type, "query");
        assert_eq!(result.operation_name, Some("GetTask".to_string()));
        assert_eq!(result.fields[0].name, "task");
        assert_eq!(result.fields[0].args.get("id").unwrap(), "$id");
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
    fn test_cyclic_fragment_does_not_loop() {
        // A self-referential fragment must not recurse forever; the cycle guard
        // skips the re-entry and the parse simply terminates.
        let result = parse_graphql_query("query { task { ...A } } fragment A on Task { id ...A }");
        assert!(result.errors.is_empty());
        let names: Vec<&str> = result.fields[0]
            .sub_fields
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        assert_eq!(names, vec!["id"]);
    }

    #[test]
    fn test_unknown_fragment_contributes_nothing() {
        let result = parse_graphql_query("query { task { id ...Missing } }");
        let names: Vec<&str> = result.fields[0]
            .sub_fields
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        assert_eq!(names, vec!["id"]);
    }

    #[test]
    fn test_schema_arg_types_are_extracted() {
        let sdl = "type Query { task(id: Int!, tag: String): Task count(ids: [ID!]): Int } type Task { id: Int }";
        let types = parse_schema_arg_types(sdl);
        let task = types.get("Query.task").expect("Query.task args");
        assert_eq!(task.get("id").map(String::as_str), Some("Int"));
        assert_eq!(task.get("tag").map(String::as_str), Some("String"));
        // List + NonNull are unwrapped to the underlying named type.
        let count = types.get("Query.count").expect("Query.count args");
        assert_eq!(count.get("ids").map(String::as_str), Some("ID"));
        // Fields with no arguments are omitted.
        assert!(!types.contains_key("Task.id"));
    }
}
