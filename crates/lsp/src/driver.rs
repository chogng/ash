use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use lsp_types::{
    ConfigurationParams, LogMessageParams, ProgressParams, PublishDiagnosticsParams,
    RegistrationParams, ShowMessageParams, UnregistrationParams, WorkDoneProgressCreateParams,
};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};

use crate::capability::DynamicCapabilityRegistry;
use crate::event::{LanguageServerEvent, LanguageServerHost};
use crate::protocol::{
    DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_MESSAGE_BYTES, IncomingMessage, connection_closed_io,
    invalid_params_bytes, method_not_found_bytes, notification_bytes, parse_message, read_frame,
    request_bytes, result_bytes, write_frame,
};
use crate::{LanguageServerError, WorkspaceConfiguration};

pub(crate) enum DriverCommand {
    Request {
        id: i64,
        method: String,
        params: Value,
        completion: oneshot::Sender<Result<Value, LanguageServerError>>,
    },
    Notification {
        method: String,
        params: Value,
        completion: oneshot::Sender<Result<(), LanguageServerError>>,
    },
    CancelRequest {
        id: i64,
    },
    Stop,
}

pub(crate) struct DriverHandle {
    pub(crate) commands: mpsc::Sender<DriverCommand>,
    pub(crate) task: tokio::task::JoinHandle<()>,
}

pub(crate) fn spawn_driver<R, W>(
    reader: R,
    writer: W,
    host: Arc<dyn LanguageServerHost>,
    intentional_stop: Arc<AtomicBool>,
    dynamic_capabilities: DynamicCapabilityRegistry,
) -> DriverHandle
where
    R: AsyncBufRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (command_tx, command_rx) = mpsc::channel(128);
    let task = tokio::spawn(run_driver(
        reader,
        writer,
        host,
        intentional_stop,
        dynamic_capabilities,
        command_rx,
    ));
    DriverHandle {
        commands: command_tx,
        task,
    }
}

async fn run_driver<R, W>(
    mut reader: R,
    mut writer: W,
    host: Arc<dyn LanguageServerHost>,
    intentional_stop: Arc<AtomicBool>,
    dynamic_capabilities: DynamicCapabilityRegistry,
    mut commands: mpsc::Receiver<DriverCommand>,
) where
    R: AsyncBufRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (incoming_tx, mut incoming_rx) = mpsc::channel(32);
    let reader_task = tokio::spawn(async move {
        loop {
            let frame = match read_frame(
                &mut reader,
                DEFAULT_MAX_HEADER_BYTES,
                DEFAULT_MAX_MESSAGE_BYTES,
            )
            .await
            {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    let _ = incoming_tx
                        .send(Err(LanguageServerError::Transport(connection_closed_io())))
                        .await;
                    break;
                }
                Err(error) => {
                    let _ = incoming_tx.send(Err(error)).await;
                    break;
                }
            };
            let message = parse_message(&frame);
            let failed = message.is_err();
            if incoming_tx.send(message).await.is_err() || failed {
                break;
            }
        }
    });
    let mut pending = HashMap::new();
    let close_message = loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    break Some("language server client command channel closed".into());
                };
                match handle_command(command, &mut writer, &mut pending).await {
                    Ok(DriverControl::Continue) => {}
                    Ok(DriverControl::Stop) => break None,
                    Err(()) => break Some("language server transport stopped while writing a client message".into()),
                }
            }
            message = incoming_rx.recv() => {
                match message {
                    Some(Ok(message)) => {
                        if handle_incoming(message, &mut writer, &host, &dynamic_capabilities, &mut pending).await.is_err() {
                            break Some("language server transport stopped while handling a server message".into());
                        }
                    }
                    Some(Err(error)) => {
                        let message = error.to_string();
                        fail_pending(&mut pending, error);
                        break Some(message);
                    }
                    None => break Some("language server input channel closed".into()),
                }
            }
        }
    };
    reader_task.abort();
    fail_pending(&mut pending, LanguageServerError::ConnectionClosed);
    if let Some(message) = close_message
        && !intentional_stop.load(Ordering::Acquire)
    {
        host.on_event(LanguageServerEvent::TransportClosed { message });
    }
}

enum DriverControl {
    Continue,
    Stop,
}

async fn handle_command<W>(
    command: DriverCommand,
    writer: &mut W,
    pending: &mut HashMap<i64, PendingRequest>,
) -> Result<DriverControl, ()>
where
    W: AsyncWrite + Unpin,
{
    match command {
        DriverCommand::Request {
            id,
            method,
            params,
            completion,
        } => {
            let bytes = match request_bytes(id, &method, &params) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = completion.send(Err(error));
                    return Ok(DriverControl::Continue);
                }
            };
            if let Err(error) = write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES).await {
                let _ = completion.send(Err(error));
                fail_pending(pending, LanguageServerError::ConnectionClosed);
                return Err(());
            }
            pending.insert(id, PendingRequest { method, completion });
            Ok(DriverControl::Continue)
        }
        DriverCommand::Notification {
            method,
            params,
            completion,
        } => {
            let bytes = match notification_bytes(&method, &params) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = completion.send(Err(error));
                    return Ok(DriverControl::Continue);
                }
            };
            if let Err(error) = write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES).await {
                let _ = completion.send(Err(error));
                fail_pending(pending, LanguageServerError::ConnectionClosed);
                return Err(());
            }
            let _ = completion.send(Ok(()));
            Ok(DriverControl::Continue)
        }
        DriverCommand::CancelRequest { id } => {
            pending.remove(&id);
            let bytes = notification_bytes(
                "$/cancelRequest",
                &serde_json::json!({
                    "id": id,
                }),
            )
            .map_err(|_| ())?;
            write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES)
                .await
                .map_err(|_| ())?;
            Ok(DriverControl::Continue)
        }
        DriverCommand::Stop => Ok(DriverControl::Stop),
    }
}

