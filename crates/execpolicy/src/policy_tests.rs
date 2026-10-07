use super::*;
use crate::ExecPolicyActionKind;
use crate::ExecPolicyAmendment;
use crate::ExecPolicyCapability;
use crate::ExecPolicyCommand;
use crate::ExecPolicyDefault;
use crate::ExecPolicyEffect;
use crate::ExecPolicyLayer;
use crate::ExecPolicyLayerId;
use crate::ExecPolicyLayerKind;
use crate::ExecPolicyNetworkTarget;
use crate::ExecPolicyRule;
use crate::ExecPolicyRuleId;
use crate::ExecPolicySelector;
use crate::ExecPolicySubject;
use crate::ExecPolicyToken;
use crate::HostMatcher;
use crate::ScopeMatcher;

fn subject<'a>(
    command: Option<&'a ExecPolicyCommand>,
    network: Option<&'a ExecPolicyNetworkTarget>,
) -> ExecPolicySubject<'a> {
    ExecPolicySubject::new(
        "digest-1",
        ExecPolicyActionKind::LocalProcess,
        "built_in_tool",
        "shell-command",
        [
            ExecPolicyCapability::new("network", "api.example.com:443"),
            ExecPolicyCapability::new("file_read", "/dir"),
        ],
        command,
        network,
    )
}

fn layer(kind: ExecPolicyLayerKind, rules: Vec<ExecPolicyRule>) -> ExecPolicyLayer {
    ExecPolicyLayer::new(ExecPolicyLayerId::new(format!("{kind:?}")), kind, rules)
}

#[test]
fn exact_command_network_and_capability_selectors_are_evaluated() {
    let command =
        ExecPolicyCommand::new("gh", ["pr".to_owned(), "view".to_owned(), "42".to_owned()]);
    let network = ExecPolicyNetworkTarget::new("https", "api.example.com", Some(443));
    let rules = vec![
        ExecPolicyRule::new(
            ExecPolicyRuleId::new("command"),
            ExecPolicySelector::command_prefix([
                ExecPolicyToken::literal("gh"),
                ExecPolicyToken::one_of(["pr".to_owned(), "issue".to_owned()]),
                ExecPolicyToken::literal("view"),
            ]),
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        ExecPolicyRule::new(
            ExecPolicyRuleId::new("network"),
            ExecPolicySelector::Network {
                protocol: Some("https".into()),
                host: HostMatcher::domain_suffix("example.com"),
                port: Some(443),
            },
            ExecPolicyEffect::RequireApproval,
        ),
        ExecPolicyRule::new(
            ExecPolicyRuleId::new("capability"),
            ExecPolicySelector::Capability {
                capability_kind: "file_read".into(),
                scope: ScopeMatcher::prefix("/dir"),
            },
            ExecPolicyEffect::Continue,
        ),
    ];
    let snapshot = ExecPolicySnapshot::new(
        ExecPolicyDefault::Continue,
        vec![layer(ExecPolicyLayerKind::User, rules)],
    )
    .unwrap();

    let evaluation = snapshot.evaluate(&subject(Some(&command), Some(&network)));

    assert_eq!(evaluation.effect(), &ExecPolicyEffect::RequireApproval);
    assert_eq!(evaluation.matched_rules().len(), 3);
    assert_eq!(
        evaluation.source().unwrap().rule_id(),
        &ExecPolicyRuleId::new("network")
    );
}

#[test]
fn restrictive_parent_layer_cannot_be_overridden_by_user_allow() {
    let host_deny = ExecPolicyRule::new(
        ExecPolicyRuleId::new("host-deny"),
        ExecPolicySelector::Any,
        ExecPolicyEffect::Deny("host policy denies this action".into()),
    );
    let user_allow = ExecPolicyRule::new(
        ExecPolicyRuleId::new("user-allow"),
        ExecPolicySelector::Any,
        ExecPolicyEffect::AllowUnsandboxed,
    );
    let snapshot = ExecPolicySnapshot::new(
        ExecPolicyDefault::Continue,
        vec![
            layer(ExecPolicyLayerKind::User, vec![user_allow]),
            layer(ExecPolicyLayerKind::Host, vec![host_deny]),
        ],
    )
    .unwrap();

    assert_eq!(
        snapshot.evaluate(&subject(None, None)).effect(),
        &ExecPolicyEffect::Deny("host policy denies this action".into())
    );
}

#[test]
fn revision_is_semantic_and_independent_of_input_layer_order() {
    let host = layer(ExecPolicyLayerKind::Host, Vec::new());
    let user = layer(ExecPolicyLayerKind::User, Vec::new());
    let first = ExecPolicySnapshot::new(
        ExecPolicyDefault::Continue,
        vec![host.clone(), user.clone()],
    )
    .unwrap();
    let second = ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![user, host]).unwrap();

    assert_eq!(first.revision(), second.revision());
}

