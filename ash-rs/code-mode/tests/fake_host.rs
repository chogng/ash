use ash_code_mode_protocol::CODE_MODE_PROTOCOL_VERSION;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::ClientToHost;
use ash_code_mode_protocol::HostFrame;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::StartedCell;
use ash_code_mode_protocol::read_frame;
use ash_code_mode_protocol::write_frame;
use std::collections::BTreeMap;
use std::io;
use std::io::BufReader;
use std::io::BufWriter;
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut reader = BufReader::new(io::stdin().lock());
    let mut writer = BufWriter::new(io::stdout().lock());
    let executable = std::env::current_exe()?;
    let mode = executable.file_stem().and_then(|name| name.to_str());
    if mode == Some("recording-host") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(executable.with_extension("starts"))?;
        writeln!(file, "{}", std::process::id())?;
    }
    if matches!(mode, Some("silent-host" | "partial-host")) {
        std::fs::write(
            executable.with_extension("pid"),
            std::process::id().to_string(),
        )?;
        let _ = read_frame::<_, HostFrame<ClientToHost>>(&mut reader)?;
        if mode == Some("partial-host") {
            writer.write_all(&100_u32.to_le_bytes())?;
            writer.write_all(b"{")?;
            writer.flush()?;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
        return Ok(());
    }

    let mut snapshots = BTreeMap::new();
    let mut cells = BTreeMap::new();
    let mut next_cell = 0;
    loop {
        let frame = read_frame::<_, HostFrame<ClientToHost>>(&mut reader)?;
        let request_id = frame.request_id;
        let reply = match frame.message {
            ClientToHost::Hello { protocol_version }
                if protocol_version == CODE_MODE_PROTOCOL_VERSION =>
            {
                HostToClient::Hello {
                    protocol_version,
                    max_frame_bytes: ash_code_mode_protocol::MAX_FRAME_BYTES,
                }
            }
            ClientToHost::OpenSession {
                session_id,
                stored_values,
                ..
            } => {
                snapshots.insert(session_id.clone(), stored_values);
                HostToClient::SessionOpened { session_id }
            }
            ClientToHost::Execute(request) => {
                next_cell += 1;
                let cell_id = CellId::new(format!("fake-cell-{}-{next_cell}", request.session_id))?;
                cells.insert(cell_id.clone(), (request.session_id, request.source));
                HostToClient::StartedCell(StartedCell { cell_id })
            }
            ClientToHost::Wait(request) => {
                let (session_id, source) = cells.remove(&request.cell_id).expect("known cell");
                let values = snapshots.get_mut(&session_id).expect("open session");
                match source.as_str() {
                    "snapshot" => {
                        values.insert("answer".into(), serde_json::json!(42));
                        values.insert("deleted".into(), serde_json::json!(true));
                    }
                    "delete" => {
                        values.remove("deleted");
                    }
                    "oversized" => {
                        values.insert(
                            "oversized".into(),
                            serde_json::json!("x".repeat(16 * 1024 * 1024)),
                        );
                    }
                    "inspect" => {}
                    _ => std::process::exit(17),
                }
                write_frame(
                    &mut writer,
                    &HostFrame {
                        request_id: None,
                        message: HostToClient::StoreSnapshot {
                            session_id,
                            values: values.clone(),
                        },
                    },
                )?;
                HostToClient::Response {
                    response: RuntimeResponse::Result {
                        cell_id: request.cell_id,
                        content_items: vec![OutputItem::Text {
                            text: serde_json::to_string(values)?,
                        }],
                        error_text: None,
                    },
                }
            }
            ClientToHost::Terminate { .. } => std::process::exit(17),
            ClientToHost::CloseSession { session_id } => {
                snapshots.remove(&session_id);
                cells.retain(|_, (owner, _)| owner != &session_id);
                HostToClient::SessionClosed { session_id }
            }
            ClientToHost::CompleteToolCall { .. } | ClientToHost::Hello { .. } => continue,
        };
        write_frame(
            &mut writer,
            &HostFrame {
                request_id,
                message: reply,
            },
        )?;
    }
}
