use super::UserBindingTarget;
use super::UserBindingsError;
use super::compile_user_bindings;
use super::user_binding_diagnostics;
use crate::ContextExpression;
use crate::HostPlatform;
use serde_json::json;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    Copy,
}

fn compile(
    value: &serde_json::Value,
) -> Result<Vec<super::UserBinding<Command, ContextExpression>>, UserBindingsError> {
    compile_user_bindings(
        value,
        HostPlatform::Linux,
        |id| (id == "copy").then_some(Command::Copy),
        |source| {
            source
                .map(ContextExpression::parse)
                .transpose()
                .map(|condition| condition.unwrap_or_else(ContextExpression::always))
                .map_err(|error| error.to_string())
        },
    )
}

#[test]
fn compiles_commands_blockers_conditions_and_platform_overrides() {
    let rules = compile(&json!([
        {"key":"primary+c","linux":"ctrl+c","command":"copy","when":"inputFocus"},
        {"key":"ctrl+x","block":true}
    ]))
    .unwrap();

    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].target, UserBindingTarget::Command(Command::Copy));
    assert_eq!(rules[0].when_source.as_deref(), Some("inputFocus"));
    assert_eq!(rules[1].target, UserBindingTarget::Block);
}

#[test]
fn rejects_unknown_commands_without_partially_compiling_the_config() {
    let error = compile(&json!([{"key":"ctrl+x","command":"missing"}])).unwrap_err();

    assert_eq!(
        error,
        UserBindingsError::UnknownCommand {
            index: 1,
            command: "missing".into(),
        }
    );
}

#[test]
fn duplicate_diagnostics_preserve_later_rule_precedence() {
    let rules = compile(&json!([
        {"key":"ctrl+c","command":"copy"},
        {"key":"ctrl+c","block":true}
    ]))
    .unwrap();

    let diagnostics = user_binding_diagnostics(&rules, HostPlatform::Linux);
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].contains("later rule wins"));
}

#[test]
fn rejects_ambiguous_or_missing_targets_and_null_platform_overrides() {
    for value in [
        json!([{"key":"ctrl+x"}]),
        json!([{"key":"ctrl+x","command":"copy","block":true}]),
        json!([{"key":"ctrl+x","block":false}]),
        json!([{"key":"ctrl+x","command":"copy","mac":null}]),
    ] {
        assert!(compile(&value).is_err());
    }
}