#[test]
fn revision_canonicalizes_deserialized_network_names() {
    let deserialized_selector: ExecPolicySelector = serde_json::from_value(serde_json::json!({
        "kind": "network",
        "protocol": "HTTPS",
        "host": {
            "kind": "domain_suffix",
            "value": "Example.COM."
        },
        "port": 443
    }))
    .unwrap();
    let canonical_selector = ExecPolicySelector::Network {
        protocol: Some("https".into()),
        host: HostMatcher::domain_suffix("example.com"),
        port: Some(443),
    };
    let make_snapshot = |selector| {
        ExecPolicySnapshot::new(
            ExecPolicyDefault::Continue,
            vec![layer(
                ExecPolicyLayerKind::User,
                vec![ExecPolicyRule::new(
                    ExecPolicyRuleId::new("network"),
                    selector,
                    ExecPolicyEffect::RequireApproval,
                )],
            )],
        )
        .unwrap()
    };

    let deserialized = make_snapshot(deserialized_selector);
    let canonical = make_snapshot(canonical_selector);

    assert_eq!(deserialized.revision(), canonical.revision());
    assert_eq!(deserialized.layers(), canonical.layers());
}

#[test]
fn rule_ids_are_unique_within_a_layer_but_may_repeat_across_layers() {
    let host = layer(
        ExecPolicyLayerKind::Host,
        vec![ExecPolicyRule::new(
            ExecPolicyRuleId::new("shared-name"),
            ExecPolicySelector::Any,
            ExecPolicyEffect::Continue,
        )],
    );
    let user = layer(
        ExecPolicyLayerKind::User,
        vec![ExecPolicyRule::new(
            ExecPolicyRuleId::new("shared-name"),
            ExecPolicySelector::Any,
            ExecPolicyEffect::RequireApproval,
        )],
    );
    assert!(ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![host, user]).is_ok());

    let duplicate = layer(
        ExecPolicyLayerKind::User,
        vec![
            ExecPolicyRule::new(
                ExecPolicyRuleId::new("duplicate"),
                ExecPolicySelector::Any,
                ExecPolicyEffect::Continue,
            ),
            ExecPolicyRule::new(
                ExecPolicyRuleId::new("duplicate"),
                ExecPolicySelector::Any,
                ExecPolicyEffect::RequireApproval,
            ),
        ],
    );
    assert!(matches!(
        ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![duplicate]),
        Err(ExecPolicyError::DuplicateRuleId(_))
    ));
}

#[test]
fn amendment_is_revision_bound_and_user_layer_only() {
    let snapshot = ExecPolicySnapshot::new(
        ExecPolicyDefault::Continue,
        vec![layer(ExecPolicyLayerKind::User, Vec::new())],
    )
    .unwrap();
    let amendment = ExecPolicyAmendment::upsert_user_rule(
        snapshot.revision().clone(),
        ExecPolicyLayerId::new("User"),
        ExecPolicyRule::new(
            ExecPolicyRuleId::new("allow-gh"),
            ExecPolicySelector::command_prefix([ExecPolicyToken::literal("gh")]),
            ExecPolicyEffect::AllowUnsandboxed,
        ),
    );

    let amended = amendment.apply(&snapshot).unwrap();

    assert_ne!(amended.revision(), snapshot.revision());
    assert_eq!(amended.layers()[0].rules().len(), 1);

    let removed = ExecPolicyAmendment::remove_user_rule(
        amended.revision().clone(),
        ExecPolicyLayerId::new("User"),
        ExecPolicyRuleId::new("allow-gh"),
    )
    .apply(&amended)
    .unwrap();
    assert!(removed.layers()[0].rules().is_empty());
}

#[test]
fn dir_layer_cannot_grant_unsandboxed_execution() {
    let rule = ExecPolicyRule::new(
        ExecPolicyRuleId::new("dir-allow"),
        ExecPolicySelector::Any,
        ExecPolicyEffect::AllowUnsandboxed,
    );

    assert!(matches!(
        ExecPolicySnapshot::new(
            ExecPolicyDefault::Continue,
            vec![layer(ExecPolicyLayerKind::Directory, vec![rule])],
        ),
        Err(ExecPolicyError::DirectoryRuleMayNotAllow(_))
    ));
}
