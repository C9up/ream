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
    parse_query, Definition, Document, OperationDefinition, Selection, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

    for def in &doc.definitions {
        match def {
            Definition::Operation(op) => {
                match op {
                    OperationDefinition::Query(q) => {
                        result.operation_type = "query".to_string();
                        result.operation_name = q.name.clone();
                        result.fields = extract_fields(&q.selection_set.items);
                    }
                    OperationDefinition::Mutation(m) => {
                        result.operation_type = "mutation".to_string();
                        result.operation_name = m.name.clone();
                        result.fields = extract_fields(&m.selection_set.items);
                    }
                    OperationDefinition::Subscription(s) => {
                        result.operation_type = "subscription".to_string();
                        result.operation_name = s.name.clone();
                        result.fields = extract_fields(&s.selection_set.items);
                    }
                    OperationDefinition::SelectionSet(ss) => {
                        result.operation_type = "query".to_string();
                        result.fields = extract_fields(&ss.items);
                    }
                }
            }
            Definition::Fragment(_) => {
                // Fragment definitions — not resolved here (future enhancement)
            }
        }
    }

    result
}

/// Extract fields from a selection set.
fn extract_fields(selections: &[Selection<String>]) -> Vec<ParsedField> {
    let mut fields = Vec::new();

    for sel in selections {
        match sel {
            Selection::Field(f) => {
                let args = f.arguments.iter().map(|(name, value)| {
                    (name.clone(), graphql_value_to_json(value))
                }).collect();

                let sub_fields = extract_fields(&f.selection_set.items);

                fields.push(ParsedField {
                    name: f.name.clone(),
                    alias: f.alias.clone(),
                    args,
                    sub_fields,
                });
            }
            Selection::FragmentSpread(_) | Selection::InlineFragment(_) => {
                // Fragment handling — future enhancement
            }
        }
    }

    fields
}

/// Convert a GraphQL Value to serde_json::Value.
fn graphql_value_to_json(value: &Value<String>) -> serde_json::Value {
    match value {
        Value::String(s) => serde_json::Value::String(s.clone()),
        Value::Int(n) => serde_json::Value::Number(
            serde_json::Number::from(n.as_i64().unwrap_or(0)),
        ),
        Value::Float(f) => {
            serde_json::Number::from_f64(*f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        }
        Value::Boolean(b) => serde_json::Value::Bool(*b),
        Value::Null => serde_json::Value::Null,
        Value::Enum(e) => serde_json::Value::String(e.clone()),
        Value::List(items) => {
            serde_json::Value::Array(items.iter().map(graphql_value_to_json).collect())
        }
        Value::Object(obj) => {
            let map: serde_json::Map<String, serde_json::Value> = obj
                .iter()
                .map(|(k, v)| (k.clone(), graphql_value_to_json(v)))
                .collect();
            serde_json::Value::Object(map)
        }
        Value::Variable(name) => {
            // Variable references: store as "$varName" for TS-side resolution
            serde_json::Value::String(format!("${}", name))
        }
    }
}

/// Validate that a query only references known operation types.
/// Schema validation is a future enhancement.
pub fn validate_query(query: &str) -> Vec<String> {
    let result = parse_graphql_query(query);
    result.errors
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
        let result = parse_graphql_query(r#"
            mutation {
                createTask(title: "Fix bug", urgency: "high") {
                    id
                    title
                }
            }
        "#);
        assert_eq!(result.operation_type, "mutation");
        assert_eq!(result.fields[0].name, "createTask");
        assert_eq!(result.fields[0].args.get("title").unwrap(), "Fix bug");
        assert_eq!(result.fields[0].args.get("urgency").unwrap(), "high");
    }

    #[test]
    fn test_parse_query_with_variables() {
        let result = parse_graphql_query(r#"
            query GetTask($id: ID!) {
                task(id: $id) {
                    id
                    title
                    status
                }
            }
        "#);
        assert_eq!(result.operation_type, "query");
        assert_eq!(result.operation_name, Some("GetTask".to_string()));
        assert_eq!(result.fields[0].name, "task");
        assert_eq!(result.fields[0].args.get("id").unwrap(), "$id");
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
        assert_eq!(result.fields[0].sub_fields[0].sub_fields[0].name, "comments");
        assert_eq!(result.fields[0].sub_fields[0].sub_fields[0].sub_fields[0].name, "text");
    }

    #[test]
    fn test_parse_aliased_field() {
        let result = parse_graphql_query("{ myTasks: tasks { id } }");
        assert_eq!(result.fields[0].name, "tasks");
        assert_eq!(result.fields[0].alias, Some("myTasks".to_string()));
    }
}
