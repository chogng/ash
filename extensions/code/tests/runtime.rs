//! Exercise the packaged SDK entrypoint, including language and protocol failures.
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;

struct Runtime(Child);

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Runtime {
    fn request(&mut self, id: u32, method: &str, params: Value) -> Value {
        let message = json!({"protocolVersion":1,"requestId":id,"incarnation":1,
            "activationGeneration":1,"method":method,"params":params});
        writeln!(self.0.stdin.as_mut().expect("stdin"), "{message}").expect("request");
        let mut line = String::new();
        BufReader::new(self.0.stdout.as_mut().expect("stdout"))
            .read_line(&mut line)
            .expect("response");
        serde_json::from_str(&line).expect("JSON response")
    }
}

#[test]
fn independent_provider_registers_features_and_rejects_unknown_requests() {
    for language in ["en", "zh-CN"] {
        let mut runtime = Runtime(
            Command::new(env!("CARGO_BIN_EXE_ash-code-editor"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("extension process"),
        );
        let initialized = runtime.request(
            1,
            "initialize",
            json!({"extensionId":"ash.code","runtimeApiVersion":1}),
        );
        assert_eq!(initialized["status"], "success");
        let activated = runtime.request(2, "activate", json!({
            "extensionId":"ash.code", "runtimeApiVersion":1,
            "package":{"packageId":"ash.code@1.0.0","packageDigest":format!("sha256:{}", "a".repeat(64)),"entrypoint":"ash-code-editor"},
            "activationEvents":["onStartupFinished"],"capabilities":["dataChannel"],
            "initialization":{"language":language,"workspaceFolders":[],"workspaceName":null,"workspaceFile":null,"configurationValues":{},"configurationData":{}}
        }));
        assert_eq!(activated["status"], "success", "{activated}");
        assert_eq!(
            activated["body"]["body"]["registrations"],
            json!([{
                "registrationId":"editor.contributions.v1", "kind":"dataChannel", "channelId":"editor.contributions.v1"
            }])
        );
        let invoke = |payload| json!({"extensionId":"ash.code","registrationId":"editor.contributions.v1","operation":"receiveData","payload":payload,"deadlineUnixMillis":u64::MAX});
        let described = runtime.request(
            3,
            "invoke",
            invoke(json!({"operation":"describe","language":language})),
        );
        assert_eq!(described["status"], "success", "{described}");
        assert_eq!(
            described["body"]["body"]["payload"],
            json!({
                "version":1,"clientModule":"browser/editor.ts", "clientDigest":env!("ASH_EDITOR_CLIENT_DIGEST")
            })
        );
        let invalid = runtime.request(
            4,
            "invoke",
            invoke(json!({"operation":"describe","unknown":true})),
        );
        assert_ne!(invalid["status"], "success", "{invalid}");
        let invalid = runtime.request(5, "invoke", invoke(json!({"operation":"writeDocument"})));
        assert_ne!(invalid["status"], "success", "{invalid}");
        assert_eq!(
            runtime.request(6, "shutdown", Value::Null)["status"],
            "success"
        );
    }
}
