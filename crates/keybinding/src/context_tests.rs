use super::ContextExpression;
use super::ContextValue;

#[test]
fn evaluates_boolean_precedence_parentheses_and_negation() {
    let expression =
        ContextExpression::parse("textInputFocus && (!terminalFocus || sessionSidebarVisible)")
            .expect("context expression");

    assert!(expression.evaluate(|key| match key {
        "textInputFocus" => Some(ContextValue::Boolean(true)),
        "terminalFocus" => Some(ContextValue::Boolean(false)),
        "sessionSidebarVisible" => Some(ContextValue::Boolean(false)),
        _ => None,
    }));
    assert!(!expression.evaluate(|key| match key {
        "textInputFocus" => Some(ContextValue::Boolean(true)),
        "terminalFocus" => Some(ContextValue::Boolean(true)),
        "sessionSidebarVisible" => Some(ContextValue::Boolean(false)),
        _ => None,
    }));
}

#[test]
fn evaluates_string_and_boolean_comparisons() {
    let expression =
        ContextExpression::parse("composerMode == 'agent' && agentSidebarVisible != true")
            .expect("context expression");

    assert!(expression.evaluate(|key| match key {
        "composerMode" => Some(ContextValue::String("agent".into())),
        "agentSidebarVisible" => Some(ContextValue::Boolean(false)),
        _ => None,
    }));
}

#[test]
fn reports_referenced_keys_and_rejects_invalid_syntax() {
    let expression = ContextExpression::parse("b || a && b").expect("context expression");
    assert_eq!(expression.referenced_keys(), vec!["a", "b"]);
    assert!(ContextExpression::parse("a &&").is_err());
    assert!(ContextExpression::parse("(a || b").is_err());
    assert!(ContextExpression::parse("a = b").is_err());
}
