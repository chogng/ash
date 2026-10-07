use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

use crate::framing::encode_message;
use crate::framing::read_message;

#[test]
fn dap_framing_round_trips_lldb_zero_sequence_responses() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let expected = json!({ "seq": 0, "type": "response", "request_seq": 1, "command": "initialize", "success": true });
        let framed = encode_message(&expected).unwrap();
        let (mut writer, reader) = tokio::io::duplex(framed.len() + 16);
        writer.write_all(&framed).await.unwrap();
        drop(writer);
        let actual = read_message(&mut BufReader::new(reader)).await.unwrap();
        assert_eq!(actual, Some(expected));
    });
}

#[test]
fn dap_framing_rejects_missing_content_length() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (mut writer, reader) = tokio::io::duplex(64);
        writer
            .write_all(b"Content-Type: application/json\r\n\r\n{}")
            .await
            .unwrap();
        drop(writer);
        let error = read_message(&mut BufReader::new(reader)).await.unwrap_err();
        assert!(error.to_string().contains("missing Content-Length"));
    });
}

#[test]
fn dap_framing_rejects_non_integer_adapter_sequences() {
    for seq in [json!(-1), json!(1.5), json!("0"), json!(null)] {
        assert!(
            encode_message(&json!({"seq": seq, "type": "event", "event": "initialized"})).is_err()
        );
    }
}
