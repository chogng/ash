use std::collections::BTreeMap;
use std::io::BufRead;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::thread::JoinHandle;

use external_ext_protocol::ExtensionHostRequest;
use external_ext_protocol::ExtensionHostResponse;
use external_ext_protocol::HostEventContext;
use external_ext_protocol::HostFailure;
use external_ext_protocol::HostRequestKind;
use external_ext_protocol::HostResponseKind;
use external_ext_protocol::HostSuccess;
use external_ext_protocol::InitializeResult;
use external_ext_protocol::InvokeParams;
use external_ext_protocol::InvokeResult;
use external_ext_protocol::PROTOCOL_VERSION;
use external_ext_protocol::ProtocolError;
use external_ext_protocol::ProtocolLimits;
use external_ext_protocol::RequestContext;
use external_ext_protocol::read_frame;
use external_ext_protocol::write_frame;
use serde::Serialize;

use crate::CancelReason;
use crate::CancellationToken;
use crate::Commands;
use crate::Extension;
use crate::ExtensionContext;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;
use crate::languages::Languages;
use crate::window::Window;

const RUNTIME_API_VERSION: u16 = 1;

/// SDK transport quotas. These must fit the host's quotas; they do not change process permissions.
#[derive(Clone, Copy, Debug)]
pub struct RuntimeOptions {
    pub protocol: ProtocolLimits,
    pub maximum_in_flight_requests: usize,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            protocol: ProtocolLimits::default(),
            maximum_in_flight_requests: 32,
        }
    }
}

/// Fatal transport or lifecycle failure. Callback errors instead return a typed host response.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("extension callback thread failed")]
    CallbackThread,
    #[error("extension runtime configuration is invalid")]
    InvalidOptions,
    #[error(transparent)]
    Extension(#[from] ExtensionError),
}

#[derive(Clone)]
pub(crate) struct Writer {
    stream: Arc<Mutex<Box<dyn Write + Send>>>,
    maximum_bytes: usize,
}

impl Writer {
    pub(crate) fn write(&self, value: &impl Serialize) -> Result<(), ProtocolError> {
        let mut stream = self.stream.lock().map_err(|_| {
            ProtocolError::InvalidProtocol("extension output writer is poisoned".into())
        })?;
        write_frame(&mut *stream, value, self.maximum_bytes)
    }
}

struct Invocation {
    token: CancellationToken,
    thread: JoinHandle<Result<(), RuntimeError>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    New,
    Initialized,
    Active,
}

struct Runtime<E> {
    client: crate::client::Client,
    extension: E,
    writer: Writer,
    options: RuntimeOptions,
    phase: Phase,
    fence: Option<HostEventContext>,
    context: Option<ExtensionContext>,
    registrations: BTreeMap<String, Registration>,
    invocations: BTreeMap<u64, Invocation>,
}

/// Runs a standalone extension over its dedicated stdin/stdout pipes.
///
/// stdout is reserved for protocol traffic. Diagnostics must use stderr or an Output channel.
/// Invocation callbacks run on separate threads so cancel, ping, and shutdown remain serviceable.
pub fn run_stdio(extension: impl Extension) -> Result<(), RuntimeError> {
    run_stdio_with_options(extension, RuntimeOptions::default())
}

/// Runs an extension with explicit transport and concurrency quotas within the host's limits.
pub fn run_stdio_with_options(
    extension: impl Extension,
    options: RuntimeOptions,
) -> Result<(), RuntimeError> {
    run(
        extension,
        std::io::stdin().lock(),
        std::io::stdout(),
        options,
    )
}

fn run<E: Extension>(
    extension: E,
    mut reader: impl BufRead,
    writer: impl Write + Send + 'static,
    options: RuntimeOptions,
) -> Result<(), RuntimeError> {
    if options.maximum_in_flight_requests == 0
        || options.protocol.maximum_frame_bytes == 0
        || options.protocol.maximum_payload_bytes == 0
        || options.protocol.maximum_registrations == 0
        || options.protocol.maximum_payload_bytes > options.protocol.maximum_frame_bytes
    {
        return Err(RuntimeError::InvalidOptions);
    }
    let writer = Writer {
        stream: Arc::new(Mutex::new(Box::new(writer))),
        maximum_bytes: options.protocol.maximum_frame_bytes,
    };
    let mut runtime = Runtime {
        client: crate::client::Client::new(writer.clone(), options.maximum_in_flight_requests),
        extension,
        writer,
        options,
        phase: Phase::New,
        fence: None,
        context: None,
        registrations: BTreeMap::new(),
        invocations: BTreeMap::new(),
    };
    let result = (|| {
        while let Some(bytes) = read_frame(&mut reader, options.protocol.maximum_frame_bytes)
            .map_err(ProtocolError::InvalidProtocol)?
        {
            runtime.reap_finished()?;
            let frame: external_ext_protocol::ExtensionHostStdinFrame =
                serde_json::from_slice(&bytes)
                    .map_err(|error| ProtocolError::InvalidProtocol(error.to_string()))?;
            let request = match frame {
                external_ext_protocol::ExtensionHostStdinFrame::Request(request) => request,
                external_ext_protocol::ExtensionHostStdinFrame::ClientResponse(response) => {
                    runtime.client.respond(response)?;
                    continue;
                }
            };
            request.validate(&options.protocol)?;
            let shutdown = matches!(request.request, HostRequestKind::Shutdown);
            runtime.dispatch(request)?;
            if shutdown {
                break;
            }
        }
        Ok(())
    })();
    // EOF and malformed input end the activation just as explicit shutdown does.
    // Join cooperative work before releasing Output handles or extension-owned resources.
    runtime.client.close();
    let cleanup = runtime.deactivate();
    result.and(cleanup)
}

