use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use serde_json::json;

pub(super) const SERVER: &str = r#"
log="$LSP_LOG/$$"
printf '{"environment":"%s","argument":"%s"}\n' "$LSP_OPTION" "$1" >> "$log"
text= saved=
cr=$(printf '\r')
while :; do
  length=
  while IFS= read -r line; do
    line=${line%"$cr"}
    [ -z "$line" ] && break
    case "$line" in Content-Length:*) length=${line#Content-Length: };; esac
  done
  [ -n "$length" ] || exit 0
  message=$(dd bs=1 count="$length" 2>/dev/null)
  printf '%s\n' "$message" >> "$log"
  id=$(printf '%s' "$message" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$message" in
    *'"method":"exit"'*) exit 0;;
    *'"method":"textDocument/didOpen"'*|*'"method":"textDocument/didChange"'*)
      text=$(printf '%s' "$message" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p');;
    *'"method":"textDocument/didSave"'*)
      saved=$(printf '%s' "$message" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p');;
  esac
  [ -n "$id" ] || continue
  result=null
  case "$message" in
    *'"method":"initialize"'*)
      root_uri=$(printf '%s' "$message" | sed -n 's/.*"rootUri":"\([^"]*\)".*/\1/p')
      if [ "$LSP_OPTION" = projection ]; then
        result='{"capabilities":{"positionEncoding":"utf-8","textDocumentSync":{"openClose":true,"change":1},"definitionProvider":true,"renameProvider":true,"workspaceSymbolProvider":true,"completionProvider":{},"documentFormattingProvider":true,"documentRangeFormattingProvider":true}}'
      else
        result='{"capabilities":{"textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":true}},"hoverProvider":true,"completionProvider":{"triggerCharacters":["="]},"signatureHelpProvider":{"triggerCharacters":["["],"retriggerCharacters":["]"]}}}'
      fi;;
    *'"method":"textDocument/definition"'*)
      result="[{\"uri\":\"$root_uri/target.demo\",\"range\":{\"start\":{\"line\":0,\"character\":12},\"end\":{\"line\":0,\"character\":18}}}]";;
    *'"method":"textDocument/rename"'*)
      result="{\"changes\":{\"$root_uri/target.demo\":[{\"range\":{\"start\":{\"line\":0,\"character\":12},\"end\":{\"line\":0,\"character\":18}},\"newText\":\"renamed\"}]}}";;
    *'"method":"workspace/symbol"'*)
      result="[{\"name\":\"target\",\"kind\":12,\"location\":{\"uri\":\"$root_uri/target.demo\",\"range\":{\"start\":{\"line\":0,\"character\":12},\"end\":{\"line\":0,\"character\":18}}}}]";;
    *'"method":"textDocument/completion"'*)
      result='[{"label":"keyword","textEdit":{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"keyword"}}]';;
    *'"method":"textDocument/formatting"'*|*'"method":"textDocument/rangeFormatting"'*)
      result='[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"formatted"}]';;
    *'"method":"textDocument/hover"'*)
      if [ "$text" = slow ]; then
        : > "$LSP_LOG/blocked"
        while [ ! -f "$LSP_LOG/release" ]; do sleep 0.01; done
      fi
      result="{\"contents\":\"$text|$saved|$$\"}";;
  esac
  response="{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":$result}"
  printf 'Content-Length: %s\r\n\r\n%s' "${#response}" "$response"
done
"#;

struct Fixture {
    server: Arc<crate::AppServer>,
    root: tempfile::TempDir,
    sequence: AtomicU64,
    revision: AtomicU64,
}

