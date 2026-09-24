use std::collections::VecDeque;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

const STATE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ScenarioServer {
    address: std::net::SocketAddr,
    state: Arc<Mutex<ServerState>>,
    thread: Option<thread::JoinHandle<()>>,
}

struct ServerState {
    requests: Vec<String>,
}

impl ScenarioServer {
    pub fn start(responses: impl IntoIterator<Item = HttpResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            requests: Vec::new(),
        }));
        let thread_state = Arc::clone(&state);
        let mut responses = responses.into_iter().collect::<VecDeque<_>>();
        let server_thread = thread::spawn(move || {
            while let Some(response) = responses.pop_front() {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                thread_state.lock().unwrap().requests.push(request);
                response.write_to(&mut stream);
            }
        });
        Self {
            address,
            state,
            thread: Some(server_thread),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}/v1", self.address)
    }

    pub fn request_count(&self) -> usize {
        self.state.lock().unwrap().requests.len()
    }

    pub fn request_bodies(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }
}

impl Drop for ScenarioServer {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take()
            && thread.is_finished()
        {
            thread.join().unwrap();
        }
    }
}

pub enum HttpResponse {
    Streaming {
        events: Vec<Vec<u8>>,
        gate: Option<Gate>,
    },
    Failure {
        status: u16,
        body: Vec<u8>,
    },
}

impl HttpResponse {
    pub fn responses_streaming(text: &str) -> Self {
        let delta = serde_json::json!({
            "type": "response.output_text.delta",
            "delta": text,
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{"type": "output_text", "text": text}],
                }],
            },
        });
        Self::Streaming {
            events: vec![
                format!("event: response.output_text.delta\ndata: {delta}\n\n").into_bytes(),
                format!("event: response.completed\ndata: {completed}\n\n").into_bytes(),
            ],
            gate: None,
        }
    }

    pub fn streaming(parts: impl IntoIterator<Item = impl AsRef<str>>, gate: Option<Gate>) -> Self {
        let mut events = parts
            .into_iter()
            .map(|part| {
                format!(
                    "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\n",
                    serde_json::to_string(part.as_ref()).unwrap()
                )
                .into_bytes()
            })
            .collect::<Vec<_>>();
        events.push(
            b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}\n\n"
                .to_vec(),
        );
        events.push(b"data: [DONE]\n\n".to_vec());
        Self::Streaming { events, gate }
    }

    pub fn failure(status: u16, marker: &str) -> Self {
        Self::Failure {
            status,
            body: serde_json::json!({"error": {"message": marker}})
                .to_string()
                .into_bytes(),
        }
    }

    pub fn tool_call(id: &str, name: &str, arguments: serde_json::Value) -> Self {
        let event = serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments.to_string(),
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7},
        });
        Self::Streaming {
            events: vec![
                format!("data: {event}\n\n").into_bytes(),
                b"data: [DONE]\n\n".to_vec(),
            ],
            gate: None,
        }
    }

    #[cfg(unix)]
    pub fn reasoning_tool_call(
        reasoning: &str,
        id: &str,
        name: &str,
        arguments: serde_json::Value,
    ) -> Self {
        let reasoning = serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {"reasoning_content": reasoning},
                "finish_reason": null,
            }],
        });
        let tool_call = serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments.to_string(),
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7},
        });
        Self::Streaming {
            events: vec![
                format!("data: {reasoning}\n\n").into_bytes(),
                format!("data: {tool_call}\n\n").into_bytes(),
                b"data: [DONE]\n\n".to_vec(),
            ],
            gate: None,
        }
    }

    fn write_to(self, stream: &mut TcpStream) {
        match self {
            Self::Streaming { events, gate } => {
                let length = events.iter().map(Vec::len).sum::<usize>();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                for (index, event) in events.into_iter().enumerate() {
                    if stream.write_all(&event).is_err() || stream.flush().is_err() {
                        return;
                    }
                    if index == 0
                        && let Some(gate) = &gate
                    {
                        gate.reach_and_wait();
                    }
                }
            }
            Self::Failure { status, body } => {
                write!(
                    stream,
                    "HTTP/1.1 {status} Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
                stream.flush().unwrap();
            }
        }
    }
}

#[derive(Clone)]
pub struct Gate(Arc<(Mutex<GateState>, Condvar)>);

struct GateState {
    reached: bool,
    released: bool,
}

impl Gate {
    pub fn new() -> Self {
        Self(Arc::new((
            Mutex::new(GateState {
                reached: false,
                released: false,
            }),
            Condvar::new(),
        )))
    }

    fn reach_and_wait(&self) {
        let (lock, changed) = &*self.0;
        let mut state = lock.lock().unwrap();
        state.reached = true;
        changed.notify_all();
        while !state.released {
            state = changed.wait(state).unwrap();
        }
    }

    pub fn wait_until_reached(&self) {
        let (lock, changed) = &*self.0;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, STATE_TIMEOUT, |state| !state.reached)
            .unwrap();
        assert!(state.reached, "HTTP stream did not reach its gate");
        assert!(!timeout.timed_out(), "HTTP stream gate timed out");
    }

    pub fn release(&self) {
        let (lock, changed) = &*self.0;
        lock.lock().unwrap().released = true;
        changed.notify_all();
    }
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream.set_read_timeout(Some(STATE_TIMEOUT)).unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8_192];
    let header_end = loop {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "HTTP client disconnected before sending headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "HTTP client disconnected before sending its body");
        bytes.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}
