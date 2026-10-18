use super::*;

#[test]
fn output_limit_preserves_unicode_markers_and_images_at_small_budgets() {
    let image = OutputItem::Image {
        image_url: "data:image/png;base64,AAAA".into(),
        detail: None,
    };
    for (budget, expected) in [
        (0, ""),
        (11, ""),
        (12, " [truncated]"),
        (13, "a [truncated]"),
        (14, "a [truncated]"),
        (16, "a中 [truncated]"),
    ] {
        let mut response = RuntimeResponse::Running {
            cell_id: CellId::new("cell-1").unwrap(),
            content_items: vec![
                OutputItem::Text {
                    text: "a中😀".repeat(10),
                },
                image.clone(),
            ],
        };
        limit_output(&mut response, Some(budget));
        let mut content_items = Vec::new();
        if !expected.is_empty() {
            content_items.push(OutputItem::Text {
                text: expected.into(),
            });
        }
        content_items.push(image.clone());
        assert_eq!(
            response,
            RuntimeResponse::Running {
                cell_id: CellId::new("cell-1").unwrap(),
                content_items,
            },
            "budget {budget}",
        );
    }
}

#[test]
fn frame_round_trip_uses_little_endian_length_prefix() {
    let value = HostFrame {
        request_id: Some(42),
        message: ClientToHost::Hello {
            protocol_version: CODE_MODE_PROTOCOL_VERSION,
        },
    };
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &value).unwrap();
    let payload_len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!(payload_len, bytes.len() - 4);
    assert_eq!(
        read_frame::<_, HostFrame<ClientToHost>>(&mut bytes.as_slice()).unwrap(),
        value
    );
}

#[test]
fn oversized_frame_is_rejected_before_writing() {
    let value = HostToClient::Error {
        message: "x".repeat(MAX_FRAME_BYTES),
    };
    let mut bytes = Vec::new();
    assert!(matches!(
        write_frame(&mut bytes, &value),
        Err(ProtocolError::FrameTooLarge { .. })
    ));
    assert!(bytes.is_empty());
}

#[test]
fn truncated_frame_payload_is_reported_as_eof() {
    let mut bytes = Vec::from(5_u32.to_le_bytes());
    bytes.extend_from_slice(b"{};");
    assert_eq!(
        read_frame::<_, ClientToHost>(&mut bytes.as_slice()).unwrap_err(),
        ProtocolError::UnexpectedEof
    );
}

#[test]
fn wait_boolean_is_converted_to_named_action() {
    let cell_id = CellId::new("cell-1").unwrap();
    assert_eq!(
        WaitRequest {
            cell_id: cell_id.clone(),
            yield_time_ms: 1,
            max_output_tokens: None,
            terminate: false,
        }
        .action(),
        WaitAction::Poll
    );
    assert_eq!(
        WaitRequest {
            cell_id,
            yield_time_ms: 1,
            max_output_tokens: None,
            terminate: true,
        }
        .action(),
        WaitAction::Terminate
    );
}

#[test]
fn tagged_host_messages_round_trip_newtype_payloads() {
    let session_id = CodeModeSessionId::new("session-1").unwrap();
    let execute = ClientToHost::Execute(ExecuteRequest {
        session_id: session_id.clone(),
        tool_call_id: "tool-1".into(),
        source: "text('ok');".into(),
        enabled_tools: Vec::new(),
        yield_time_ms: 1,
        max_output_tokens: None,
    });
    let execute_json = serde_json::to_value(&execute).unwrap();
    assert_eq!(execute_json["type"], "execute");
    assert_eq!(
        serde_json::from_value::<ClientToHost>(execute_json).unwrap(),
        execute
    );

    let response = HostToClient::Response {
        response: RuntimeResponse::Running {
            cell_id: CellId::new("cell-1").unwrap(),
            content_items: Vec::new(),
        },
    };
    let response_json = serde_json::to_value(&response).unwrap();
    assert_eq!(response_json["type"], "response");
    assert_eq!(
        serde_json::from_value::<HostToClient>(response_json).unwrap(),
        response
    );
}

#[test]
fn host_callback_cancellation_round_trips_independently_of_observation() {
    let message = super::HostToClient::CancelCellTools {
        cell_id: super::CellId::new("cell-cancel").unwrap(),
    };
    let mut bytes = Vec::new();
    super::write_frame(&mut bytes, &message).unwrap();
    let decoded = super::read_frame::<_, super::HostToClient>(&mut bytes.as_slice()).unwrap();
    assert_eq!(decoded, message);
}