struct ReleaseOnDrop(std::path::PathBuf);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, "");
    }
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("server.sh"), SERVER).unwrap();
        std::fs::create_dir(root.path().join("logs")).unwrap();
        for file in ["same.demo", "other.other"] {
            std::fs::write(root.path().join(file), "disk").unwrap();
        }
        let grant = ash_file_access::Grant::for_environment(
            ash_file_access::Dir::open_local(root.path()).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([
                ash_file_access::Permission::UseLanguageServices,
                ash_file_access::Permission::ExecuteCommands,
                ash_file_access::Permission::ReadFiles,
            ]),
        );
        let mut server = crate::tests::server()
            .with_config_store(Arc::new(
                ash_config::ConfigStore::open(root.path().join("config.sqlite3")).unwrap(),
            ))
            .with_file_system(Arc::new(ash_file_system::LocalFileSystem::new(
                grant.clone(),
            )));
        server.env_runtime_mut().selected_grant = Some(grant);
        Self {
            server: Arc::new(server),
            root,
            sequence: AtomicU64::new(2),
            revision: AtomicU64::new(0),
        }
    }

    fn connection(&self) -> crate::ConnectionState {
        let mut connection = self.server.connection();
        crate::tests::initialize(&self.server, &mut connection);
        connection
    }

    fn call(&self, connection: &mut crate::ConnectionState, method: &str, params: Value) -> Value {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        crate::tests::call(
            &self.server,
            connection,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
    }

    fn configure(
        &self,
        connection: &mut crate::ConnectionState,
        id: &str,
        language: &str,
        enabled: bool,
        option: &str,
    ) {
        let revision = self.revision.fetch_add(1, Ordering::Relaxed);
        let config = if enabled {
            json!({"mode":"enabled", "executable":"/bin/sh", "languageIds":[language],
                "args":[self.root.path().join("server.sh"), "--fixture"],
                "environment":{"LSP_LOG":self.root.path().join("logs"), "LSP_OPTION":option}})
        } else {
            json!({"mode":"disabled"})
        };
        let response = self.call(connection, "languageServer/configure", json!({
            "commandId":format!("configure-{revision}"), "expectedRevision":revision, "serverId":id, "config":config,
        }));
        assert!(response.get("result").is_some(), "{response}");
    }

    fn hover(
        &self,
        connection: &mut crate::ConnectionState,
        language: &str,
        revision: u64,
        text: &str,
    ) -> Value {
        let operation = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.call(connection, "language/hover", json!({"operationId":format!("hover-{operation}"),"request":{
            "document":{"path":if language == "demo" {"same.demo"} else {"other.other"}, "languageId":language, "revision":revision, "text":text},
            "position":{"lineIndex":0, "columnIndex":0},
        }}))
    }

    fn wait_until_blocked(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.root.path().join("logs/blocked").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            self.root.path().join("logs/blocked").exists(),
            "fixture received slow hover"
        );
    }

    fn release(&self) {
        std::fs::write(self.root.path().join("logs/release"), "").unwrap();
    }
}

fn contents(response: &Value) -> &str {
    response["result"]["contents"]
        .as_str()
        .unwrap_or_else(|| panic!("hover failed: {response}"))
}

#[test]
fn cross_file_results_use_the_connections_unsaved_target_text() {
    let fixture = Fixture::new();
    let disk = "/*a*/ fn target() {}";
    std::fs::write(fixture.root.path().join("target.demo"), disk).unwrap();
    let mut connection = fixture.connection();
    fixture.configure(&mut connection, "fixture", "demo", true, "projection");
    let dirty = "/*🦀*/ fn target() {}";
    let opened = fixture.call(
        &mut connection,
        "language/synchronize",
        json!({
            "document":{"path":"target.demo", "languageId":"demo", "revision":1, "text":disk}
        }),
    );
    assert!(opened.get("result").is_some(), "{opened}");
    let changed = fixture.call(
        &mut connection,
        "language/synchronize",
        json!({
            "document":{"path":"target.demo", "languageId":"demo", "revision":2, "text":dirty}
        }),
    );
    assert!(changed.get("result").is_some(), "{changed}");
    // Another renderer's snapshot of the same path must not replace this connection's text.
    let mut peer = fixture.connection();
    let peer_opened = fixture.call(
        &mut peer,
        "language/synchronize",
        json!({
            "document":{"path":"target.demo", "languageId":"demo", "revision":1, "text":disk}
        }),
    );
    assert!(peer_opened.get("result").is_some(), "{peer_opened}");
    let document =
        json!({"path":"same.demo", "languageId":"demo", "revision":1, "text":"target()"});
    let position = json!({"lineIndex":0,"columnIndex":0});
    let expected =
        json!({"start":{"lineIndex":0,"columnIndex":10},"end":{"lineIndex":0,"columnIndex":16}});
    let mut definition = json!({
        "operationId":"definition", "request":{"document":document, "position":position, "kind":"definition", "includeDeclaration":false}
    });
    let locations = fixture.call(&mut connection, "language/locations", definition.clone());
    assert_eq!(
        locations["result"]["locations"][0]["range"], expected,
        "{locations}"
    );
    let renamed = fixture.call(&mut connection, "language/rename", json!({
        "operationId":"rename", "request":{"document":document, "position":position, "newName":"renamed"}
    }));
    let edit = &renamed["result"]["entries"][0]["document"];
    assert_eq!(edit["expectedText"], dirty, "{renamed}");
    assert_eq!(edit["edits"][0]["range"], expected, "{renamed}");
    let symbols = fixture.call(
        &mut connection,
        "language/directorySymbols",
        json!({
            "operationId":"symbols", "request":{"languageId":"demo", "query":"target"}
        }),
    );
    assert_eq!(
        symbols["result"]["symbols"][0]["range"], expected,
        "{symbols}"
    );
    let closed = fixture.call(
        &mut connection,
        "language/close",
        json!({"path":"target.demo"}),
    );
    assert!(closed.get("result").is_some(), "{closed}");
    definition["operationId"] = json!("definition-after-close");
    let after_close = fixture.call(&mut connection, "language/locations", definition);
    assert_eq!(
        after_close["result"]["locations"][0]["range"],
        json!({
            "start":{"lineIndex":0,"columnIndex":12},"end":{"lineIndex":0,"columnIndex":18}
        }),
        "closed targets use disk text: {after_close}"
    );
    fixture.server.close_connection(peer);
    fixture.server.close_connection(connection);
}

