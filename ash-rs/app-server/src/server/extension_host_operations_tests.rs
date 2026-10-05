use super::cancellation_reason;
use super::failure_code;
use super::output_event_dto;
use super::registration_dto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostCancellationReasonDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostFailureCodeDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostOutputOperationDto;
use ash_editor_extension_host::CancelReason;
use ash_editor_extension_host::ExtensionHostOutputEvent;
use ash_editor_extension_host::HostEventContext;
use ash_editor_extension_host::HostOutputOperation;
use ash_editor_extension_host::HostOutputSeverity;
use ash_editor_extension_host::RegistrationDescriptor;
use ash_editor_extension_host::RegistrationKind;
use ash_editor_extension_host::SequencedExtensionHostOutputEvent;

#[test]
fn channel_and_link_registrations_preserve_frontend_subscription_fields() {
    for (kind, expected) in [
        (
            RegistrationKind::ExternalUriOpener {
                schemes: vec![ash_editor_extension_host::ExternalUriScheme::Https],
                label: "Acme browser".into(),
            },
            serde_json::json!({"registrationId":"provider","kind":"externalUriOpener","schemes":["https"],"label":"Acme browser"}),
        ),
        (
            RegistrationKind::DataChannel {
                channel_id: "editTelemetry".into(),
            },
            serde_json::json!({"registrationId":"provider","kind":"dataChannel","channelId":"editTelemetry"}),
        ),
        (
            RegistrationKind::LinkPresentationProvider {
                uri_pattern: "^https://example.com/".into(),
                presentation_kind: "issue".into(),
            },
            serde_json::json!({"registrationId":"provider","kind":"linkPresentationProvider","uriPattern":"^https://example.com/","presentationKind":"issue"}),
        ),
    ] {
        let dto = registration_dto(RegistrationDescriptor {
            registration_id: "provider".into(),
            kind,
        });
        let value = serde_json::to_value(dto).unwrap();
        assert_eq!(value, expected);
        let _: ash_app_server_protocol::protocol::extension_host::ExtensionHostRegistrationDescriptorDto = serde_json::from_value(value).unwrap();
    }
}

#[test]
fn cancellation_reasons_are_projected_without_losing_authority_revocation() {
    assert_eq!(
        cancellation_reason(CancelReason::AuthorityRevoked),
        ExtensionHostCancellationReasonDto::AuthorityRevoked
    );
}

#[test]
fn outcome_indeterminate_has_a_distinct_protocol_failure() {
    assert_eq!(
        failure_code(super::ExtensionHostFailureKind::OutcomeIndeterminate),
        ExtensionHostFailureCodeDto::OutcomeIndeterminate
    );
}

#[test]
fn output_events_preserve_sequence_fences_and_structured_entry_metadata() {
    let dto = output_event_dto(SequencedExtensionHostOutputEvent {
        sequence: 7,
        event: ExtensionHostOutputEvent {
            context: HostEventContext::new(3, 11),
            operation: HostOutputOperation::Append {
                channel_id: "review".into(),
                text: "ready\n".into(),
                severity: HostOutputSeverity::Warning,
                category: Some("lifecycle".into()),
            },
        },
    });

    assert_eq!(dto.sequence, 7);
    assert_eq!(dto.incarnation, 3);
    assert_eq!(dto.activation_generation, 11);
    assert!(matches!(
        dto.operation,
        ExtensionHostOutputOperationDto::Append {
            channel_id,
            text,
            category: Some(category),
            ..
        } if channel_id == "review" && text == "ready\n" && category == "lifecycle"
    ));
}
