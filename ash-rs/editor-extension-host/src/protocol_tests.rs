use serde_json::json;

use super::ActivateParams;
use super::ActivateResult;
use super::ExtensionCapability;
use super::ExtensionHostRequest;
use super::ExtensionHostResponse;
use super::ExtensionHostStdoutFrame;
use super::HostEventContext;
use super::HostOutputOperation;
use super::HostRequestKind;
use super::HostResponseKind;
use super::HostSuccess;
use super::InvokeParams;
use super::PackageBinding;
use super::RegistrationDescriptor;
use super::RegistrationKind;
use super::RequestContext;
use crate::ExtensionHostLimits;

fn activation() -> ActivateParams {
    ActivateParams {
        extension_id: "acme.review".into(),
        package: PackageBinding {
            package_id: "acme/review@1.0.0".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "bin/review-host".into(),
        },
        runtime_api_version: 1,
        activation_events: vec!["onCommand:acme.review".into()],
        capabilities: vec![ExtensionCapability::Command],
    }
}

#[test]
fn channel_and_link_registrations_require_their_declared_capabilities() {
    let registrations = [
        (
            ExtensionCapability::DataChannel,
            RegistrationKind::DataChannel {
                channel_id: "editTelemetry".into(),
            },
        ),
        (
            ExtensionCapability::LinkPresentationProvider,
            RegistrationKind::LinkPresentationProvider {
                uri_pattern: "^https://example.com/issues/".into(),
                presentation_kind: "issue".into(),
            },
        ),
    ];
    for (capability, kind) in registrations {
        let mut params = activation();
        params.capabilities = vec![capability];
        let mut request = ExtensionHostRequest {
            context: RequestContext::new(1, 2, 3),
            request: HostRequestKind::Activate(params),
        };
        let response = ExtensionHostResponse {
            context: request.context,
            response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
                registrations: vec![RegistrationDescriptor {
                    registration_id: "subscription".into(),
                    kind,
                }],
            })),
        };
        response
            .validate_for(&request, &ExtensionHostLimits::default())
            .unwrap();
        let decoded: ExtensionHostResponse =
            serde_json::from_value(serde_json::to_value(&response).unwrap()).unwrap();
        assert_eq!(decoded, response);
        let mut unknown = serde_json::to_value(&response).unwrap();
        unknown["body"]["body"]["registrations"][0]["ambientAuthority"] = json!(true);
        assert!(serde_json::from_value::<ExtensionHostResponse>(unknown).is_err());
        if let HostRequestKind::Activate(params) = &mut request.request {
            params.capabilities = vec![ExtensionCapability::Command];
        }
        assert!(
            response
                .validate_for(&request, &ExtensionHostLimits::default())
                .is_err()
        );
    }
}

#[test]
fn link_registration_rejects_unknown_kinds_and_oversized_patterns() {
    let mut params = activation();
    params.capabilities = vec![ExtensionCapability::LinkPresentationProvider];
    let request = ExtensionHostRequest {
        context: RequestContext::new(1, 2, 3),
        request: HostRequestKind::Activate(params),
    };
    for (uri_pattern, presentation_kind) in [
        ("^https://example.com/".into(), "unknown".into()),
        ("x".repeat(2049), "issue".into()),
    ] {
        let response = ExtensionHostResponse {
            context: request.context,
            response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
                registrations: vec![RegistrationDescriptor {
                    registration_id: "issues".into(),
                    kind: RegistrationKind::LinkPresentationProvider {
                        uri_pattern,
                        presentation_kind,
                    },
                }],
            })),
        };
        assert!(
            response
                .validate_for(&request, &ExtensionHostLimits::default())
                .is_err()
        );
    }
}

#[test]
fn request_round_trip_preserves_all_stale_response_fences() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(7, 3, 11),
        request: HostRequestKind::Invoke(InvokeParams {
            extension_id: "acme.review".into(),
            registration_id: "review.command".into(),
            operation: "execute".into(),
            payload: json!({"uri": "opaque-resource-1"}),
            deadline_unix_millis: 1000,
        }),
    };
    request.validate(&ExtensionHostLimits::default()).unwrap();
    let encoded = serde_json::to_string(&request).unwrap();
    let decoded: ExtensionHostRequest = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, request);
    assert!(encoded.contains("\"protocolVersion\":1"));
    assert!(encoded.contains("\"incarnation\":3"));
    assert!(encoded.contains("\"activationGeneration\":11"));
}

#[test]
fn stdout_frame_distinguishes_unsolicited_output_from_correlated_responses() {
    let frame: ExtensionHostStdoutFrame = serde_json::from_value(json!({
        "protocolVersion": 1,
        "incarnation": 3,
        "activationGeneration": 9,
        "operation": "clear",
        "channelId": "review"
    }))
    .unwrap();

    assert!(matches!(
        frame,
        ExtensionHostStdoutFrame::Output(super::ExtensionHostOutputEvent {
            context: HostEventContext {
                incarnation: 3,
                activation_generation: 9,
                ..
            },
            operation: HostOutputOperation::Clear { channel_id }
        }) if channel_id == "review"
    ));
}

