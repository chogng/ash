use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use ash_async_utils::CancellationToken;
use lsp_types::notification::{
    DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, DidSaveTextDocument, Exit,
    Initialized,
};
use lsp_types::request::{Initialize, Request, Shutdown};
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, InitializeParams, InitializeResult, InitializedParams,
    PositionEncodingKind, ServerCapabilities, TextDocumentContentChangeEvent,
    TextDocumentIdentifier, TextDocumentItem, Uri, VersionedTextDocumentIdentifier,
};
use tokio::io::{AsyncBufRead, AsyncReadExt, AsyncWrite, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::capability::DynamicCapabilityRegistry;
use crate::document::OpenDocument;
use crate::driver::{DriverCommand, DriverHandle, spawn_driver};
use crate::raw_client::RawClient;
use crate::{
    DocumentChange, DocumentChangeSync, DocumentSave, DocumentSaveSync, DocumentSyncPolicy,
    DocumentVersion, LanguageServerCommand, LanguageServerError, LanguageServerEvent,
    LanguageServerHost, LanguageServerOptions, LanguageServerTimeouts,
};

const STATE_STARTING: u8 = 0;
const STATE_READY: u8 = 1;
const STATE_SHUTTING_DOWN: u8 = 2;
const STATE_CLOSED: u8 = 3;

/// Immutable capability snapshot produced by a successful LSP initialize handshake.
#[derive(Clone, Debug)]
pub struct LanguageServerInitialization {
    pub server_info: Option<lsp_types::ServerInfo>,
    pub capabilities: ServerCapabilities,
    pub position_encoding: PositionEncodingKind,
    pub document_sync: DocumentSyncPolicy,
}

/// One initialized language-server session.
///
/// Clones share the same request ID sequence, document-version table, process, and lifecycle.
pub struct LanguageServerClient {
    inner: Arc<ClientInner>,
}

impl Clone for LanguageServerClient {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl LanguageServerClient {
    /// Spawn a local language server and initialize it over stdio.
    pub async fn start_stdio(
        command: LanguageServerCommand,
        options: LanguageServerOptions,
    ) -> Result<Self, LanguageServerError> {
        let mut child = command
            .into_tokio_command()
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(LanguageServerError::Start)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            LanguageServerError::Start(std::io::Error::other(
                "language server stdin was not captured",
            ))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            LanguageServerError::Start(std::io::Error::other(
                "language server stdout was not captured",
            ))
        })?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_reader(stderr, Arc::clone(&options.host));
        }
        Self::connect_inner(
            BufReader::new(stdout),
            stdin,
            options,
            Some(Arc::new(Mutex::new(Some(child)))),
        )
        .await
    }

    /// Initialize a language server over caller-provided asynchronous transport halves.
    ///
    /// This is the integration point for sandboxed process launchers and test transports.
    pub async fn connect<R, W>(
        reader: R,
        writer: W,
        options: LanguageServerOptions,
    ) -> Result<Self, LanguageServerError>
    where
        R: AsyncBufRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::connect_inner(reader, writer, options, None).await
    }

    async fn connect_inner<R, W>(
        reader: R,
        writer: W,
        options: LanguageServerOptions,
        process: Option<Arc<Mutex<Option<Child>>>>,
    ) -> Result<Self, LanguageServerError>
    where
        R: AsyncBufRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let intentional_stop = Arc::new(AtomicBool::new(false));
        let dynamic_capabilities = DynamicCapabilityRegistry::default();
        let DriverHandle { commands, task } = spawn_driver(
            reader,
            writer,
            Arc::clone(&options.host),
            Arc::clone(&intentional_stop),
            dynamic_capabilities.clone(),
        );
        let raw = RawClient::new(commands);
        #[allow(deprecated)]
        let initialize_params = InitializeParams {
            process_id: Some(std::process::id()),
            root_path: None,
            root_uri: options.root_uri,
            initialization_options: options.initialization_options,
            capabilities: options.capabilities,
            trace: None,
            workspace_folders: options.workspace_folders,
            client_info: Some(options.client_info),
            locale: options.locale,
            work_done_progress_params: Default::default(),
        };
        let initialized: InitializeResult = match raw
            .request::<Initialize>(initialize_params, options.timeouts.initialize)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                intentional_stop.store(true, Ordering::Release);
                let _ = raw.commands.send(DriverCommand::Stop).await;
                let _ = task.await;
                terminate_process(process.as_ref()).await;
                return Err(error);
            }
        };
        let position_encoding = initialized
            .capabilities
            .position_encoding
            .clone()
            .unwrap_or(PositionEncodingKind::UTF16);
        if position_encoding != PositionEncodingKind::UTF8
            && position_encoding != PositionEncodingKind::UTF16
        {
            intentional_stop.store(true, Ordering::Release);
            let _ = raw.commands.send(DriverCommand::Stop).await;
            let _ = task.await;
            terminate_process(process.as_ref()).await;
            return Err(LanguageServerError::InvalidMessage(format!(
                "unsupported position encoding `{position_encoding:?}`"
            )));
        }
        let initialization = LanguageServerInitialization {
            server_info: initialized.server_info,
            document_sync: DocumentSyncPolicy::from_capability(
                initialized.capabilities.text_document_sync.as_ref(),
            ),
            capabilities: initialized.capabilities,
            position_encoding,
        };
        if let Err(error) = raw.notify::<Initialized>(InitializedParams {}).await {
            intentional_stop.store(true, Ordering::Release);
            let _ = raw.commands.send(DriverCommand::Stop).await;
            let _ = task.await;
            terminate_process(process.as_ref()).await;
            return Err(error);
        }
        Ok(Self {
            inner: Arc::new(ClientInner {
                raw,
                initialization,
                dynamic_capabilities,
                documents: Mutex::new(HashMap::new()),
                process,
                driver_task: Mutex::new(Some(task)),
                state: AtomicU8::new(STATE_READY),
                intentional_stop,
                timeouts: options.timeouts,
            }),
        })
    }

    pub fn initialization(&self) -> &LanguageServerInitialization {
        &self.inner.initialization
    }

    /// Return the dynamic capability registrations retained for this server incarnation.
    pub fn dynamic_capabilities(&self) -> crate::LanguageServerCapabilitySnapshot {
        self.inner.dynamic_capabilities.snapshot()
    }

    /// Whether the current server incarnation dynamically registered a method.
    pub fn supports_dynamic_method(&self, method: &str) -> bool {
        self.inner.dynamic_capabilities.supports(method)
    }

    /// Send one typed LSP request using the negotiated normal-request deadline.
    pub async fn request<R>(&self, params: R::Params) -> Result<R::Result, LanguageServerError>
    where
        R: Request,
    {
        self.require_ready()?;
        self.inner
            .raw
            .request::<R>(params, self.inner.timeouts.request)
            .await
    }

    /// Send one typed LSP request and cancel its exact protocol request when the token fires.
    pub async fn request_with_cancellation<R>(
        &self,
        params: R::Params,
        cancellation: &CancellationToken,
    ) -> Result<R::Result, LanguageServerError>
    where
        R: Request,
    {
        self.require_ready()?;
        self.inner
            .raw
            .request_with_cancellation::<R>(params, self.inner.timeouts.request, cancellation)
            .await
    }

    /// Open a text document at version one.
    pub async fn open_document(
        &self,
        uri: Uri,
        language_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<DocumentVersion, LanguageServerError> {
        self.require_ready()?;
        if !self.inner.initialization.document_sync.open_close {
            return Err(LanguageServerError::UnsupportedDocumentOperation(
                "text document open/close synchronization",
            ));
        }
        let mut documents = self.inner.documents.lock().await;
        if documents.contains_key(&uri) {
            return Err(LanguageServerError::DocumentAlreadyOpen(uri.to_string()));
        }
        let version = DocumentVersion::INITIAL;
        self.inner
            .raw
            .notify::<DidOpenTextDocument>(DidOpenTextDocumentParams {
                text_document: TextDocumentItem {
                    uri: uri.clone(),
                    language_id: language_id.into(),
                    version: version.value(),
                    text: text.into(),
                },
            })
            .await?;
        documents.insert(uri, OpenDocument { version });
        Ok(version)
    }

    /// Synchronize one full or incremental document change and assign the next version.
    pub async fn change_document(
        &self,
        uri: &Uri,
        change: DocumentChange,
    ) -> Result<DocumentVersion, LanguageServerError> {
        self.require_ready()?;
        let changes = match (self.inner.initialization.document_sync.change, change) {
            (DocumentChangeSync::None, _) => {
                return Err(LanguageServerError::UnsupportedDocumentOperation(
                    "text document change synchronization",
                ));
            }
            (DocumentChangeSync::Full, DocumentChange::Incremental(_)) => {
                return Err(LanguageServerError::FullDocumentChangeRequired);
            }
            (_, DocumentChange::Full(text)) => vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text,
            }],
            (DocumentChangeSync::Incremental, DocumentChange::Incremental(changes)) => changes,
        };
        let mut documents = self.inner.documents.lock().await;
        let document = documents
            .get_mut(uri)
            .ok_or_else(|| LanguageServerError::DocumentNotOpen(uri.to_string()))?;
        let version = document.version.next()?;
        self.inner
            .raw
            .notify::<DidChangeTextDocument>(DidChangeTextDocumentParams {
                text_document: VersionedTextDocumentIdentifier {
                    uri: uri.clone(),
                    version: version.value(),
                },
                content_changes: changes,
            })
            .await?;
        document.version = version;
        Ok(version)
    }

    /// Notify the server that an open document was saved.
    pub async fn save_document(
        &self,
        uri: &Uri,
        save: DocumentSave<'_>,
    ) -> Result<(), LanguageServerError> {
        self.require_ready()?;
        let text = match (self.inner.initialization.document_sync.save, save) {
            (DocumentSaveSync::None, _) => {
                return Err(LanguageServerError::UnsupportedDocumentOperation(
                    "text document save synchronization",
                ));
            }
            (DocumentSaveSync::IncludeText, DocumentSave::WithoutText) => {
                return Err(LanguageServerError::SavedDocumentTextRequired);
            }
            (DocumentSaveSync::WithoutText, DocumentSave::WithText(_)) => {
                return Err(LanguageServerError::SavedDocumentTextNotSupported);
            }
            (DocumentSaveSync::WithoutText, DocumentSave::WithoutText) => None,
            (DocumentSaveSync::IncludeText, DocumentSave::WithText(text)) => Some(text.to_string()),
        };
        let documents = self.inner.documents.lock().await;
        if !documents.contains_key(uri) {
            return Err(LanguageServerError::DocumentNotOpen(uri.to_string()));
        }
        self.inner
            .raw
            .notify::<DidSaveTextDocument>(DidSaveTextDocumentParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                text,
            })
            .await
    }

    /// Close an open document and forget its version.
    pub async fn close_document(&self, uri: &Uri) -> Result<(), LanguageServerError> {
        self.require_ready()?;
        if !self.inner.initialization.document_sync.open_close {
            return Err(LanguageServerError::UnsupportedDocumentOperation(
                "text document open/close synchronization",
            ));
        }
        let mut documents = self.inner.documents.lock().await;
        if !documents.contains_key(uri) {
            return Err(LanguageServerError::DocumentNotOpen(uri.to_string()));
        }
        self.inner
            .raw
            .notify::<DidCloseTextDocument>(DidCloseTextDocumentParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
            })
            .await?;
        documents.remove(uri);
        Ok(())
    }

    /// Perform `shutdown`, send `exit`, stop the driver, and reap a spawned child process.
    pub async fn shutdown(&self) -> Result<(), LanguageServerError> {
        self.inner
            .state
            .compare_exchange(
                STATE_READY,
                STATE_SHUTTING_DOWN,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|state| {
                if state == STATE_CLOSED {
                    LanguageServerError::ConnectionClosed
                } else {
                    LanguageServerError::ShuttingDown
                }
            })?;
        self.inner.intentional_stop.store(true, Ordering::Release);
        let shutdown_result = self
            .inner
            .raw
            .request::<Shutdown>((), self.inner.timeouts.shutdown)
            .await;
        let _ = self.inner.raw.notify::<Exit>(()).await;
        let _ = self.inner.raw.commands.send(DriverCommand::Stop).await;
        if let Some(task) = self.inner.driver_task.lock().await.take() {
            let _ = task.await;
        }
        reap_process(self.inner.process.as_ref(), self.inner.timeouts.shutdown).await;
        self.inner.state.store(STATE_CLOSED, Ordering::Release);
        shutdown_result
    }

    /// Stop protocol work and terminate a spawned process after its transport was lost.
    ///
    /// Supervisors use this only after receiving [`LanguageServerEvent::TransportClosed`]. It
    /// deliberately skips the LSP shutdown handshake because that transport is no longer usable.
    pub async fn abort_disconnected(&self) {
        self.inner.intentional_stop.store(true, Ordering::Release);
        if self.inner.state.swap(STATE_CLOSED, Ordering::AcqRel) == STATE_CLOSED {
            return;
        }
        let _ = self.inner.raw.commands.send(DriverCommand::Stop).await;
        if let Some(task) = self.inner.driver_task.lock().await.take() {
            let _ = task.await;
        }
        terminate_process(self.inner.process.as_ref()).await;
    }

    fn require_ready(&self) -> Result<(), LanguageServerError> {
        match self.inner.state.load(Ordering::Acquire) {
            STATE_READY => Ok(()),
            STATE_STARTING => Err(LanguageServerError::NotReady),
            STATE_SHUTTING_DOWN => Err(LanguageServerError::ShuttingDown),
            _ => Err(LanguageServerError::ConnectionClosed),
        }
    }
}

struct ClientInner {
    raw: RawClient,
    initialization: LanguageServerInitialization,
    dynamic_capabilities: DynamicCapabilityRegistry,
    documents: Mutex<HashMap<Uri, OpenDocument>>,
    process: Option<Arc<Mutex<Option<Child>>>>,
    driver_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    state: AtomicU8,
    intentional_stop: Arc<AtomicBool>,
    timeouts: LanguageServerTimeouts,
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, host: Arc<dyn LanguageServerHost>) {
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0; 8 * 1024];
        while let Ok(read) = stderr.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            host.on_event(LanguageServerEvent::ServerStderr(
                String::from_utf8_lossy(&chunk[..read]).into_owned(),
            ));
        }
    });
}

async fn reap_process(process: Option<&Arc<Mutex<Option<Child>>>>, timeout: Duration) {
    let Some(process) = process else {
        return;
    };
    let mut process = process.lock().await;
    let Some(child) = process.as_mut() else {
        return;
    };
    if tokio::time::timeout(timeout, child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    process.take();
}

async fn terminate_process(process: Option<&Arc<Mutex<Option<Child>>>>) {
    let Some(process) = process else {
        return;
    };
    let mut process = process.lock().await;
    let Some(mut child) = process.take() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}
