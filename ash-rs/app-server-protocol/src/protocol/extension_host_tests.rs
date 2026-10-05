use super::ExtensionHostCancellationReasonDto;
use super::ExtensionHostFailureCodeDto;
use super::ExtensionHostInvokeReadResult;
use super::ExtensionHostInvokeStartParams;
use super::ExtensionHostLanguageProviderOperationDto;
use super::ExtensionHostRegistrationDescriptorDto;
use super::ExtensionHostRegistrationKindDto;
use serde_json::json;

#[test]
fn invoke_start_round_trips_all_stale_snapshot_fences() {
    let fixture = json!({
        "extensionId": "acme/review:runtime",
        "registrationId": "review-hover",
        "activationGeneration": 7,
        "incarnation": 3,
        "operation": "hover",
        "payload": {"document": "file:///workspace/main.rs", "offset": 12},
        "deadlineUnixMillis": 1_800_000_000_000_u64
    });

    let params: ExtensionHostInvokeStartParams = serde_json::from_value(fixture.clone()).unwrap();

    assert_eq!(params.activation_generation, 7);
    assert_eq!(params.incarnation, 3);
    assert_eq!(serde_json::to_value(params).unwrap(), fixture);
}

#[test]
fn invoke_start_rejects_unknown_fields() {
    let fixture = json!({
        "extensionId": "acme/review:runtime",
        "registrationId": "review-hover",
        "activationGeneration": 7,
        "incarnation": 3,
        "operation": "hover",
        "payload": null,
        "deadlineUnixMillis": 1_800_000_000_000_u64,
        "ambientAuthority": true
    });

    assert!(serde_json::from_value::<ExtensionHostInvokeStartParams>(fixture).is_err());
}

#[test]
fn registration_descriptor_matches_host_rpc_v1_shape() {
    let descriptor = ExtensionHostRegistrationDescriptorDto {
        registration_id: "rust-language".into(),
        kind: ExtensionHostRegistrationKindDto::LanguageProvider {
            language_ids: vec!["rust".into()],
            operations: vec![
                ExtensionHostLanguageProviderOperationDto::ParameterHints,
                ExtensionHostLanguageProviderOperationDto::Hover,
                ExtensionHostLanguageProviderOperationDto::InlayHints,
            ],
        },
    };

    assert_eq!(
        serde_json::to_value(descriptor).unwrap(),
        json!({
            "registrationId": "rust-language",
            "kind": "languageProvider",
            "languageIds": ["rust"],
            "operations": ["parameterHints", "hover", "inlayHints"]
        })
    );
}

#[test]
fn channel_and_link_registration_wire_shapes_round_trip_and_reject_extra_fields() {
    for mut fixture in [
        json!({"registrationId":"browser","kind":"externalUriOpener","schemes":["https"],"label":"Acme browser"}),
        json!({"registrationId":"edits","kind":"dataChannel","channelId":"editTelemetry"}),
        json!({"registrationId":"issues","kind":"linkPresentationProvider","uriPattern":"^https://example.com/","presentationKind":"issue"}),
    ] {
        let descriptor: ExtensionHostRegistrationDescriptorDto =
            serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(descriptor).unwrap(), fixture);
        fixture["ambientAuthority"] = json!(true);
        assert!(serde_json::from_value::<ExtensionHostRegistrationDescriptorDto>(fixture).is_err());
    }
}

#[test]
fn generated_typescript_uses_camel_case_registration_fields() {
    let typescript = crate::typescript_files()
        .into_iter()
        .map(|(_, contents)| contents)
        .collect::<String>();

    assert!(typescript.contains("languageIds: Array<string>"));
    assert!(typescript.contains("debuggerType: string"));
    assert!(typescript.contains("taskType: string"));
    assert!(typescript.contains("\"kind\": \"testProfileProvider\""));
    assert!(typescript.contains("providerId: string"));
    assert!(typescript.contains("channelId: string"));
    assert!(typescript.contains("uriPattern: string"));
    assert!(typescript.contains("presentationKind: string"));
    assert!(typescript.contains("\"kind\": \"externalUriOpener\""));
    assert!(!typescript.contains("\"kind\": \"testController\""));
    assert!(!typescript.contains("controllerId"));
    assert!(!typescript.contains("language_ids"));
    assert!(!typescript.contains("debugger_type"));
    assert!(!typescript.contains("task_type"));
    assert!(!typescript.contains("provider_id"));
}

#[test]
fn invoke_read_uses_disjoint_tagged_terminal_states() {
    let pending = ExtensionHostInvokeReadResult::Pending;
    let succeeded = ExtensionHostInvokeReadResult::Succeeded {
        payload: json!({"items": []}),
    };
    let failed = ExtensionHostInvokeReadResult::Failed {
        code: ExtensionHostFailureCodeDto::HostRestarted,
        message: "extension process restarted".into(),
    };
    let cancelled = ExtensionHostInvokeReadResult::Cancelled {
        reason: ExtensionHostCancellationReasonDto::AuthorityRevoked,
    };

    assert_eq!(
        serde_json::to_value(pending).unwrap(),
        json!({"state": "pending"})
    );
    assert_eq!(
        serde_json::to_value(succeeded).unwrap(),
        json!({"state": "succeeded", "payload": {"items": []}})
    );
    assert_eq!(
        serde_json::to_value(failed).unwrap(),
        json!({
            "state": "failed",
            "code": "hostRestarted",
            "message": "extension process restarted"
        })
    );
    assert_eq!(
        serde_json::to_value(cancelled).unwrap(),
        json!({"state": "cancelled", "reason": "authorityRevoked"})
    );
}
