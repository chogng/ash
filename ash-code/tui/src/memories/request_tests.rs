use super::*;
use ash_app_server_client::ClientError;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct Transport {
    responses: VecDeque<Value>,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        let id = request["id"].clone();
        self.requests.lock().unwrap().push(request);
        Ok(json!({"jsonrpc":"2.0","id":id,"result":self.responses.pop_front().expect("unexpected request")}).to_string())
    }
}

#[test]
fn search_consumes_excerpts_and_cursors_without_reading_each_memory() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(Transport {
        requests: requests.clone(),
        responses: VecDeque::from([json!({
            "catalogRevision": 5,
            "matches": [{"source":"user","citation":{"memoryId":"entry","scope":{"type":"profile"},"revision":1,"startByte":0,"endByte":8},"memoryId":"entry","scope":{"type":"profile"},"revision":1,"title":"Decision","excerpt":"Use Rust","updatedAtUnixMs":0}],
            "nextCursor":"next"
        })]),
    });
    let result = execute(
        &mut client,
        None,
        Command::Browse {
            scope: MemoryScope::Profile,
            query: "Rust".into(),
            cursor: None,
            loaded: 1,
        },
    )
    .unwrap();
    let Event::Finished {
        result: Ok(Page::List(list)),
        ..
    } = result
    else {
        panic!("search result");
    };
    assert_eq!(list.entries[0].excerpt, "Use Rust");
    assert_eq!(list.cursor.as_deref(), Some("next"));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "memory/search");
    assert_eq!(requests[0]["params"]["query"], "Rust");
}

#[test]
fn refreshing_a_loaded_list_follows_fresh_cursors_to_restore_its_length() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let pages = (0..3).map(|i| json!({
        "catalogRevision": 7,
        "memories": [{"memoryId":format!("entry-{i}"),"scope":{"type":"profile"},"revision":1,"title":format!("Decision {i}"),"source":"user","createdAtUnixMs":0,"updatedAtUnixMs":0}],
        "nextCursor":if i < 2 {Some(format!("page-{}",i+1))} else {None}
    })).collect();
    let mut client = AppServerClient::new(Transport {
        responses: pages,
        requests: requests.clone(),
    });
    let result = execute(
        &mut client,
        None,
        Command::Browse {
            scope: MemoryScope::Profile,
            query: String::new(),
            cursor: None,
            loaded: 3,
        },
    )
    .unwrap();
    let Event::Finished {
        result: Ok(Page::List(list)),
        ..
    } = result
    else {
        panic!("list result");
    };
    assert_eq!(list.entries.len(), 3);
    assert_eq!(list.revision, 7);
    assert!(list.cursor.is_none());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        requests
            .iter()
            .all(|request| request["method"] == "memory/list")
    );
    assert_eq!(requests[1]["params"]["cursor"], "page-1");
    assert_eq!(requests[2]["params"]["cursor"], "page-2");
}
