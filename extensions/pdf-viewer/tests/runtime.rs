//! Exercise the executable's shared SDK transport, localization and request validation.
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
fn resource_provider_registers_localizes_rejects_invalid_requests_and_shuts_down() {
    let mut runtime = Runtime(
        Command::new(env!("CARGO_BIN_EXE_ash-pdf-viewer"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("extension process"),
    );
    let initialized = runtime.request(
        1,
        "initialize",
        json!({"extensionId":"ash.pdf-viewer","runtimeApiVersion":1}),
    );
    assert_eq!(initialized["status"], "success", "{initialized}");
    let activated = runtime.request(2, "activate", json!({
        "extensionId":"ash.pdf-viewer", "runtimeApiVersion":1,
        "package":{"packageId":"ash.pdf-viewer@1.0.0","packageDigest":format!("sha256:{}", "a".repeat(64)),"entrypoint":"ash-pdf-viewer"},
        "activationEvents":["onStartupFinished"],"capabilities":["dataChannel"],
        "initialization":{"language":"en","workspaceFolders":[],"workspaceName":null,"workspaceFile":null,"configurationValues":{},"configurationData":{}}
    }));
    assert_eq!(activated["status"], "success", "{activated}");
    assert_eq!(
        activated["body"]["body"]["registrations"],
        json!([{
            "registrationId":"editor.resource.v1", "kind":"dataChannel", "channelId":"editor.resource.v1"
        }])
    );
    let invoke = |payload| json!({"extensionId":"ash.pdf-viewer","registrationId":"editor.resource.v1","operation":"receiveData","payload":payload,"deadlineUnixMillis":u64::MAX});
    for (id, language, expected) in [
        (3, "en", "PDF Reader"),
        (4, "zh-CN", "PDF 阅读器"),
        (5, "fr", "PDF Reader"),
    ] {
        let described = runtime.request(
            id,
            "invoke",
            invoke(json!({"operation":"describe","language":language})),
        );
        assert_eq!(described["status"], "success", "{described}");
        assert_eq!(
            described["body"]["body"]["payload"],
            json!({
                "version":1,"clientModule":"dist/editor.js",
                "clientDigest":env!("ASH_EDITOR_CLIENT_DIGEST"),
                "editors":[{
                    "editorId":"ash.workbench.pdfViewer", "displayName":expected,
                    "selectors":["*.pdf"], "contentType":"application/pdf"
                }]
            })
        );
    }
    for (index, payload) in [
        json!({"operation":"describe","language":"en","unknown":true}),
        json!({"operation":"writeDocument","language":"en"}),
        json!({"operation":"describe","language":""}),
        json!({"operation":"describe","language":"a".repeat(65)}),
        json!({"operation":"describe"}),
        json!({"operation":"describe","language":42}),
    ]
    .into_iter()
    .enumerate()
    {
        let invalid = runtime.request(6 + index as u32, "invoke", invoke(payload));
        assert_ne!(invalid["status"], "success", "{invalid}");
    }
    let shutdown = runtime.request(12, "shutdown", Value::Null);
    assert_eq!(shutdown["status"], "success", "{shutdown}");
    assert!(runtime.0.wait().expect("extension exit").success());
}