impl<E: Extension> Runtime<E> {
    fn dispatch(&mut self, request: ExtensionHostRequest) -> Result<(), RuntimeError> {
        let fence = HostEventContext::new(
            request.context.incarnation,
            request.context.activation_generation,
        );
        if self.fence.is_some_and(|current| current != fence) {
            return Err(ProtocolError::InvalidProtocol(
                "request belongs to a different activation".into(),
            )
            .into());
        }
        let outcome = match &request.request {
            HostRequestKind::Initialize(params) => {
                if self.phase != Phase::New {
                    Err(ExtensionError::invalid_request(
                        "extension is already initialized",
                    ))
                } else if params.extension_id != self.extension.id() {
                    Err(ExtensionError::invalid_request(
                        "extension identity does not match its entry point",
                    ))
                } else if params.runtime_api_version != RUNTIME_API_VERSION {
                    Err(ExtensionError::new(
                        HostErrorCode::UnsupportedRuntimeApiVersion,
                        "unsupported extension runtime API version",
                    ))
                } else {
                    self.fence = Some(fence);
                    self.phase = Phase::Initialized;
                    Ok(HostSuccess::Initialized(InitializeResult {
                        protocol_version: PROTOCOL_VERSION,
                        runtime_api_version: RUNTIME_API_VERSION,
                    }))
                }
            }
            HostRequestKind::Activate(params) => {
                if self.phase != Phase::Initialized {
                    Err(ExtensionError::invalid_request(
                        "activation requires an initialized extension",
                    ))
                } else if params.extension_id != self.extension.id()
                    || params.runtime_api_version != RUNTIME_API_VERSION
                {
                    Err(ExtensionError::new(
                        HostErrorCode::ActivationFailed,
                        "activation identity or API version does not match",
                    ))
                } else {
                    let mut context = ExtensionContext {
                        client: self.client.clone(),
                        commands: Commands::default(),
                        languages: Languages::default(),
                        window: Window::new(self.writer.clone(), fence, self.options.protocol),
                        activation: params.clone(),
                    };
                    let activated = self
                        .extension
                        .activate(&mut context)
                        .and_then(|()| context.registrations());
                    match activated {
                        Ok(registrations) => {
                            let success =
                                HostSuccess::Activated(ExtensionContext::result(&registrations));
                            let response = ExtensionHostResponse {
                                context: request.context,
                                response: HostResponseKind::Success(success.clone()),
                            };
                            if response
                                .validate_for(&request, &self.options.protocol)
                                .is_err()
                            {
                                let deactivated = self.extension.deactivate();
                                let disposed = context.window.dispose();
                                deactivated?;
                                disposed?;
                                Err(ExtensionError::new(
                                    HostErrorCode::ActivationFailed,
                                    "extension registrations exceed the activation contract",
                                ))
                            } else {
                                self.context = Some(context);
                                self.registrations = registrations;
                                self.phase = Phase::Active;
                                Ok(success)
                            }
                        }
                        Err(error) => {
                            let deactivated = self.extension.deactivate();
                            let disposed = context.window.dispose();
                            deactivated?;
                            disposed?;
                            Err(error)
                        }
                    }
                }
            }
            HostRequestKind::Invoke(params) => {
                self.invoke(request.context, params.clone())?;
                return Ok(());
            }
            HostRequestKind::Cancel(params) => {
                if self.phase != Phase::Active {
                    Err(ExtensionError::invalid_request(
                        "cancel requires an active extension",
                    ))
                } else {
                    if let Some(invocation) = self.invocations.get(&params.target_request_id) {
                        invocation.token.cancel(params.reason);
                    }
                    Ok(HostSuccess::Cancelled)
                }
            }
            HostRequestKind::Ping => {
                if self.phase == Phase::New {
                    Err(ExtensionError::invalid_request(
                        "ping requires initialization",
                    ))
                } else {
                    Ok(HostSuccess::Pong)
                }
            }
            HostRequestKind::Deactivate => {
                self.deactivate()?;
                Ok(HostSuccess::Deactivated)
            }
            HostRequestKind::Shutdown => {
                self.deactivate()?;
                Ok(HostSuccess::Shutdown)
            }
        };
        self.respond(&request, outcome)
    }

