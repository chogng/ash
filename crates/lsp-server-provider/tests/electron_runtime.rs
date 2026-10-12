use std::path::PathBuf;
use std::time::Duration;

use ash_lsp::LanguageServerClient;
use ash_lsp::LanguageServerOptions;
use ash_lsp::lsp_types::Position;
use ash_lsp::lsp_types::TextDocumentIdentifier;
use ash_lsp::lsp_types::TextDocumentPositionParams;
use ash_lsp::lsp_types::request::HoverRequest;
use ash_lsp_server_provider::LanguageServerProvider;
use ash_lsp_server_provider::LspServerLaunch;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;

#[tokio::test]
#[ignore = "requires ASH_TEST_ELECTRON_PATH; executed by Desktop runtime acceptance"]
async fn electron_language_server_initializes_answers_restarts_and_shuts_down() {
    let executable = PathBuf::from(
        std::env::var_os("ASH_TEST_ELECTRON_PATH").expect("acceptance must provide Electron"),
    );
    let root = tempfile::tempdir().unwrap();
    let expected = std::env::var("ASH_TEST_ELECTRON_VERSION")
        .expect("acceptance must provide the expected Electron version");
    let entrypoint = root.path().join("server.cjs");
    std::fs::write(
        &entrypoint,
        include_str!("fixtures/electron_language_server.cjs"),
    )
    .unwrap();
    let provider = NodePackageLanguageServerProvider::new(
        "electron-test",
        ["test".to_string()],
        entrypoint,
        ManagedNodeRuntime::from_electron_path(executable).unwrap(),
    )
    .unwrap();
    for _ in 0..2 {
        let (_, command, _) = provider
            .definition(root.path(), LspServerLaunch::Packaged)
            .unwrap()
            .into_launch_parts();
        let client = tokio::time::timeout(
            Duration::from_secs(10),
            LanguageServerClient::start_stdio(
                command,
                LanguageServerOptions::new("acceptance", "1"),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let hover = client
            .request::<HoverRequest>(ash_lsp::lsp_types::HoverParams {
                text_document_position_params: TextDocumentPositionParams {
                    text_document: TextDocumentIdentifier {
                        uri: "file:///acceptance.test".parse().unwrap(),
                    },
                    position: Position::new(0, 0),
                },
                work_done_progress_params: Default::default(),
            })
            .await
            .unwrap()
            .unwrap();
        let result = serde_json::to_value(hover).unwrap();
        assert!(
            result
                .to_string()
                .contains(&format!("Electron {expected};")),
            "{result}"
        );
        tokio::time::timeout(Duration::from_secs(10), client.shutdown())
            .await
            .unwrap()
            .unwrap();
    }
}
