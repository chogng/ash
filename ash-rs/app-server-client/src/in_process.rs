use crate::AppServerClient;
use crate::ClientError;
use crate::JsonRpcTransport;
use ash_app_server::AppServer;
use ash_app_server::BuiltInSkillRoot;
use ash_app_server::ConnectionState;
use ash_app_server::LocalAppServerOptions;
use ash_app_server::LocalProductServicesConfig;
use ash_app_server::SessionStateMode;
use ash_app_server::SlashCommandCatalog;
use ash_app_server::open_local_app_server;
use ash_app_server_protocol::protocol::common::{ClientCapabilities, ClientInfo};
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_client::OperationClient;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

/// Startup inputs for an embedded App Server connection.
#[derive(Clone)]
pub struct InProcessClientOptions {
    pub profile_root: PathBuf,
    pub dir_root: Option<PathBuf>,
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
    pub slash_commands: SlashCommandCatalog,
    pub built_in_skills: BuiltInSkillRoot,
    pub session_state_mode: SessionStateMode,
    model_operation_client: Option<Arc<dyn OperationClient>>,
    product_services: Option<LocalProductServicesConfig>,
}

impl InProcessClientOptions {
    pub fn new(profile_root: impl Into<PathBuf>, client_info: ClientInfo) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root: None,
            client_info,
            capabilities: ClientCapabilities::default(),
            slash_commands: SlashCommandCatalog::default(),
            built_in_skills: BuiltInSkillRoot::AutoDetect,
            session_state_mode: SessionStateMode::Durable,
            model_operation_client: None,
            product_services: None,
        }
    }

    pub fn with_capabilities(mut self, capabilities: ClientCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    pub fn with_slash_command_catalog(mut self, slash_commands: SlashCommandCatalog) -> Self {
        self.slash_commands = slash_commands;
        self
    }

    /// Enables local filesystem and shell tools under one directory root.
    pub fn with_dir_root(mut self, dir: impl Into<PathBuf>) -> Self {
        self.dir_root = Some(dir.into());
        self
    }

    pub fn with_built_in_skill_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.built_in_skills = BuiltInSkillRoot::Explicit(root.into());
        self
    }

    pub fn without_built_in_skills(mut self) -> Self {
        self.built_in_skills = BuiltInSkillRoot::Unavailable;
        self
    }

    /// Selects whether Session and Thread event history is recovered from profile storage.
    pub fn with_session_state_mode(mut self, mode: SessionStateMode) -> Self {
        self.session_state_mode = mode;
        self
    }

    /// Replaces the production model operation client for this embedded composition.
    pub fn with_model_operation_client(mut self, client: Arc<dyn OperationClient>) -> Self {
        self.model_operation_client = Some(client);
        self
    }

    /// Installs product-pinned Marketplace roots and public Connector OAuth adapters.
    pub fn with_product_services(mut self, services: LocalProductServicesConfig) -> Self {
        self.product_services = Some(services);
        self
    }

    /// Loads the distribution-owned product services document selected for this process.
    ///
    /// Product hosts call this explicitly while composing an embedded App Server so Marketplace
    /// trust roots and public Connector adapters remain host inputs rather than hidden defaults.
    pub fn with_discovered_product_services(
        self,
    ) -> Result<Self, ash_app_server::OpenAppServerError> {
        let Some(services) = ash_app_server::load_discovered_product_services(&self.profile_root)?
        else {
            return Ok(self);
        };
        Ok(self.with_product_services(services))
    }
}

impl fmt::Debug for InProcessClientOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InProcessClientOptions")
            .field("profile_root", &self.profile_root)
            .field("dir_root", &self.dir_root)
            .field("client_info", &self.client_info)
            .field("capabilities", &self.capabilities)
            .field("slash_commands", &self.slash_commands)
            .field("built_in_skills", &self.built_in_skills)
            .field("session_state_mode", &self.session_state_mode)
            .field(
                "model_operation_client_injected",
                &self.model_operation_client.is_some(),
            )
            .field(
                "product_services_injected",
                &self.product_services.is_some(),
            )
            .finish()
    }
}

impl PartialEq for InProcessClientOptions {
    fn eq(&self, other: &Self) -> bool {
        self.profile_root == other.profile_root
            && self.dir_root == other.dir_root
            && self.client_info == other.client_info
            && self.capabilities == other.capabilities
            && self.slash_commands == other.slash_commands
            && self.built_in_skills == other.built_in_skills
            && self.session_state_mode == other.session_state_mode
            && match (&self.model_operation_client, &other.model_operation_client) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && self.product_services == other.product_services
    }
}

impl Eq for InProcessClientOptions {}

/// In-memory transport that still exercises the versioned JSON-RPC dispatcher.
pub struct InProcessTransport {
    _background: Arc<Option<queue::QueueRuntime>>,
    server: Arc<AppServer>,
    connection: ConnectionState,
    notifications: Vec<String>,
}