    fn respond(
        &self,
        request: &ExtensionHostRequest,
        outcome: Result<HostSuccess, ExtensionError>,
    ) -> Result<(), RuntimeError> {
        let response = ExtensionHostResponse {
            context: request.context,
            response: response_kind(outcome),
        };
        response.validate_for(request, &self.options.protocol)?;
        self.writer.write(&response)?;
        Ok(())
    }

    fn invoke(
        &mut self,
        context: RequestContext,
        params: InvokeParams,
    ) -> Result<(), RuntimeError> {
        let request = ExtensionHostRequest {
            context,
            request: HostRequestKind::Invoke(params.clone()),
        };
        let registration = self.registrations.get(&params.registration_id).cloned();
        let failure = if self.phase != Phase::Active || params.extension_id != self.extension.id() {
            Some(ExtensionError::invalid_request(
                "invocation requires its active extension",
            ))
        } else if self.invocations.contains_key(&context.request_id) {
            return Err(ProtocolError::InvalidProtocol(
                "in-flight request identity was reused".into(),
            )
            .into());
        } else if self.invocations.len() >= self.options.maximum_in_flight_requests {
            Some(ExtensionError::new(
                HostErrorCode::QuotaExceeded,
                "too many in-flight invocations",
            ))
        } else {
            match &registration {
                None => Some(ExtensionError::new(
                    HostErrorCode::RegistrationNotFound,
                    "registration not found",
                )),
                Some(registration) if registration.operation != params.operation => {
                    Some(ExtensionError::new(
                        HostErrorCode::OperationNotSupported,
                        "operation is not supported by this registration",
                    ))
                }
                Some(_) => None,
            }
        };
        if let Some(error) = failure {
            return self.respond(&request, Err(error));
        }
        let registration = registration.expect("registration was checked before dispatch");
        let token = CancellationToken::new(params.deadline_unix_millis, context);
        let callback_token = token.clone();
        let writer = self.writer.clone();
        let limits = self.options.protocol;
        let thread = thread::Builder::new()
            .name(format!("ash-extension-invoke-{}", context.request_id))
            .spawn(move || {
                let result = callback_token
                    .check_cancelled()
                    .and_then(|()| (registration.handler)(params.payload, callback_token.clone()))
                    .map(|payload| HostSuccess::Invoked(InvokeResult { payload }));
                callback_token.cancel(CancelReason::Shutdown);
                let response = ExtensionHostResponse {
                    context,
                    response: response_kind(result),
                };
                response.validate_for(&request, &limits)?;
                writer.write(&response)?;
                Ok(())
            })
            .map_err(ProtocolError::Transport)?;
        self.invocations
            .insert(context.request_id, Invocation { token, thread });
        Ok(())
    }

    fn reap_finished(&mut self) -> Result<(), RuntimeError> {
        let finished: Vec<_> = self
            .invocations
            .iter()
            .filter(|(_, invocation)| invocation.thread.is_finished())
            .map(|(id, _)| *id)
            .collect();
        for id in finished {
            self.invocations
                .remove(&id)
                .expect("finished invocation is present")
                .thread
                .join()
                .map_err(|_| RuntimeError::CallbackThread)??;
        }
        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), RuntimeError> {
        let mut outcome = Ok(());
        for invocation in self.invocations.values() {
            invocation.token.cancel(CancelReason::Shutdown);
        }
        for (_, invocation) in std::mem::take(&mut self.invocations) {
            let joined = invocation
                .thread
                .join()
                .map_err(|_| RuntimeError::CallbackThread)
                .and_then(|result| result);
            outcome = outcome.and(joined);
        }
        if self.phase == Phase::Active {
            self.registrations.clear();
            let result = self.extension.deactivate();
            let disposed = self
                .context
                .take()
                .expect("active extension has a context")
                .window
                .dispose();
            self.phase = Phase::Initialized;
            outcome = outcome.and(result.map_err(RuntimeError::Extension));
            outcome = outcome.and(disposed.map_err(RuntimeError::Extension));
        }
        outcome
    }
}

fn response_kind(outcome: Result<HostSuccess, ExtensionError>) -> HostResponseKind {
    match outcome {
        Ok(success) => HostResponseKind::Success(success),
        Err(error) => HostResponseKind::Failure(HostFailure::from(error)),
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
