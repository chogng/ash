use super::*;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use std::sync::Arc;
use std::sync::Mutex;

struct Transport {
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    fail_first_turn: bool,
}
impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        let result = match request["method"].as_str().unwrap() {
            "session/create" => serde_json::json!({
                "session":{"sessionId":"root","title":"Issues","status":"active","threads":[{"threadId":"root","title":"Issues","status":"active","createdAtUnixMs":0}]},
                "agentTree":{"roots":[{"threadId":"root","threadSequence":1,"title":"Issues","executionStatus":"idle","usage":ash_protocol::ModelUsageSummary::default()}]}
            }),
            "session/request" => {
                if self.fail_first_turn {
                    self.fail_first_turn = false;
                    return Err(ClientError::Transport("disconnected".into()));
                }
                serde_json::to_value(
                    ash_app_server_protocol::protocol::session::SessionRequestResult::Turn(
                        ash_app_server_protocol::protocol::turn::TurnStartResult {
                            turn_id: ash_protocol::TurnId::new("turn").unwrap(),
                            sequence: 3,
                        },
                    ),
                )
                .unwrap()
            }
            unexpected => panic!("Issue startup must use generic Session APIs: {unexpected}"),
        };
        Ok(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
    }
}

#[test]
fn issue_start_selects_the_root_role_and_retries_the_same_initial_input() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(Transport {
        requests: requests.clone(),
        fail_first_turn: true,
    });
    let command = Command::Start {
        generation: 1,
        command_id: ash_protocol::CommandId::new("start-issues").unwrap(),
        repository: Repository {
            host: "github.com".into(),
            owner: "team".into(),
            name: "repo".into(),
        },
        numbers: vec![3, 5],
    };
    assert!(start_session(&mut client, command.clone()).is_err());
    assert_eq!(
        start_session(&mut client, command).unwrap().as_str(),
        "root"
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0]["params"], requests[2]["params"]);
    assert_eq!(requests[1]["params"], requests[3]["params"]);
    assert_eq!(
        requests[0]["params"]["agent"],
        serde_json::json!({"type":"exact","source":{"type":"builtIn"},"name":"issue"})
    );
    assert_eq!(
        requests[1]["params"]["commandId"],
        "start-issues:first-turn"
    );
    let input = requests[1]["params"]["request"]["input"][0]["text"]
        .as_str()
        .unwrap();
    assert!(input.contains("https://github.com/team/repo/issues/3"));
    assert!(input.contains("https://github.com/team/repo/issues/5"));
}