impl InProcessTransport {
    /// Creates an embedded transport that routes every request through the App Server dispatcher.
    ///
    /// Hosts that provide their own composition root can use this instead of the local filesystem
    /// composition used by [`start_in_process_client`].
    pub fn from_server(server: AppServer) -> Self {
        Self::from_shared_server(Arc::new(server))
    }

    /// Creates one logical connection to a shared embedded App Server composition root.
    pub fn from_shared_server(server: Arc<AppServer>) -> Self {
        let background = Arc::new(
            server
                .start_queue()
                .expect("embedded queue scheduler must start"),
        );
        Self::with_background(server, background)
    }

    fn with_background(
        server: Arc<AppServer>,
        background: Arc<Option<queue::QueueRuntime>>,
    ) -> Self {
        let connection = server.connection();
        Self {
            _background: background,
            server,
            connection,
            notifications: Vec::new(),
        }
    }

    fn from_shared_product_host(
        server: Arc<AppServer>,
        background: Arc<Option<queue::QueueRuntime>>,
    ) -> Self {
        let connection = server.product_host_connection();
        Self {
            _background: background,
            server,
            connection,
            notifications: Vec::new(),
        }
    }
}

/// Shared embedded App Server composition that can open multiple isolated logical connections.
#[derive(Clone)]
pub struct InProcessAppServer {
    background: Arc<Option<queue::QueueRuntime>>,
    pub(crate) server: Arc<AppServer>,
    pub(crate) client_info: ClientInfo,
    pub(crate) capabilities: ClientCapabilities,
}

impl InProcessAppServer {
    /// Opens and initializes one typed client connection to the shared App Server.
    pub fn connect(&self) -> Result<AppServerClient<InProcessTransport>, ClientError> {
        initialize_client(
            InProcessTransport::with_background(self.server.clone(), self.background.clone()),
            self.client_info.clone(),
            self.capabilities.clone(),
        )
    }

    fn connect_product_host(&self) -> Result<AppServerClient<InProcessTransport>, ClientError> {
        initialize_client(
            InProcessTransport::from_shared_product_host(
                self.server.clone(),
                self.background.clone(),
            ),
            self.client_info.clone(),
            self.capabilities.clone(),
        )
    }
}

impl JsonRpcTransport for InProcessTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let response = self.server.handle_json(&mut self.connection, request);
        self.notifications
            .extend(self.server.drain_notifications(&mut self.connection));
        Ok(response)
    }

    fn drain_notifications(&mut self) -> Result<Vec<String>, ClientError> {
        self.notifications
            .extend(self.server.drain_notifications(&mut self.connection));
        Ok(std::mem::take(&mut self.notifications))
    }
}

/// Opens, initializes, and schema-checks an embedded App Server client.
pub fn start_in_process_client(
    options: InProcessClientOptions,
) -> Result<AppServerClient<InProcessTransport>, ClientError> {
    open_in_process_app_server(options)?.connect_product_host()
}

/// Opens one embedded App Server composition that may serve multiple client connections.
pub fn open_in_process_app_server(
    options: InProcessClientOptions,
) -> Result<InProcessAppServer, ClientError> {
    let mut server_options = LocalAppServerOptions::new(options.profile_root)
        .with_session_state_mode(options.session_state_mode)
        .with_slash_command_catalog(options.slash_commands);
    server_options.built_in_skills = options.built_in_skills;
    if let Some(dir_root) = options.dir_root {
        server_options = server_options.with_dir_root(dir_root);
    }
    if let Some(client) = options.model_operation_client {
        server_options = server_options.with_model_operation_client(client);
    }
    if let Some(services) = options.product_services {
        server_options = server_options.with_product_services(services);
    }
    let server = open_local_app_server(server_options)
        .map_err(|error| ClientError::Transport(error.to_string()))?;
    let server = Arc::new(server);
    let background = Arc::new(server.start_queue().map_err(ClientError::Transport)?);
    Ok(InProcessAppServer {
        background,
        server,
        client_info: options.client_info,
        capabilities: options.capabilities,
    })
}

fn initialize_client(
    transport: InProcessTransport,
    client_info: ClientInfo,
    capabilities: ClientCapabilities,
) -> Result<AppServerClient<InProcessTransport>, ClientError> {
    let mut client = AppServerClient::new(transport);
    let initialized = client.initialize(InitializeParams {
        client_info,
        capabilities,
    })?;
    ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES)
        .map_err(|error| ClientError::Protocol(error.to_string()))?;
    Ok(client)
}

impl Drop for InProcessTransport {
    fn drop(&mut self) {
        self.server
            .close_connection(std::mem::take(&mut self.connection));
    }
}
