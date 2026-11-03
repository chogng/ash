use super::speech_instructions;
use ash_app_server_protocol::protocol::speech::SpeechInstructionKind;
use serde_json::json;

#[test]
fn profile_instruction_files_preserve_text_and_remain_separate() {
    let root = tempfile::tempdir().unwrap();
    for kind in [
        SpeechInstructionKind::Voice,
        SpeechInstructionKind::Dictation,
    ] {
        let missing = speech_instructions::read(root.path(), kind).unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.revision, "missing");
        let text = match kind {
            SpeechInstructionKind::Voice => "# Voice\r\n用中文回答。\r\n",
            SpeechInstructionKind::Dictation => "Project terms: Ash, Stanza, MCP.\n",
        };
        let revision = speech_instructions::write(root.path(), kind, text, "missing").unwrap();
        let document = speech_instructions::read(root.path(), kind).unwrap();
        assert!(document.exists);
        assert_eq!(document.text, text);
        assert_eq!(document.revision, revision);
    }
    let other = tempfile::tempdir().unwrap();
    assert!(
        !speech_instructions::read(other.path(), SpeechInstructionKind::Voice)
            .unwrap()
            .exists
    );
}

#[test]
fn stale_editors_and_external_edits_cannot_overwrite_a_new_revision() {
    let root = tempfile::tempdir().unwrap();
    let kind = SpeechInstructionKind::Voice;
    let first = speech_instructions::write(root.path(), kind, "First", "missing").unwrap();
    assert!(matches!(
        speech_instructions::write(root.path(), kind, "Stale create", "missing"),
        Err(ash_file_system::FileSystemError::RevisionConflict(_))
    ));
    std::fs::write(root.path().join("voice.md"), "External change").unwrap();
    assert!(matches!(
        speech_instructions::write(root.path(), kind, "Stale save", &first),
        Err(ash_file_system::FileSystemError::RevisionConflict(_))
    ));
    let fresh = speech_instructions::read(root.path(), kind).unwrap();
    speech_instructions::write(root.path(), kind, "Reviewed replacement", &fresh.revision).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("voice.md")).unwrap(),
        "Reviewed replacement"
    );
}

#[test]
fn invalid_or_oversized_instruction_files_do_not_become_model_prompts() {
    let root = tempfile::tempdir().unwrap();
    let kind = SpeechInstructionKind::Dictation;
    assert!(
        speech_instructions::write(
            root.path(),
            kind,
            &"x".repeat(speech_instructions::MAX_BYTES + 1),
            "missing"
        )
        .is_err()
    );
    assert!(!root.path().join("dictation.md").exists());
    std::fs::write(root.path().join("dictation.md"), [255, 254]).unwrap();
    assert!(speech_instructions::read(root.path(), kind).is_err());
    std::fs::write(
        root.path().join("dictation.md"),
        vec![b'x'; speech_instructions::MAX_BYTES + 1],
    )
    .unwrap();
    assert!(speech_instructions::read(root.path(), kind).is_err());
}

#[cfg(unix)]
#[test]
fn instruction_links_do_not_expose_or_replace_other_profile_files() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("private.txt"), "private").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("private.txt"),
        root.path().join("voice.md"),
    )
    .unwrap();
    assert!(speech_instructions::read(root.path(), SpeechInstructionKind::Voice).is_err());
    assert!(
        speech_instructions::write(
            root.path(),
            SpeechInstructionKind::Voice,
            "replacement",
            "missing"
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("private.txt")).unwrap(),
        "private"
    );
}

#[test]
fn instruction_rpc_admits_only_the_product_host_and_fixed_kinds() {
    let root = tempfile::tempdir().unwrap();
    let server = crate::tests::server().with_home(std::sync::Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(root.path()).unwrap(),
    )));
    for mut connection in [server.connection(), server.browser_connection()] {
        crate::tests::initialize(&server, &mut connection);
        let result = crate::tests::call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":2,"method":"speech/instructions/read","params":{"kind":"voice"}}),
        );
        assert_eq!(result["error"]["code"], -32073);
    }
    let mut host = server.product_host_connection();
    crate::tests::initialize(&server, &mut host);
    let missing = crate::tests::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":2,"method":"speech/instructions/read","params":{"kind":"voice"}}),
    );
    assert_eq!(missing["result"]["revision"], "missing");
    for (params, code) in [
        (json!({"kind":"../config.toml"}), -32602),
        (json!({"kind":"voice","path":"config.toml"}), -32600),
    ] {
        let invalid = crate::tests::call(
            &server,
            &mut host,
            json!({"jsonrpc":"2.0","id":3,"method":"speech/instructions/read","params":params}),
        );
        assert_eq!(invalid["error"]["code"], code);
    }
    let saved = crate::tests::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":4,"method":"speech/instructions/write","params":{"kind":"voice","text":"Use concise answers.","expectedRevision":"missing"}}),
    );
    assert!(saved["result"]["revision"].as_str().is_some());
    let conflict = crate::tests::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":5,"method":"speech/instructions/write","params":{"kind":"voice","text":"Stale edit","expectedRevision":"missing"}}),
    );
    assert_eq!(
        conflict["error"]["data"]["kind"],
        "FileSystemRevisionConflict"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("voice.md")).unwrap(),
        "Use concise answers."
    );
}
