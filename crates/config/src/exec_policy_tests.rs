use super::*;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySelector;

#[test]
fn directory_policy_can_restrict_but_cannot_grant() {
    let dir_id: DirId = format!("sha256:{}", "cd".repeat(32)).parse().unwrap();
    let restrictive = DirExecPolicyConfig {
        rules: vec![ExecPolicyRule::new(
            ExecPolicyRuleId::new("deny"),
            ExecPolicySelector::Any,
            ExecPolicyEffect::Deny("repository policy".into()),
        )],
    };
    assert!(
        compose_exec_policy(
            ExecPolicyDefault::Continue,
            Vec::new(),
            &UserExecPolicyConfig::default(),
            Some((&dir_id, &restrictive)),
        )
        .is_ok()
    );

    let granting = DirExecPolicyConfig {
        rules: vec![ExecPolicyRule::new(
            ExecPolicyRuleId::new("allow"),
            ExecPolicySelector::Any,
            ExecPolicyEffect::AllowUnsandboxed,
        )],
    };
    assert!(
        compose_exec_policy(
            ExecPolicyDefault::Continue,
            Vec::new(),
            &UserExecPolicyConfig::default(),
            Some((&dir_id, &granting)),
        )
        .is_err()
    );
}

#[test]
fn typed_user_mutations_round_trip_exec_policy_rules() {
    let mut document = crate::UserConfigDocument::default();
    let rule = ExecPolicyRule::new(
        ExecPolicyRuleId::new("safe-status"),
        ExecPolicySelector::command_prefix([
            ash_execpolicy::ExecPolicyToken::literal("git"),
            ash_execpolicy::ExecPolicyToken::literal("status"),
        ]),
        ExecPolicyEffect::AllowUnsandboxed,
    );
    crate::mutation::apply_command(
        &mut document,
        &crate::UserConfigCommand::UpsertExecPolicyRule { rule: rule.clone() },
    )
    .unwrap();
    document.validate().unwrap();

    let encoded = toml::to_string_pretty(&document).unwrap();
    let decoded: crate::UserConfigDocument = toml::from_str(&encoded).unwrap();
    assert_eq!(decoded.exec_policy.rules, vec![rule]);

    crate::mutation::apply_command(
        &mut document,
        &crate::UserConfigCommand::RemoveExecPolicyRule {
            rule_id: ExecPolicyRuleId::new("safe-status"),
        },
    )
    .unwrap();
    assert!(document.exec_policy.rules.is_empty());
}
