use super::to_ascii_json_string;
use super::to_json_string_bounded;
use serde::Serialize;
use serde::ser::SerializeSeq;
use serde_json::json;
use std::cell::Cell;

#[test]
fn ascii_json_preserves_keys_values_controls_and_surrogate_pairs() {
    let value = json!({"東京": ["é\"\\\n\t\u{0000}", "🚀", "\u{2028}\u{2029}"]});
    let output = to_ascii_json_string(&value).unwrap();
    assert!(output.is_ascii());
    assert!(output.contains("\\ud83d\\ude80"));
    assert!(output.contains("\\u2028\\u2029"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output).unwrap(),
        value
    );
}

#[test]
fn bounded_json_counts_encoded_utf8_and_escape_bytes() {
    for value in [json!(null), json!("é"), json!("\n"), json!({"key": "😀"})] {
        let expected = serde_json::to_string(&value).unwrap();
        assert_eq!(
            to_json_string_bounded(&value, expected.len()).unwrap(),
            expected
        );
        assert!(
            to_json_string_bounded(&value, expected.len() - 1)
                .unwrap_err()
                .is_io()
        );
    }
    assert!(to_json_string_bounded(&json!(null), 0).is_err());
}

#[test]
fn bounded_json_stops_serializing_when_the_writer_reaches_the_limit() {
    struct Sequence(Cell<usize>);
    impl Serialize for Sequence {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut sequence = serializer.serialize_seq(None)?;
            for number in 0..100_000 {
                self.0.set(self.0.get() + 1);
                sequence.serialize_element(&number)?;
            }
            sequence.end()
        }
    }
    let value = Sequence(Cell::new(0));
    assert!(to_json_string_bounded(&value, 4).is_err());
    assert!(
        value.0.get() < 4,
        "serialization must stop before visiting the remaining values"
    );
}