#[test]
fn empty_document_completions_and_formatting_survive_the_protocol_adapter() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    fixture.configure(&mut connection, "fixture", "demo", true, "projection");
    let document = json!({"path":"same.demo", "languageId":"demo", "revision":1, "text":""});
    let range =
        json!({"start":{"lineIndex":0,"columnIndex":0},"end":{"lineIndex":0,"columnIndex":0}});
    let completions = fixture.call(&mut connection, "language/completions", json!({
        "operationId":"completion", "request":{"document":document, "position":{"lineIndex":0,"columnIndex":0}, "triggerKind":"invoke", "triggerCharacter":null}
    }));
    assert_eq!(
        completions["result"]["items"][0]["insertText"], "keyword",
        "{completions}"
    );
    assert_eq!(
        completions["result"]["items"][0]["range"], range,
        "{completions}"
    );
    for method in ["language/formatDocument", "language/formatRange"] {
        let mut request = json!({"document":document,
            "options":{"tabSize":4,"insertSpaces":true,"trimTrailingWhitespace":null}});
        if method == "language/formatRange" {
            request["range"] = range.clone();
        }
        let formatted = fixture.call(
            &mut connection,
            method,
            json!({"operationId":method, "request":request}),
        );
        assert_eq!(
            formatted["result"]["edits"][0]["range"], range,
            "{formatted}"
        );
        assert_eq!(
            formatted["result"]["edits"][0]["newText"], "formatted",
            "{formatted}"
        );
    }
    fixture.server.close_connection(connection);
}

#[test]
fn a_slow_connection_does_not_block_peers_or_source_revocation() {
    let fixture = Arc::new(Fixture::new());
    let _release = ReleaseOnDrop(fixture.root.path().join("logs/release"));
    let mut control = fixture.connection();
    fixture.configure(&mut control, "fixture", "demo", true, "first");
    let first = fixture.connection();
    let mut second = fixture.connection();
    let before = fixture.hover(&mut second, "demo", 1, "beta");
    let slow_fixture = fixture.clone();
    let (slow_sender, slow_receiver) = std::sync::mpsc::channel();
    let slow = std::thread::spawn(move || {
        let mut connection = first;
        let result = slow_fixture.hover(&mut connection, "demo", 1, "slow");
        slow_fixture.server.close_connection(connection);
        slow_sender.send(result).unwrap();
    });
    fixture.wait_until_blocked();
    let fast_fixture = fixture.clone();
    let (fast_sender, fast_receiver) = std::sync::mpsc::channel();
    let fast = std::thread::spawn(move || {
        let response = fast_fixture.hover(&mut second, "demo", 2, "beta");
        fast_sender.send((response, second)).unwrap();
    });
    let peer = fast_receiver.recv_timeout(Duration::from_secs(1));
    // Always unblock the fixture before assertions so a failing test cannot strand a peer.
    if peer.is_err() {
        fixture.release();
    }
    assert!(
        peer.is_ok(),
        "another connection must finish while the first server is blocked"
    );
    let (response, mut second) = peer.unwrap();
    assert_eq!(contents(&response), contents(&before));
    let retirement_started = Instant::now();
    fixture.configure(&mut control, "fixture", "demo", false, "");
    let retirement_elapsed = retirement_started.elapsed();
    let cancelled = slow_receiver.recv_timeout(Duration::from_secs(1));
    fixture.release();
    slow.join().unwrap();
    fast.join().unwrap();
    assert!(
        retirement_elapsed < Duration::from_secs(1),
        "revocation must not wait for the outstanding language RPC"
    );
    assert!(
        cancelled.unwrap().get("error").is_some(),
        "a retired source must not deliver its late result"
    );
    fixture.configure(&mut control, "fixture", "demo", true, "replacement");
    let after = fixture.hover(&mut second, "demo", 2, "beta");
    assert!(contents(&after).starts_with("beta||"));
    assert_ne!(
        contents(&after),
        contents(&before),
        "reenabling creates a fresh process"
    );
    fixture.server.close_connection(second);
    fixture.server.close_connection(control);
}

