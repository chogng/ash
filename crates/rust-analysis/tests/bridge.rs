//! Exercise the shipped JSON process boundary against a real Cargo workspace,
//! including upstream macro execution and incremental updates without disk edits.

use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

const SOURCE: &str = r#"
// 😀 offsets use UTF-8 bytes
use dependency::Pair;
macro_rules! plus { ($value:expr) => { $value + 1 }; }
pub fn leaf(value: usize) -> usize { value.saturating_sub(1) }
pub fn caller(value: usize) -> usize { leaf(plus!(value)) }
pub fn generic<T: Copy>(value: T) -> T { value }
pub fn layout(value: Pair) -> Pair { value }
pub fn borrow_error() -> String { let value = String::new(); drop(value); value }
#[cfg(any())]
pub fn disabled() -> usize { 0 }
macros::make!();
pub fn call_generated() -> usize { generated() }
pub fn from_build() -> usize { include!(concat!(env!("OUT_DIR"), "/generated.rs")) }
"#;

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    for directory in ["src", "dependency/src", "macros/src"] {
        std::fs::create_dir_all(root.path().join(directory)).unwrap();
    }
    std::fs::write(
        root.path().join("Cargo.toml"),
        r#"
[package]
name = "bridge-fixture"
version = "0.0.0"
edition = "2024"
[workspace]
members = ["dependency", "macros"]
[dependencies]
dependency = { path = "dependency" }
macros = { path = "macros" }
[profile.dev-small]
inherits = "dev"
debug = "none"
"#,
    )
    .unwrap();
    std::fs::write(root.path().join("src/lib.rs"), SOURCE).unwrap();
    std::fs::write(root.path().join("build.rs"), r#"
fn main() {
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("generated.rs"), "13").unwrap();
}
"#).unwrap();
    std::fs::write(
        root.path().join("dependency/Cargo.toml"),
        "[package]\nname = \"dependency\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("dependency/src/lib.rs"),
        "#[repr(C)] pub struct Pair { pub a: u8, pub b: u32 }\n",
    )
    .unwrap();
    std::fs::write(root.path().join("macros/Cargo.toml"), "[package]\nname = \"macros\"\nversion = \"0.0.0\"\nedition = \"2024\"\n[lib]\nproc-macro = true\n").unwrap();
    std::fs::write(root.path().join("macros/src/lib.rs"), "#[proc_macro] pub fn make(_: proc_macro::TokenStream) -> proc_macro::TokenStream { \"pub fn generated() -> usize { 11 }\".parse().unwrap() }\n").unwrap();
    let result = Command::new("cargo")
        .args(["generate-lockfile", "--offline"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    root
}

struct Bridge {
    child: Child,
    input: Option<ChildStdin>,
    responses: mpsc::Receiver<Value>,
    revision: u64,
    sequence: u64,
    ready: Value,
}

impl Bridge {
    fn new(workspace: &Path, build_scripts: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ash-rust-analysis"));
        command.arg(workspace).current_dir(workspace);
        if build_scripts {
            command.arg("--build-scripts");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let response: Value =
                    serde_json::from_str(&line).expect("stdout must contain only JSON frames");
                if sender.send(response).is_err() {
                    break;
                }
            }
        });
        let ready = responses.recv_timeout(Duration::from_secs(120)).unwrap();
        assert_eq!(ready["result"]["event"], "ready");
        Self {
            child,
            input: Some(input),
            responses,
            revision: 0,
            sequence: 0,
            ready,
        }
    }

    fn send(&mut self, request: Value) -> Value {
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        self.responses
            .recv_timeout(Duration::from_secs(120))
            .unwrap()
    }

    fn query(&mut self, query: Value) -> Value {
        self.sequence += 1;
        let response = self.send(json!({"protocol_version":1, "id":self.sequence, "revision":self.revision, "query":query}));
        assert_eq!(response["id"], self.sequence);
        self.revision = response["revision"].as_u64().unwrap();
        response
    }

    fn function(&mut self, name: &str, text: &str) -> Value {
        let offset = text
            .find(&format!("fn {name}("))
            .or_else(|| text.find(&format!("fn {name}<")))
            .unwrap()
            + 3;
        self.query(json!({"method":"function", "path":"src/lib.rs", "byte_offset":offset}))
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        drop(self.input.take());
        if std::thread::panicking() {
            let _ = self.child.kill();
        }
        let status = self.child.wait().unwrap();
        if !std::thread::panicking() {
            assert!(status.success());
        }
    }
}