async fn handle_incoming<W>(
    message: IncomingMessage,
    writer: &mut W,
    host: &Arc<dyn LanguageServerHost>,
    dynamic_capabilities: &DynamicCapabilityRegistry,
    pending: &mut HashMap<i64, PendingRequest>,
) -> Result<(), ()>
where
    W: AsyncWrite + Unpin,
{
    match message {
        IncomingMessage::Response { id, result } => {
            if let Some(pending) = pending.remove(&id) {
                let result = result.map_err(|error| LanguageServerError::Response {
                    method: pending.method.clone(),
                    code: error.code,
                    message: error.message,
                    data: error.data,
                });
                let _ = pending.completion.send(result);
            }
        }
        IncomingMessage::Notification { method, params } => {
            host.on_event(notification_event(method, params));
        }
        IncomingMessage::Request { id, method, params } => {
            let bytes =
                server_request_response(&id, &method, params, host.as_ref(), dynamic_capabilities)
                    .map_err(|_| ())?;
            write_frame(writer, &bytes, DEFAULT_MAX_MESSAGE_BYTES)
                .await
                .map_err(|_| ())?;
        }
    }
    Ok(())
}

fn server_request_response(
    id: &Value,
    method: &str,
    params: Value,
    host: &dyn LanguageServerHost,
    dynamic_capabilities: &DynamicCapabilityRegistry,
) -> Result<Vec<u8>, LanguageServerError> {
    match method {
        "workspace/configuration" => configuration_response(id, params, host),
        "client/registerCapability" => {
            let params = match serde_json::from_value::<RegistrationParams>(params) {
                Ok(params) => params,
                Err(error) => return invalid_params_bytes(id, &error.to_string()),
            };
            match dynamic_capabilities.register(params.registrations) {
                Ok(snapshot) => {
                    host.on_event(LanguageServerEvent::DynamicCapabilitiesChanged(snapshot));
                    result_bytes(id, &Value::Null)
                }
                Err(message) => invalid_params_bytes(id, &message),
            }
        }
        "client/unregisterCapability" => {
            let params = match serde_json::from_value::<UnregistrationParams>(params) {
                Ok(params) => params,
                Err(error) => return invalid_params_bytes(id, &error.to_string()),
            };
            match dynamic_capabilities.unregister(params.unregisterations) {
                Ok(snapshot) => {
                    host.on_event(LanguageServerEvent::DynamicCapabilitiesChanged(snapshot));
                    result_bytes(id, &Value::Null)
                }
                Err(message) => invalid_params_bytes(id, &message),
            }
        }
        "window/workDoneProgress/create" => {
            let params = match serde_json::from_value::<WorkDoneProgressCreateParams>(params) {
                Ok(params) => params,
                Err(error) => return invalid_params_bytes(id, &error.to_string()),
            };
            host.on_event(LanguageServerEvent::WorkDoneProgressCreated(params));
            result_bytes(id, &Value::Null)
        }
        _ => {
            host.on_event(LanguageServerEvent::UnsupportedServerRequest {
                method: method.to_owned(),
            });
            method_not_found_bytes(id, &format!("method not supported: {method}"))
        }
    }
}

fn configuration_response(
    id: &Value,
    params: Value,
    host: &dyn LanguageServerHost,
) -> Result<Vec<u8>, LanguageServerError> {
    let params: ConfigurationParams = serde_json::from_value(params)
        .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
    let values: Vec<Value> = host
        .workspace_configuration(&params.items)
        .into_iter()
        .map(|WorkspaceConfiguration(value)| value)
        .collect();
    if values.len() != params.items.len() {
        return Err(LanguageServerError::InvalidMessage(
            "workspace configuration result count does not match request".into(),
        ));
    }
    result_bytes(id, &Value::Array(values))
}

fn notification_event(method: String, params: Value) -> LanguageServerEvent {
    match method.as_str() {
        "textDocument/publishDiagnostics" => {
            serde_json::from_value::<PublishDiagnosticsParams>(params.clone())
                .map(LanguageServerEvent::Diagnostics)
                .unwrap_or(LanguageServerEvent::UnhandledNotification { method, params })
        }
        "window/logMessage" => serde_json::from_value::<LogMessageParams>(params.clone())
            .map(LanguageServerEvent::LogMessage)
            .unwrap_or(LanguageServerEvent::UnhandledNotification { method, params }),
        "window/showMessage" => serde_json::from_value::<ShowMessageParams>(params.clone())
            .map(LanguageServerEvent::ShowMessage)
            .unwrap_or(LanguageServerEvent::UnhandledNotification { method, params }),
        "$/progress" => serde_json::from_value::<ProgressParams>(params.clone())
            .map(LanguageServerEvent::Progress)
            .unwrap_or(LanguageServerEvent::UnhandledNotification { method, params }),
        "telemetry/event" => LanguageServerEvent::Telemetry(params),
        _ => LanguageServerEvent::UnhandledNotification { method, params },
    }
}

struct PendingRequest {
    method: String,
    completion: oneshot::Sender<Result<Value, LanguageServerError>>,
}

fn fail_pending(pending: &mut HashMap<i64, PendingRequest>, first_error: LanguageServerError) {
    let mut first_error = Some(first_error);
    for (_, request) in pending.drain() {
        let error = first_error
            .take()
            .unwrap_or(LanguageServerError::ConnectionClosed);
        let _ = request.completion.send(Err(error));
    }
}