#[test]
fn changing_one_server_preserves_other_processes_and_in_flight_results() {
    let fixture = Arc::new(Fixture::new());
    let _release = ReleaseOnDrop(fixture.root.path().join("logs/release"));
    let mut control = fixture.connection();
    fixture.configure(&mut control, "fixture", "demo", true, "first");
    fixture.configure(&mut control, "other", "other", true, "other");
    let mut connection = fixture.connection();
    let before = fixture.hover(&mut connection, "demo", 1, "dirty");
    let other_before = fixture.hover(&mut connection, "other", 1, "beta");
    let slow_fixture = fixture.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let slow = std::thread::spawn(move || {
        let response = slow_fixture.hover(&mut connection, "other", 2, "slow");
        sender.send((response, connection)).unwrap();
    });
    fixture.wait_until_blocked();
    fixture.configure(&mut control, "fixture", "demo", true, "changed");
    fixture.release();
    let (response, mut connection) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    slow.join().unwrap();
    assert_eq!(
        contents(&response).rsplit('|').next(),
        contents(&other_before).rsplit('|').next(),
        "the unrelated in-flight response retains its process"
    );
    let other_after = fixture.hover(&mut connection, "other", 3, "beta");
    assert_eq!(contents(&other_before), contents(&other_after));
    let after = fixture.hover(&mut connection, "demo", 1, "dirty");
    assert!(contents(&after).starts_with("dirty||"));
    assert_ne!(contents(&before), contents(&after));
    fixture.server.close_connection(connection);
    fixture.server.close_connection(control);
}

#[test]
fn directory_reset_accepts_the_new_authorized_root_and_discards_old_documents() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    fixture.configure(&mut connection, "fixture", "demo", true, "first");
    let old = fixture.hover(&mut connection, "demo", 9, "alpha");
    fixture.server.language.lock().unwrap().retain_dir_roots(
        &[fixture.root.path().canonicalize().unwrap()]
            .into_iter()
            .collect(),
    );
    let next = tempfile::tempdir().unwrap();
    std::fs::write(next.path().join("same.demo"), "disk").unwrap();
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(next.path()).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([
            ash_file_access::Permission::UseLanguageServices,
            ash_file_access::Permission::ExecuteCommands,
            ash_file_access::Permission::ReadFiles,
        ]),
    );
    fixture.server.env_runtime.write().unwrap().selected_grant = Some(grant);
    fixture.server.language.lock().unwrap().reset_dirs();
    let current = fixture.hover(&mut connection, "demo", 1, "beta");
    assert!(contents(&current).starts_with("beta||"));
    assert_ne!(
        contents(&old).rsplit('|').next(),
        contents(&current).rsplit('|').next()
    );
    fixture.server.close_connection(connection);
}

#[test]
fn client_settings_restart_only_the_owning_connections_server_and_clear_on_removal() {
    let fixture = Fixture::new();
    let mut first = fixture.connection();
    let mut second = fixture.connection();
    fixture.configure(&mut first, "fixture", "demo", true, "settings");
    let settings = json!({"settings":{"fixture":{"enabled":true}}});
    assert!(
        fixture
            .call(&mut first, "language/servers", settings.clone())
            .get("result")
            .is_some()
    );
    let before = fixture.hover(&mut first, "demo", 1, "alpha");
    let peer = fixture.hover(&mut second, "demo", 1, "beta");
    assert!(
        fixture
            .call(&mut first, "language/servers", settings)
            .get("result")
            .is_some()
    );
    assert_eq!(
        contents(&fixture.hover(&mut first, "demo", 1, "alpha")),
        contents(&before)
    );
    assert!(
        fixture
            .call(&mut first, "language/servers", json!({"settings":{}}))
            .get("result")
            .is_some()
    );
    let after = fixture.hover(&mut first, "demo", 1, "alpha");
    assert_ne!(
        contents(&after),
        contents(&before),
        "removing settings replaces the launch"
    );
    assert!(
        contents(&after).starts_with("alpha||"),
        "the document is replayed after replacing the server"
    );
    assert_eq!(
        contents(&fixture.hover(&mut second, "demo", 1, "beta")),
        contents(&peer)
    );
    fixture.server.close_connection(first);
    fixture.server.close_connection(second);
}