#[test]
fn upstream_semantics_mir_references_and_revision_updates_cross_the_process_boundary() {
    let root = fixture();
    let mut bridge = Bridge::new(root.path(), false);
    assert_eq!(bridge.ready["result"]["upstream"]["modified"], false);
    assert_eq!(bridge.ready["result"]["build_scripts_requested"], false);
    let result = bridge.function("leaf", SOURCE);
    assert_eq!(result["result"]["function"]["name"], "leaf", "{result}");
    assert_eq!(result["result"]["return_type"]["display"], "usize");
    assert_eq!(result["result"]["return_type"]["contains_unknown"], false);
    assert_eq!(
        result["result"]["return_type"]["layout"]["status"],
        "available"
    );
    assert_eq!(result["result"]["mir"]["status"], "available");
    assert!(result["result"]["mir"]["block_count"].as_u64().unwrap() > 0);
    let caller = bridge.function("caller", SOURCE);
    assert!(
        caller["result"]["syntax_calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["resolved_function"]["name"] == "leaf")
    );
    let references = bridge.query(json!({"method":"references", "path":"src/lib.rs", "byte_offset":SOURCE.find("fn leaf").unwrap()+3}));
    assert_eq!(
        references["result"]["references"].as_array().unwrap().len(),
        1,
        "{references}"
    );
    let expansion = bridge.query(json!({"method":"expand_macro", "path":"src/lib.rs", "byte_offset":SOURCE.find("plus!(value)").unwrap()}));
    assert!(
        expansion["result"]["expansion"]
            .as_str()
            .unwrap()
            .contains("value + 1")
    );
    let generic = bridge.function("generic", SOURCE);
    assert_eq!(generic["result"]["generic_parameter_count"], 1);
    assert_eq!(
        generic["result"]["return_type"]["layout"]["status"],
        "unavailable"
    );
    let layout = bridge.function("layout", SOURCE);
    assert_eq!(
        layout["result"]["return_type"]["layout"]["value"]["size_bytes"],
        8
    );
    assert_eq!(
        layout["result"]["return_type"]["layout"]["value"]["alignment_bytes"],
        4
    );
    let borrow = bridge.function("borrow_error", SOURCE);
    assert_eq!(
        borrow["result"]["mir"]["status"], "available",
        "RA MIR is not rustc borrow-check validation"
    );
    let disabled = bridge.function("disabled", SOURCE);
    assert_eq!(disabled["error"]["code"], "not_found");
    let changed = SOURCE.replace(
        "leaf(value: usize) -> usize { value.saturating_sub(1) }",
        "leaf(value: usize) -> bool { value > 1 }",
    );
    let update = bridge.query(json!({"method":"change_file", "path":"src/lib.rs", "text":changed}));
    assert_eq!(update["revision"], 1);
    assert_eq!(
        bridge.function("leaf", &changed)["result"]["return_type"]["display"],
        "bool"
    );
    let stale = bridge.send(json!({"protocol_version":1,"id":99,"revision":0,"query":{"method":"function","path":"src/lib.rs","byte_offset":0}}));
    assert_eq!(stale["error"]["code"], "stale_revision");
    assert_eq!(
        std::fs::read_to_string(root.path().join("src/lib.rs")).unwrap(),
        SOURCE
    );
    let invalid = bridge.query(json!({"method":"function", "path":"src/lib.rs", "byte_offset":SOURCE.find('😀').unwrap()+1}));
    assert_eq!(invalid["error"]["code"], "invalid_request");
    let outside =
        bridge.query(json!({"method":"function", "path":"../outside.rs", "byte_offset":0}));
    assert!(outside.get("error").is_some());
}

#[test]
fn upstream_build_script_and_procedural_macro_support_is_observed_not_assumed() {
    let root = fixture();
    // The loader's artifact collection skips ordinary compilation. Even with a
    // borrow error, harvesting build scripts can succeed; it is not rustc validation.
    let mut bridge = Bridge::new(root.path(), true);
    assert_eq!(bridge.ready["result"]["proc_macro_server_running"], true);
    assert!(bridge.ready["result"]["build_script_error"].is_null());
    let expansion = bridge.query(json!({"method":"expand_macro", "path":"src/lib.rs", "byte_offset":SOURCE.find("macros::make!").unwrap()+8}));
    assert!(
        expansion["result"]["expansion"]
            .as_str()
            .unwrap()
            .contains("generated"),
        "{expansion}"
    );
    let generated = bridge.function("call_generated", SOURCE);
    assert!(
        generated["result"]["syntax_calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["resolved_function"]["name"] == "generated"),
        "{generated}"
    );
    let included = bridge.function("from_build", SOURCE);
    assert_eq!(
        included["result"]["mir"]["status"], "available",
        "{included}"
    );
    let checked = Command::new("cargo")
        .args(["check", "--locked", "--offline", "--profile", "dev-small"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!checked.status.success());
    assert!(
        String::from_utf8_lossy(&checked.stderr).contains("E0382"),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
}

#[test]
fn public_semantics_lower_locals_branches_loops_and_calls_without_upstream_changes() {
    let root = fixture();
    let extra = r#"
fn helper(value: i64) -> i64 { if value < 0 { -value } else { value } }
pub fn ordinary(mut count: u32, enabled: bool) -> i64 {
    let mut sum = 0i64;
    while count > 0 {
        count -= 1;
        if count == 3 { continue; }
        if count == 1 { break; }
        let value = count as i64;
        let value = helper(value - 2);
        if enabled && value < 100 { sum += value; }
    }
    sum
}


fn recursive(value: usize) -> usize { recursive(value) }
"#;
    let text = format!("{SOURCE}{extra}");
    std::fs::write(root.path().join("src/lib.rs"), &text).unwrap();
    let mut bridge = Bridge::new(root.path(), false);
    let lower = |bridge: &mut Bridge, name: &str| {
        bridge.query(json!({"method":"lower", "path":"src/lib.rs", "byte_offset":text.find(&format!("fn {name}(")).unwrap()+3}))
    };
    let response = lower(&mut bridge, "ordinary");
    assert_eq!(response["result"]["status"], "available", "{response}");
    let program: ash_rust_build_ir::Program =
        serde_json::from_value(response["result"]["program"].clone()).unwrap();
    ash_rust_build_ir::validate(&program).unwrap();
    assert_eq!(program.functions.len(), 2);
    assert_eq!(program.functions[1].name, "helper");
    assert!(program.functions[0].blocks.len() > 8);
    let leaf = lower(&mut bridge, "leaf");
    assert_eq!(leaf["result"]["status"], "available", "{leaf}");
    for name in ["caller", "layout", "borrow_error"] {
        let response = lower(&mut bridge, name);
        assert_eq!(
            response["result"]["status"], "unsupported",
            "{name}: {response}"
        );
    }
    let recursive = lower(&mut bridge, "recursive");
    assert_eq!(recursive["result"]["status"], "unsupported", "{recursive}");
    assert!(
        recursive["result"]["reason"]
            .as_str()
            .unwrap()
            .contains("recursive")
    );
}

#[test]
fn module_identities_and_atomic_source_batches_invalidate_cross_file_calls_and_constants() {
    let root = fixture();
    let text = "mod left; mod right; mod shared; use left::score as first;\npub fn graph(value: usize) -> usize { first(value) + right::score(value) }\n";
    let left = "pub(super) fn score(value: usize) -> usize { value + crate::shared::BIAS }\n";
    let right = "pub(super) fn score(value: usize) -> usize { value.saturating_mul(2) }\n";
    let shared = "pub(super) const BIAS: usize = 3;\n";
    for (path, source) in [
        ("src/lib.rs", text),
        ("src/left.rs", left),
        ("src/right.rs", right),
        ("src/shared.rs", shared),
    ] {
        std::fs::write(root.path().join(path), source).unwrap();
    }
    let mut bridge = Bridge::new(root.path(), false);
    let query = json!({"method":"lower", "path":"src/lib.rs", "byte_offset":text.find("fn graph").unwrap()+3});
    let first = bridge.query(query.clone());
    assert_eq!(first["result"]["status"], "available", "{first}");
    let program: ash_rust_build_ir::Program =
        serde_json::from_value(first["result"]["program"].clone()).unwrap();
    ash_rust_build_ir::validate(&program).unwrap();
    assert_eq!(program.functions.len(), 3);
    assert_eq!(program.functions[1].name, program.functions[2].name);
    assert_ne!(
        program.functions[1].source_path,
        program.functions[2].source_path
    );
    assert_eq!(program.sources.len(), 4);
    assert_eq!(program.check, ash_rust_build_ir::CheckMode::Package);
    let invalid = bridge.query(json!({"method":"change_files", "files":[{"path":"src/shared.rs","text":shared.replace("3;","8;")},{"path":"../outside.rs","text":""}]}));
    assert!(invalid.get("error").is_some());
    assert_eq!(invalid["revision"], 0);
    assert_eq!(bridge.query(query.clone())["result"], first["result"]);
    let update = bridge.query(json!({"method":"change_files", "files":[{"path":"src/shared.rs","text":shared.replace("3;","8;")},{"path":"src/right.rs","text":right.replace("mul(2)","mul(4)")}]}));
    assert_eq!(update["revision"], 1);
    let changed = bridge.query(query);
    assert_eq!(changed["result"]["status"], "available", "{changed}");
    assert_ne!(changed["result"]["program"], first["result"]["program"]);
    assert_eq!(
        std::fs::read_to_string(root.path().join("src/shared.rs")).unwrap(),
        shared
    );
}
