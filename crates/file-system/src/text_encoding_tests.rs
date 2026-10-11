use super::*;

#[test]
fn unicode_boms_round_trip_without_consuming_content_bom() {
    for encoding in ["utf8bom", "utf16le", "utf16be"] {
        let text = "\u{feff}中文 🦀\r\n";
        let bytes = encode_text(text, encoding).unwrap();
        let decoded = decode_text(&bytes, "auto").unwrap();
        assert_eq!(decoded.text, text);
        assert_eq!(decoded.encoding, encoding);
    }
    assert_eq!(decode_text(b"hello", "auto").unwrap().encoding, "utf8");
}

#[test]
fn legacy_codec_round_trips_and_rejects_lossy_writes() {
    for (encoding, text) in [
        ("gbk", "中文"),
        ("gb18030", "中文🦀"),
        ("big5", "繁體中文"),
        ("shiftjis", "日本語"),
        ("euckr", "한국어"),
    ] {
        let bytes = encode_text(text, encoding).unwrap();
        assert_eq!(decode_text(&bytes, encoding).unwrap().text, text);
    }
    assert_eq!(encode_text("🦀", "gbk"), Err(TextEncodingError::Unmappable));
    assert_eq!(
        encode_text("🦀", "iso88591"),
        Err(TextEncodingError::Unmappable)
    );
    assert_eq!(
        encode_text("text", "unknown"),
        Err(TextEncodingError::Unsupported)
    );
}

#[test]
fn latin1_is_distinct_from_windows1252() {
    assert_eq!(decode_text(&[0x80], "iso88591").unwrap().text, "\u{80}");
    assert_eq!(decode_text(&[0x80], "windows1252").unwrap().text, "€");
    assert_eq!(encode_text("\u{80}", "iso88591").unwrap(), [0x80]);
}

#[test]
fn malformed_and_binary_files_are_rejected_without_guessing() {
    for bytes in [
        vec![0xff],
        vec![0xff, 0xfe, 0x00],
        vec![0xff, 0xfe, 0x00, 0xd8],
        vec![0x61, 0x00, 0x62],
        vec![1, 2, 3],
    ] {
        assert!(matches!(
            decode_text(&bytes, "auto"),
            Err(TextEncodingError::InvalidText)
        ));
    }
    assert_eq!(
        decode_text(&encode_text("abc", "utf16le").unwrap(), "auto")
            .unwrap()
            .text,
        "abc"
    );
}

#[test]
fn encoded_output_matches_file_byte_conventions() {
    assert_eq!(
        encode_text("中文", "gbk").unwrap(),
        [0xd6, 0xd0, 0xce, 0xc4]
    );
    assert_eq!(
        encode_text("中文", "utf16le").unwrap(),
        [0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]
    );
    assert_eq!(
        encode_text("中文", "utf16be").unwrap(),
        [0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]
    );
    assert_eq!(
        encode_text("hi", "utf8bom").unwrap(),
        [0xef, 0xbb, 0xbf, b'h', b'i']
    );
}
