//! LLDB-specific configuration lives in this optional process. DAP execution and
//! all debugging state remain with the client's Debug domain and process broker.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use external_ext_sdk::CancellationToken;
use external_ext_sdk::Command;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::debug::Configuration;
use external_ext_sdk::debug::ConfigurationProvider;
use external_ext_sdk::debug::ConfigurationProviderTriggerKind;
use external_ext_sdk::debug::ConfigurationRequest;
use external_ext_sdk::debug::Executable;
use external_ext_sdk::debug::Request;
use external_ext_sdk::debug::ResolveConfigurationRequest;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

mod installer;

/// Prepares the identical managed runtime for development or offline deployment.
/// The caller chooses the execution environment's cache directory, not an editor workspace.
pub fn prepare_runtime(directory: PathBuf) -> Result<PathBuf, ExtensionError> {
    let messages = messages(None)?;
    if !directory.is_absolute() {
        return Err(messages.invalid_settings());
    }
    let artifact =
        installer::Artifact::current().map_err(|error| messages.install_error(&error))?;
    installer::prepare_runtime(
        &directory,
        &artifact,
        &installer::DownloadClient::default(),
        &ash_async_utils::CancellationSource::new().token(),
        &|progress| {
            let text = match progress {
                installer::Progress::Waiting => messages.waiting.clone(),
                installer::Progress::Downloading(bytes) => messages
                    .downloading
                    .replace("{0}", &format!("{:.1}", bytes as f64 / 1048576.0)),
                installer::Progress::Verifying => messages.verifying.clone(),
                installer::Progress::Unpacking => messages.unpacking.clone(),
            };
            eprintln!("{text}");
        },
    )
    .map_err(|error| messages.install_error(&error))
}

#[derive(Default)]
pub struct LldbExtension {
    installer: Option<Arc<installer::Installer>>,
}

