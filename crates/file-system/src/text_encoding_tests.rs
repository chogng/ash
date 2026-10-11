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

#[test]
fn added_codecs_match_known_bytes_and_reject_lossy_output() {
    for (id, text, bytes) in [
        ("cp437", "éÇ", vec![0x82, 0x80]),
        ("cp850", "øØ", vec![0x9b, 0x9d]),
        ("cp852", "Łą", vec![0x9d, 0xa5]),
        ("cp857", "İı", vec![0x98, 0x8d]),
        ("cp865", "øÆ", vec![0x9b, 0x92]),
        ("cp1125", "Єє", vec![0xf4, 0xf5]),
        ("koi8t", "Ҷҷ", vec![0x8e, 0x8d]),
        ("macroman", "éΩ", vec![0x8e, 0xbd]),
        ("iso88599", "İı", vec![0xdd, 0xfd]),
        ("iso885911", "ไทย", vec![0xe4, 0xb7, 0xc2]),
        ("cp950", "繁體", vec![0xc1, 0x63, 0xc5, 0xe9]),
        ("gb2312", "中文", vec![0xd6, 0xd0, 0xce, 0xc4]),
        ("big5hkscs", "𠃊", vec![0x88, 0x4e]),
    ] {
        assert_eq!(encode_text(text, id).unwrap(), bytes, "{id}");
        assert_eq!(decode_text(&bytes, id).unwrap().text, text, "{id}");
        assert_eq!(
            encode_text("🦀", id),
            Err(TextEncodingError::Unmappable),
            "{id}"
        );
    }
    let text = "ЄєЇїЎў";
    assert_eq!(
        decode_text(&encode_text(text, "koi8ru").unwrap(), "koi8ru")
            .unwrap()
            .text,
        text
    );
    assert!(decode_text(&[0x9e, 0xd0], "cp950").is_err());
    assert!(encode_text("镕", "gb2312").is_err());
    assert_eq!(encode_text("十", "cp950").unwrap(), [0xa4, 0x51]);
}

#[test]
fn detection_respects_bom_utf16_settings_and_candidates() {
    let candidates = vec!["utf8".into(), "cp950".into()];
    let options = TextDecodingOptions {
        encoding: Some("utf8"),
        auto_guess_encoding: true,
        candidate_guess_encodings: &candidates,
    };
    let text = "一般中文\n";
    let bytes = encode_text(text, "cp950").unwrap();
    let read = decode_text_with_options(&bytes, &options).unwrap();
    assert_eq!(
        (read.encoding.as_str(), read.text.as_str()),
        ("cp950", text)
    );
    let disabled = TextDecodingOptions {
        auto_guess_encoding: false,
        ..options
    };
    assert!(decode_text_with_options(&bytes, &disabled).is_err());
    assert_eq!(
        decode_text_with_options(
            &bytes,
            &TextDecodingOptions {
                encoding: Some("cp950"),
                ..disabled
            }
        )
        .unwrap()
        .text,
        text
    );
    for id in ["utf8bom", "utf16le", "utf16be"] {
        let bytes = encode_text("hello 🦀", id).unwrap();
        assert_eq!(
            decode_text_with_options(&bytes, &disabled)
                .unwrap()
                .encoding,
            id
        );
    }
    for id in ["utf16le", "utf16be"] {
        let bytes = encode_text("hello world", id).unwrap();
        assert_eq!(
            decode_text_with_options(&bytes[2..], &disabled)
                .unwrap()
                .encoding,
            id
        );
    }
    assert_eq!(
        decode_text_with_options("中文".as_bytes(), &options)
            .unwrap()
            .encoding,
        "utf8"
    );
    let ambiguous = vec!["cp950".into(), "eucjp".into()];
    // Both candidates decode A4 A4 losslessly; the configured fallback remains authoritative.
    let result = decode_text_with_options(
        &[0xa4, 0xa4],
        &TextDecodingOptions {
            encoding: Some("iso88591"),
            auto_guess_encoding: true,
            candidate_guess_encodings: &ambiguous,
        },
    )
    .unwrap();
    assert_eq!(result.encoding, "iso88591");
    assert!(decode_text_with_options(b"PNG\0binary", &options).is_err());
    assert!(
        decode_text_with_options(
            b"file",
            &TextDecodingOptions {
                candidate_guess_encodings: &["unknown".into()],
                ..disabled
            }
        )
        .is_err()
    );
}

#[test]
fn unconstrained_detection_handles_japanese_cyrillic_and_western_text() {
    let options = TextDecodingOptions {
        auto_guess_encoding: true,
        ..Default::default()
    };
    for (id, text) in [
        (
            "shiftjis",
            "これは文字コードの自動検出を確認する日本語の文章です。日本語の文章を読み書きします。",
        ),
        (
            "windows1251",
            "Это достаточно длинный русский текст для определения кодировки файла. Проверяем чтение и запись текста.",
        ),
        (
            "windows1252",
            "Les élèves étudient à l'école française. Très bientôt, ils découvriront où habite leur professeur.",
        ),
        (
            "gbk",
            "这是一段用于测试文件编码自动检测的中文文本。我们需要正确读取和保存简体中文文件，避免错误的编码导致内容损坏。",
        ),
    ] {
        let bytes = encode_text(text, id).unwrap();
        let read = decode_text_with_options(&bytes, &options).unwrap();
        assert_eq!(read.text, text, "detected {} for {id}", read.encoding);
    }
}

#[test]
fn complete_editor_catalog_round_trips_and_truncated_utf8_is_not_a_legacy_guess() {
    for id in [
        "utf8",
        "utf8bom",
        "utf16le",
        "utf16be",
        "windows1252",
        "iso88591",
        "iso88593",
        "iso885915",
        "macroman",
        "cp437",
        "windows1256",
        "iso88596",
        "windows1257",
        "iso88594",
        "iso885914",
        "windows1250",
        "iso88592",
        "cp852",
        "windows1251",
        "cp866",
        "cp1125",
        "iso88595",
        "koi8r",
        "koi8u",
        "iso885913",
        "windows1253",
        "iso88597",
        "windows1255",
        "iso88598",
        "iso885910",
        "iso885916",
        "windows1254",
        "iso88599",
        "cp857",
        "windows1258",
        "gbk",
        "gb18030",
        "cp950",
        "big5hkscs",
        "shiftjis",
        "eucjp",
        "euckr",
        "windows874",
        "iso885911",
        "koi8ru",
        "koi8t",
        "gb2312",
        "cp865",
        "cp850",
    ] {
        let bytes = encode_text("Example 123\r\n", id).unwrap();
        assert_eq!(
            decode_text(&bytes, id).unwrap().text,
            "Example 123\r\n",
            "{id}"
        );
    }
    let options = TextDecodingOptions {
        auto_guess_encoding: true,
        candidate_guess_encodings: &["cp950".into()],
        ..Default::default()
    };
    assert!(decode_text_with_options(&[0xe4, 0xb8], &options).is_err());
    assert_eq!(
        decode_text(&[0x88, 0x62], "big5hkscs").unwrap().text,
        "Ê\u{0304}"
    );
    assert_eq!(encode_text("Ê\u{0304}", "big5hkscs").unwrap(), [0x88, 0x62]);
    assert!(decode_text(&[0xa2, 0xa1], "gb2312").is_err());
    assert_eq!(decode_text(&[0xa1, 0xa4], "gb2312").unwrap().text, "・");
    assert_eq!(encode_text("・", "gb2312").unwrap(), [0xa1, 0xa4]);
}