#[test]
fn language_server_controls_preserve_configuration_documents_and_connection_isolation() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    fixture.configure(&mut connection, "fixture", "demo", true, "first");
    fixture.configure(&mut connection, "other", "other", true, "second");
    let mut peer = fixture.connection();
    let first = fixture.hover(&mut connection, "demo", 1, "alpha");
    let other = fixture.hover(&mut connection, "other", 1, "beta");
    let peer_before = fixture.hover(&mut peer, "demo", 1, "peer");
    let pid = contents(&first).rsplit('|').next().unwrap();
    let control = |connection: &mut crate::ConnectionState, action: &str, server: Option<&str>| {
        let mut params = json!({"action": action});
        if let Some(server) = server {
            params["serverId"] = json!(server);
        }
        let response = fixture.call(connection, "language/serverControl", params);
        assert!(response.get("result").is_some(), "{response}");
    };

    control(&mut connection, "stop", Some("fixture"));
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .output()
            .unwrap()
            .status
            .success(),
        "stop acknowledges after reap"
    );
    let stopped = fixture.call(&mut connection, "language/servers", json!({}));
    assert!(
        stopped["result"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| server["id"] == "fixture" && server["state"]["type"] == "stopped"),
        "{stopped}"
    );
    let retry = fixture.hover(&mut connection, "demo", 2, "changed");
    assert!(
        retry.get("error").is_some(),
        "a background request must not resume a stopped server: {retry}"
    );
    assert_eq!(
        contents(&fixture.hover(&mut peer, "demo", 2, "peer")),
        contents(&peer_before)
    );
    assert_eq!(
        contents(&fixture.hover(&mut connection, "other", 2, "beta")),
        contents(&other)
    );

    control(&mut connection, "restart", Some("fixture"));
    let restarted = fixture.hover(&mut connection, "demo", 3, "changed");
    assert!(
        contents(&restarted).starts_with("changed||"),
        "current document is replayed: {restarted}"
    );
    assert_ne!(contents(&restarted).rsplit('|').next().unwrap(), pid);
    control(&mut connection, "stop", None);
    assert!(
        fixture
            .hover(&mut connection, "demo", 4, "changed")
            .get("error")
            .is_some()
    );
    assert!(
        fixture
            .hover(&mut connection, "other", 3, "beta")
            .get("error")
            .is_some()
    );
    control(&mut connection, "restart", None);
    assert!(
        contents(&fixture.hover(&mut connection, "demo", 5, "changed")).starts_with("changed||")
    );
    assert!(contents(&fixture.hover(&mut connection, "other", 4, "beta")).starts_with("beta||"));
    let config = fixture.call(&mut connection, "config/read", json!({}));
    assert_eq!(
        config["result"]["revision"], 2,
        "process controls never mutate persistent configuration"
    );
    let unknown = fixture.call(
        &mut connection,
        "language/serverControl",
        json!({"action":"restart", "serverId":"unknown"}),
    );
    assert!(unknown.get("error").is_some(), "{unknown}");
}

#[test]
fn language_server_discovery_and_batch_restart_leave_idle_servers_unstarted() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    fixture.configure(&mut connection, "fixture", "demo", true, "first");
    fixture.configure(&mut connection, "other", "other", true, "second");
    let response = fixture.call(&mut connection, "language/servers", json!({}));
    assert!(
        response["result"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|server| server.get("state").is_none())
    );
    let response = fixture.call(
        &mut connection,
        "language/serverControl",
        json!({"action":"restart"}),
    );
    assert!(response.get("result").is_some(), "{response}");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("logs"))
            .unwrap()
            .count(),
        0
    );
    let response = fixture.call(
        &mut connection,
        "language/serverControl",
        json!({"action":"restart", "serverId":"fixture"}),
    );
    assert!(response.get("result").is_some(), "{response}");
    let first = fixture.hover(&mut connection, "demo", 1, "alpha");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("logs"))
            .unwrap()
            .count(),
        1,
        "single-server restart does not start an unrelated idle declaration"
    );
    assert!(contents(&fixture.hover(&mut connection, "other", 1, "beta")).starts_with("beta||"));
    assert_eq!(
        contents(&fixture.hover(&mut connection, "demo", 2, "alpha")),
        contents(&first)
    );
}