impl Extension for LldbExtension {
    fn id(&self) -> &str {
        "ash.debug-lldb"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let messages = messages(
            context
                .initialization()
                .and_then(|facts| facts.language.as_deref()),
        )?;
        let output = context
            .window
            .create_output_channel("lldb.install", "LLDB")?;
        let status = context.window.create_status_bar("lldb.install")?;
        let installer = installer::Installer::new(status, output, messages.clone());
        self.installer = Some(Arc::clone(&installer));
        context.debug.register_configuration_provider(
            "lldb.configuration",
            "lldb-dap",
            ConfigurationProviderTriggerKind::Initial,
            LldbConfigurations {
                messages: messages.clone(),
                engine: Engine::LldbDap,
            },
        )?;
        let client = context.client.clone();
        let legacy_messages = messages.clone();
        context.debug.register_adapter_factory(
            "lldb.adapter",
            "lldb-dap",
            move |request, token| {
                token.check_cancelled()?;
                let resource = request.session.workspace_folder.map(|folder| folder.uri);
                let settings = settings(&client, resource, &token, &legacy_messages)?;
                let program = settings.adapter_path.trim();
                validate_executable(program, &settings.adapter_args, &legacy_messages)?;
                token.check_cancelled()?;
                Ok(Some(Executable {
                    program: program.into(),
                    arguments: settings.adapter_args,
                    cwd: None,
                    env: None,
                }))
            },
        )?;
        context.debug.register_configuration_provider(
            "codelldb.configuration",
            "lldb",
            ConfigurationProviderTriggerKind::Initial,
            LldbConfigurations {
                messages: messages.clone(),
                engine: Engine::CodeLldb,
            },
        )?;
        let client = context.client.clone();
        let runtime = Arc::clone(&installer);
        let adapter_messages = messages.clone();
        context.debug.register_adapter_factory(
            "codelldb.adapter",
            "lldb",
            move |request, token| {
                let settings = settings(
                    &client,
                    request.session.workspace_folder.map(|folder| folder.uri),
                    &token,
                    &adapter_messages,
                )?;
                let root = if settings.code_lldb_path.trim().is_empty() {
                    Some(settings.runtime_root(&adapter_messages)?)
                } else {
                    None
                };
                let mut arguments = settings.code_lldb_args;
                if let Some(languages) = request.configuration.properties.get("sourceLanguages") {
                    let languages: Vec<String> = serde_json::from_value(languages.clone())
                        .map_err(|_| adapter_messages.invalid_settings())?;
                    if languages.len() > 32
                        || languages
                            .iter()
                            .any(|language| language.len() > 128 || language.contains('\0'))
                    {
                        return Err(adapter_messages.invalid_settings());
                    }
                    arguments.extend([
                        "--settings".into(),
                        json!({ "sourceLanguages": languages }).to_string(),
                    ]);
                }
                let configured = settings.code_lldb_path.trim();
                validate_executable(
                    if configured.is_empty() {
                        "codelldb"
                    } else {
                        configured
                    },
                    &arguments,
                    &adapter_messages,
                )?;
                let program = match root {
                    Some(root) => runtime.ensure(root, &token)?.to_string_lossy().into_owned(),
                    None => configured.into(),
                };
                token.check_cancelled()?;
                Ok(Some(Executable {
                    program,
                    arguments,
                    cwd: None,
                    env: None,
                }))
            },
        )?;
        let client = context.client.clone();
        let runtime = Arc::clone(&installer);
        let install_messages = messages.clone();
        context.commands.register_command(
            Command::new(installer::INSTALL_COMMAND, messages.install_command.clone()),
            move |_, token| {
                let settings = settings(&client, None, &token, &install_messages)?;
                runtime
                    .start(settings.runtime_root(&install_messages)?)
                    .map_err(|error| install_messages.install_error(&error))?;
                Ok(Value::Null)
            },
        )?;
        context.commands.register_command(
            Command::new(installer::CANCEL_COMMAND, messages.cancel_command.clone()),
            move |_, token| {
                token.check_cancelled()?;
                installer.cancel();
                Ok(Value::Null)
            },
        )
    }

    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        if let Some(installer) = self.installer.take() {
            installer.shutdown();
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
struct Messages {
    #[serde(rename = "configuration.launch")]
    launch: String,
    #[serde(rename = "error.adapterSettings")]
    adapter_settings: String,
    #[serde(rename = "error.program")]
    program: String,
    #[serde(rename = "configuration.codelldbLaunch")]
    codelldb_launch: String,
    #[serde(rename = "command.install")]
    install_command: String,
    #[serde(rename = "command.cancel")]
    cancel_command: String,
    #[serde(rename = "progress.waiting")]
    waiting: String,
    #[serde(rename = "progress.downloading")]
    downloading: String,
    #[serde(rename = "progress.verifying")]
    verifying: String,
    #[serde(rename = "progress.unpacking")]
    unpacking: String,
    #[serde(rename = "progress.cancelHint")]
    cancel_hint: String,
    #[serde(rename = "progress.installed")]
    installed: String,
    #[serde(rename = "progress.cancelled")]
    cancelled: String,
    #[serde(rename = "progress.retry")]
    retry: String,
    #[serde(rename = "error.install")]
    install: String,
    #[serde(rename = "error.integrity")]
    integrity: String,
    #[serde(rename = "error.unsupported")]
    unsupported: String,
    #[serde(rename = "error.busy")]
    busy: String,
}

fn messages(language: Option<&str>) -> Result<Messages, ExtensionError> {
    serde_json::from_str(if language == Some("zh-CN") {
        include_str!("../package.nls.zh-CN.json")
    } else {
        include_str!("../package.nls.json")
    })
    .map_err(|_| ExtensionError::new(HostErrorCode::ActivationFailed, "invalid LLDB localization"))
}

impl Messages {
    fn invalid_settings(&self) -> ExtensionError {
        ExtensionError::new(HostErrorCode::InvalidRequest, self.adapter_settings.clone())
    }

    fn install_error(&self, error: &installer::InstallError) -> ExtensionError {
        let (code, message) = match error {
            installer::InstallError::Cancelled => {
                (HostErrorCode::Cancelled, self.cancelled.clone())
            }
            installer::InstallError::Unsupported => {
                (HostErrorCode::InvalidRequest, self.unsupported.clone())
            }
            installer::InstallError::Busy => (HostErrorCode::InvalidRequest, self.busy.clone()),
            installer::InstallError::Integrity => (HostErrorCode::Internal, self.integrity.clone()),
            installer::InstallError::Failed(detail) => {
                (HostErrorCode::Internal, self.install.replace("{0}", detail))
            }
        };
        ExtensionError::new(code, message)
    }
}

fn settings(
    client: &external_ext_sdk::client::Client,
    resource: Option<String>,
    token: &CancellationToken,
    messages: &Messages,
) -> Result<AdapterSettings, ExtensionError> {
    serde_json::from_value(client.get_configuration("debug.lldb", resource, token)?)
        .map_err(|_| messages.invalid_settings())
}

fn validate_executable(
    program: &str,
    arguments: &[String],
    messages: &Messages,
) -> Result<(), ExtensionError> {
    if program.is_empty()
        || program.len() > 32768
        || program.contains('\0')
        || arguments.len() > 256
        || arguments
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
    {
        return Err(messages.invalid_settings());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct AdapterSettings {
    adapter_path: String,
    adapter_args: Vec<String>,
    code_lldb_path: String,
    code_lldb_args: Vec<String>,
    runtime_directory: String,
}

impl Default for AdapterSettings {
    fn default() -> Self {
        Self {
            adapter_path: format!("lldb-dap{}", std::env::consts::EXE_SUFFIX),
            adapter_args: Vec::new(),
            code_lldb_path: String::new(),
            code_lldb_args: Vec::new(),
            runtime_directory: String::new(),
        }
    }
}

impl AdapterSettings {
    fn runtime_root(&self, messages: &Messages) -> Result<PathBuf, ExtensionError> {
        let root = if self.runtime_directory.is_empty() {
            dirs::cache_dir()
                .ok_or_else(|| messages.invalid_settings())?
                .join("ash")
                .join("debug-adapters")
                .join("codelldb")
        } else {
            PathBuf::from(&self.runtime_directory)
        };
        if !root.is_absolute()
            || self.runtime_directory.len() > 32768
            || self.runtime_directory.contains('\0')
        {
            return Err(messages.invalid_settings());
        }
        Ok(root)
    }
}

#[derive(Clone, Copy)]
enum Engine {
    LldbDap,
    CodeLldb,
}

struct LldbConfigurations {
    messages: Messages,
    engine: Engine,
}

impl ConfigurationProvider for LldbConfigurations {
    fn provide_configurations(
        &self,
        _request: ConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Vec<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        let (name, debugger_type) = match self.engine {
            Engine::LldbDap => (&self.messages.launch, "lldb-dap"),
            Engine::CodeLldb => (&self.messages.codelldb_launch, "lldb"),
        };
        let mut properties = BTreeMap::from([
            (
                "program".into(),
                json!(format!(
                    "${{workspaceFolder}}/target/debug/${{workspaceFolderBasename}}{}",
                    std::env::consts::EXE_SUFFIX
                )),
            ),
            ("cwd".into(), json!("${workspaceFolder}")),
            ("args".into(), json!([])),
            ("stopOnEntry".into(), json!(false)),
        ]);
        if matches!(self.engine, Engine::CodeLldb) {
            properties.insert("sourceLanguages".into(), json!(["rust"]));
        }
        Ok(vec![Configuration {
            name: name.clone(),
            debugger_type: debugger_type.into(),
            request: Request::Launch,
            properties,
        }])
    }

    fn resolve_configuration(
        &self,
        request: ResolveConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Option<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        let mut configuration = request.configuration;
        let custom_launch = match self.engine {
            Engine::LldbDap => "launchCommands",
            Engine::CodeLldb => "processCreateCommands",
        };
        if configuration.request == Request::Launch
            && !configuration.properties.contains_key(custom_launch)
            && !configuration
                .properties
                .get("program")
                .and_then(Value::as_str)
                .is_some_and(|program| !program.trim().is_empty() && !program.contains('\0'))
        {
            return Err(ExtensionError::new(
                HostErrorCode::InvalidRequest,
                self.messages.program.clone(),
            ));
        }
        if request.folder.is_some() {
            configuration
                .properties
                .entry("cwd".into())
                .or_insert(json!("${workspaceFolder}"));
        }
        Ok(Some(configuration))
    }
}
