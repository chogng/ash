use ash_code_mode_protocol::CellOutcome;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::WaitOutcome;
use ash_code_mode_protocol::write_frame;
use ash_code_mode_runtime::CodeModeRuntime;
use ash_code_mode_runtime::RuntimeError;
use std::io;
use std::io::BufWriter;
use std::sync::Mutex;

pub(super) fn send(
    writer: &Mutex<BufWriter<io::Stdout>>,
    message: HostToClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("Host output writer was poisoned"))?;
    write_frame(&mut *writer, &message)?;
    Ok(())
}

pub(super) fn send_wait_result(
    writer: &Mutex<BufWriter<io::Stdout>>,
    runtime: &CodeModeRuntime,
    result: Result<WaitOutcome, RuntimeError>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Acquire the transport before taking a snapshot. Concurrent observations must
    // not publish an older snapshot after a newer one or interleave result frames.
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("Host output writer was poisoned"))?;
    let message = match result {
        Ok(WaitOutcome::LiveCell { response }) => {
            let values = match runtime.store_snapshot() {
                Ok(values) => values,
                Err(error) => {
                    write_frame(
                        &mut *writer,
                        &HostToClient::Error {
                            message: error.to_string(),
                        },
                    )?;
                    return Ok(());
                }
            };
            let terminal = match &response {
                RuntimeResponse::Result {
                    cell_id,
                    error_text,
                    ..
                } => Some((
                    cell_id.clone(),
                    if error_text.is_some() {
                        CellOutcome::Failed
                    } else {
                        CellOutcome::Completed
                    },
                )),
                RuntimeResponse::Terminated { cell_id, .. } => {
                    Some((cell_id.clone(), CellOutcome::Terminated))
                }
                RuntimeResponse::Unknown { cell_id, .. } => {
                    Some((cell_id.clone(), CellOutcome::Unknown))
                }
                RuntimeResponse::Running { .. } | RuntimeResponse::Yielded { .. } => None,
            };
            write_frame(
                &mut *writer,
                &HostToClient::StoreSnapshot {
                    session_id: runtime.session_id().clone(),
                    values,
                },
            )?;
            write_frame(&mut *writer, &HostToClient::Response { response })?;
            if let Some((cell_id, outcome)) = terminal {
                write_frame(&mut *writer, &HostToClient::CellClosed { cell_id, outcome })?;
            }
            return Ok(());
        }
        Ok(WaitOutcome::MissingCell { cell_id }) => HostToClient::Error {
            message: format!("Code Mode cell not found: {cell_id}"),
        },
        Err(error) => HostToClient::Error {
            message: error.to_string(),
        },
    };
    write_frame(&mut *writer, &message)?;
    Ok(())
}
