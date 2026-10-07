use super::CreateGoalArguments;
use super::create_definition;
use super::decode;
use serde_json::json;

#[test]
fn create_goal_requires_a_nullable_budget_in_its_strict_schema() {
    let definition = create_definition();
    assert!(definition.strict);
    assert_eq!(
        definition.parameters["required"],
        json!(["objective", "token_budget"])
    );
    assert_eq!(
        definition.parameters["properties"]["token_budget"]["type"],
        json!(["integer", "null"])
    );
}

#[test]
fn create_goal_accepts_null_for_an_unbounded_budget() {
    for budget in [None, Some(100)] {
        let arguments: CreateGoalArguments = decode(&json!({
            "objective": "Finish the task",
            "token_budget": budget
        }))
        .unwrap();
        assert_eq!(arguments.objective, "Finish the task");
        assert_eq!(arguments.token_budget, budget);
    }
}
