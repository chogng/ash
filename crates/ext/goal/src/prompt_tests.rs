use super::*;

#[test]
fn rejects_an_empty_goal_objective() {
    assert_eq!(
        render_goal_instructions("  ", None, 0),
        Err(GoalPromptError::EmptyObjective)
    );
}

#[test]
fn renders_and_escapes_a_limited_goal() {
    let prompt = render_goal_instructions("Update <crate> & verify {{ budget }}", Some(100), 65)
        .expect("non-empty objective should render");

    assert!(
        prompt
            .body()
            .contains("Update &lt;crate&gt; &amp; verify {{ budget }}")
    );
    assert!(prompt.body().contains("token budget: 100"));
    assert!(prompt.body().contains("tokens used: 65"));
    assert!(prompt.body().contains("tokens remaining: 35"));
    assert_eq!(prompt.source(), GOAL_INSTRUCTIONS);
}

#[test]
fn renders_an_unbounded_goal() {
    assert!(
        render_goal_instructions("Finish the migration", None, 0)
            .expect("non-empty objective should render")
            .body()
            .contains("mode: unbounded")
    );
}