#[test]
fn activation_rejects_raw_or_escaping_entrypoint_paths() {
    for entrypoint in ["../host", "C:/host.exe", "/tmp/host", "bin\\host"] {
        let mut params = activation();
        params.package.entrypoint = entrypoint.into();
        let request = ExtensionHostRequest {
            context: RequestContext::new(1, 1, 1),
            request: HostRequestKind::Activate(params),
        };
        assert!(request.validate(&ExtensionHostLimits::default()).is_err());
    }
}

#[test]
fn response_must_match_request_incarnation_and_generation() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(4, 8, 12),
        request: HostRequestKind::Activate(activation()),
    };
    let mut response = ExtensionHostResponse {
        context: request.context,
        response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
            registrations: vec![RegistrationDescriptor {
                registration_id: "review.command".into(),
                kind: RegistrationKind::Command {
                    command: "acme.review".into(),
                    title: "Review".into(),
                },
            }],
        })),
    };
    response
        .validate_for(&request, &ExtensionHostLimits::default())
        .unwrap();
    response.context.incarnation += 1;
    assert!(
        response
            .validate_for(&request, &ExtensionHostLimits::default())
            .is_err()
    );
}

#[test]
fn activation_registration_ids_are_unique_and_bounded() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(4, 8, 12),
        request: HostRequestKind::Activate(activation()),
    };
    let duplicate = RegistrationDescriptor {
        registration_id: "same".into(),
        kind: RegistrationKind::DebugAdapter {
            debugger_type: "ash".into(),
        },
    };
    let response = ExtensionHostResponse {
        context: request.context,
        response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
            registrations: vec![duplicate.clone(), duplicate],
        })),
    };
    assert!(
        response
            .validate_for(&request, &ExtensionHostLimits::default())
            .is_err()
    );
}

#[test]
fn activation_rejects_registration_outside_manifest_capability_ceiling() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(4, 8, 12),
        request: HostRequestKind::Activate(activation()),
    };
    let response = ExtensionHostResponse {
        context: request.context,
        response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
            registrations: vec![RegistrationDescriptor {
                registration_id: "review.debug".into(),
                kind: RegistrationKind::DebugAdapter {
                    debugger_type: "acme-review".into(),
                },
            }],
        })),
    };
    assert!(
        response
            .validate_for(&request, &ExtensionHostLimits::default())
            .is_err()
    );
}

#[test]
fn registration_fields_are_bounded_and_provider_sets_are_unique() {
    let mut params = activation();
    params.capabilities = vec![ExtensionCapability::LanguageProvider];
    let request = ExtensionHostRequest {
        context: RequestContext::new(4, 8, 12),
        request: HostRequestKind::Activate(params),
    };
    let response = ExtensionHostResponse {
        context: request.context,
        response: HostResponseKind::Success(HostSuccess::Activated(ActivateResult {
            registrations: vec![RegistrationDescriptor {
                registration_id: "review.language".into(),
                kind: RegistrationKind::LanguageProvider {
                    language_ids: vec!["rust".into(), "rust".into()],
                    operations: vec![
                        super::LanguageProviderOperation::Hover,
                        super::LanguageProviderOperation::Hover,
                    ],
                },
            }],
        })),
    };
    assert!(
        response
            .validate_for(&request, &ExtensionHostLimits::default())
            .is_err()
    );
}

#[test]
fn invoke_response_payload_obeys_the_narrow_payload_quota() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(7, 3, 11),
        request: HostRequestKind::Invoke(InvokeParams {
            extension_id: "acme.review".into(),
            registration_id: "review.command".into(),
            operation: "execute".into(),
            payload: json!({}),
            deadline_unix_millis: 1000,
        }),
    };
    let response = ExtensionHostResponse {
        context: request.context,
        response: HostResponseKind::Success(HostSuccess::Invoked(super::InvokeResult {
            payload: json!({"value": "x".repeat(128)}),
        })),
    };
    let limits = ExtensionHostLimits {
        maximum_payload_bytes: 32,
        ..ExtensionHostLimits::default()
    };
    assert!(response.validate_for(&request, &limits).is_err());
}

#[test]
fn registration_variant_fields_serialize_in_camel_case() {
    let registration = RegistrationDescriptor {
        registration_id: "review.language".into(),
        kind: RegistrationKind::LanguageProvider {
            language_ids: vec!["rust".into()],
            operations: vec![
                super::LanguageProviderOperation::ParameterHints,
                super::LanguageProviderOperation::InlayHints,
            ],
        },
    };

    let encoded = serde_json::to_value(registration).unwrap();

    assert_eq!(encoded["kind"], "languageProvider");
    assert_eq!(encoded["languageIds"], json!(["rust"]));
    assert_eq!(encoded["operations"][0], "parameterHints");
    assert!(encoded.get("language_ids").is_none());
}

#[test]
fn test_profile_provider_uses_the_provider_domain_vocabulary() {
    let registration = RegistrationDescriptor {
        registration_id: "review.tests".into(),
        kind: RegistrationKind::TestProfileProvider {
            provider_id: "acme.review".into(),
            label: "Acme Review".into(),
        },
    };

    assert_eq!(
        serde_json::to_value(registration).unwrap(),
        json!({
            "registrationId": "review.tests",
            "kind": "testProfileProvider",
            "providerId": "acme.review",
            "label": "Acme Review"
        })
    );
}
