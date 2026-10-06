use crate::CodebaseAutomaticContext;
use crate::CodebaseConfig;
use crate::CodebaseModelSelection;
use crate::ConfigError;
use crate::DirPermissionsConfig;
use crate::UserConfigDocument;
use ash_file_access::Dir;
use ash_file_access::DirId;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub(crate) const CURRENT_FILE_SCHEMA_VERSION: i64 = 10;
// Raise this only when the product support window no longer includes the removed versions.
const MIN_SUPPORTED_FILE_SCHEMA_VERSION: i64 = 1;

struct UnversionedMigration {
    #[cfg(test)]
    name: &'static str,
    #[cfg(test)]
    remove_when_minimum_schema_version_reaches: i64,
    apply: fn(&mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError>,
}

macro_rules! declare_unversioned_migrations {
    ($(($name:literal, $remove_when_minimum_reaches:literal, $apply:path)),* $(,)?) => {
        const UNVERSIONED_MIGRATIONS: &[UnversionedMigration] = &[
            $(UnversionedMigration {
                #[cfg(test)]
                name: $name,
                #[cfg(test)]
                remove_when_minimum_schema_version_reaches: $remove_when_minimum_reaches,
                apply: $apply,
            }),*
        ];

        $(const _: () = assert!(
            MIN_SUPPORTED_FILE_SCHEMA_VERSION < $remove_when_minimum_reaches,
            concat!("remove expired user configuration migration: ", $name)
        );)*
    };
}

declare_unversioned_migrations!(
    (
        "semanticCodeIndex -> codebase",
        2,
        migrate_semantic_code_index
    ),
    (
        "workspaceTrust -> dirPermissions",
        2,
        migrate_workspace_trust
    ),
);

pub(crate) struct DecodedDocument {
    pub(crate) document: UserConfigDocument,
    pub(crate) rewrite_required: bool,
}

pub(crate) fn decode(source: &str) -> Result<DecodedDocument, ConfigError> {
    let mut value =
        toml::from_str::<toml::Value>(source).map_err(|error| ConfigError(error.to_string()))?;
    let root = value
        .as_table_mut()
        .ok_or_else(|| ConfigError("user configuration root must be a TOML table".into()))?;
    let version = root.remove("schemaVersion");
    let migrate_subscription =
        !matches!(version.as_ref(), Some(toml::Value::Integer(v)) if *v >= 6);
    let migrate_glm = !matches!(version.as_ref(), Some(toml::Value::Integer(v)) if *v >= 8);
    let migrate_acceleration =
        !matches!(version.as_ref(), Some(toml::Value::Integer(v)) if *v >= 9);
    let migrate_context = !matches!(version.as_ref(), Some(toml::Value::Integer(v)) if *v >= 10);
    let obsolete_selection = root.remove("activeConnections").is_some();
    let rewrite_required = (match version {
        None => {
            migrate_unversioned(root)?;
            remove_issue_workflow(root);
            migrate_agent_model_names(root)?;
            migrate_grep_backend(root);
            migrate_grep_owner(root)?;
            true
        }
        Some(toml::Value::Integer(version)) => {
            validate_version(version)?;
            if version < 2 {
                remove_issue_workflow(root);
            }
            if version < 3 {
                migrate_agent_model_names(root)?;
            }
            if version < 4 {
                migrate_grep_backend(root);
            }
            if version < 5 {
                migrate_grep_owner(root)?;
            }
            version != CURRENT_FILE_SCHEMA_VERSION
        }
        Some(_) => {
            return Err(ConfigError(
                "user configuration schemaVersion must be an integer".into(),
            ));
        }
    }) || obsolete_selection;
    if rewrite_required {
        migrate_connections(root)?;
        if migrate_glm {
            migrate_glm_identity(root)?;
        }
        for key in [
            "agent",
            "gui",
            "tui",
            "desktop",
            "codebase",
            "toolSearch",
            "commitMessages",
        ] {
            if let Some(value) = root.get_mut(key) {
                migrate_model_references(value);
            }
        }
    }
    if migrate_acceleration {
        migrate_fast_models(root)?;
    }
    if migrate_context {
        migrate_long_context(root)?;
    }
    let mut document = value
        .try_into::<UserConfigDocument>()
        .map_err(|error| ConfigError(error.to_string()))?;
    if migrate_subscription {
        migrate_subscription_models(&mut document);
    }
    document.validate()?;
    Ok(DecodedDocument {
        document,
        rewrite_required,
    })
}

/// This is a one-way file-schema migration. Normal readers never interpret the old boolean
/// list; an unknown mapping or conflicting target leaves the user's file untouched.
fn migrate_fast_models(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    let Some(connections) = root
        .get_mut("connections")
        .and_then(toml::Value::as_table_mut)
    else {
        return Ok(());
    };
    for (connection, value) in connections {
        let config = value
            .as_table_mut()
            .ok_or_else(|| ConfigError("connection must be a table".into()))?;
        let Some(legacy) = config.remove("fastModels") else {
            continue;
        };
        let models = legacy
            .try_into::<Vec<ash_protocol::ModelId>>()
            .map_err(|error| ConfigError(error.to_string()))?;
        let provider = config
            .get("provider")
            .and_then(toml::Value::as_str)
            .ok_or_else(|| ConfigError(format!("connection {connection} requires a provider")))?;
        let provider = ash_protocol::ProviderId::new(provider)
            .map_err(|error| ConfigError(error.to_string()))?;
        let mut migrated = toml::map::Map::new();
        for model in models {
            let option = model_provider_info::find_static_model(&ModelRef::new(provider.clone(), model.clone()))
                .and_then(|spec| spec.model().settings.acceleration.as_ref().map(ash_protocol::ModelAcceleration::id))
                .ok_or_else(|| ConfigError(format!("cannot migrate Fast preference for {connection}/{model}: no declared acceleration")))?;
            migrated.insert(model.to_string(), toml::Value::String(option));
        }
        let target = config
            .entry("modelAcceleration")
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
            .as_table_mut()
            .ok_or_else(|| ConfigError("modelAcceleration must be a table".into()))?;
        for (model, option) in migrated {
            if target.get(&model).is_some_and(|current| current != &option) {
                return Err(ConfigError(format!(
                    "conflicting acceleration preferences for {connection}/{model}"
                )));
            }
            target.insert(model, option);
        }
    }
    Ok(())
}

/// Only the former picker presets become booleans. Manual budgets and custom connections
/// retain their token counts, and compaction settings remain in the same model record.
fn migrate_long_context(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    let Some(connections) = root
        .get_mut("connections")
        .and_then(toml::Value::as_table_mut)
    else {
        return Ok(());
    };
    for (connection, value) in connections {
        let Some(config) = value.as_table_mut() else {
            continue;
        };
        if config.contains_key("custom") {
            continue;
        }
        let Some(provider) = config.get("provider").and_then(toml::Value::as_str) else {
            continue;
        };
        let provider = ProviderId::new(provider).map_err(|error| ConfigError(error.to_string()))?;
        let Some(contexts) = config
            .get_mut("modelContext")
            .and_then(toml::Value::as_table_mut)
        else {
            continue;
        };
        for (model, value) in contexts {
            let id = ash_protocol::ModelId::new(model)
                .map_err(|error| ConfigError(error.to_string()))?;
            let Some(spec) =
                model_provider_info::find_static_model(&ModelRef::new(provider.clone(), id))
            else {
                continue;
            };
            let (
                ash_protocol::ContextWindow::Known(default),
                ash_protocol::ContextWindow::Known(maximum),
            ) = (spec.context_window, spec.max_context_window)
            else {
                continue;
            };
            if maximum <= default {
                continue;
            }
            let Some(context) = value.as_table_mut() else {
                continue;
            };
            let enabled = match context
                .get("contextWindow")
                .and_then(toml::Value::as_integer)
            {
                Some(window) if window == i64::from(default) => false,
                Some(1_000_000) => true,
                _ => continue,
            };
            if context.contains_key("longContext") {
                return Err(ConfigError(format!(
                    "conflicting context preferences for {connection}/{model}"
                )));
            }
            context.remove("contextWindow");
            context.insert("longContext".into(), toml::Value::Boolean(enabled));
        }
    }
    Ok(())
}

fn migrate_glm_identity(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    if let Some(connections) = root
        .get_mut("connections")
        .and_then(toml::Value::as_table_mut)
    {
        for id in ["bigmodel", "bigmodel-coding-plan", "zai", "zai-coding-plan"] {
            if let Some(config) = connections.get_mut(id).and_then(toml::Value::as_table_mut) {
                config.insert("provider".into(), toml::Value::String("glm".into()));
            }
        }
    }
    Ok(())
}

pub(crate) fn encode(document: &UserConfigDocument) -> Result<String, ConfigError> {
    document.validate()?;
    let value = toml::Value::try_from(document).map_err(|error| ConfigError(error.to_string()))?;
    let fields = value
        .as_table()
        .ok_or_else(|| ConfigError("user configuration did not serialize as a table".into()))?;
    let mut root = toml::map::Map::new();
    root.insert(
        "schemaVersion".into(),
        toml::Value::Integer(CURRENT_FILE_SCHEMA_VERSION),
    );
    root.extend(fields.clone());
    toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|error| ConfigError(error.to_string()))
}

fn migrate_connections(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    let Some(providers) = root.remove("providers") else {
        return Ok(());
    };
    if root.contains_key("connections") {
        return Err(ConfigError(
            "configuration mixes legacy providers and connections".into(),
        ));
    }
    let mut connections = providers
        .as_table()
        .cloned()
        .ok_or_else(|| ConfigError("providers must be a table".into()))?;
    for (id, value) in &mut connections {
        let connection = ash_protocol::ModelConnectionId::new(id.clone())
            .map_err(|error| ConfigError(error.to_string()))?;
        let provider = model_provider_info::connection_provider(&connection);
        let config = value
            .as_table_mut()
            .ok_or_else(|| ConfigError("connection must be a table".into()))?;
        config.insert("connection".into(), toml::Value::String(id.clone()));
        config.insert("provider".into(), toml::Value::String(provider.to_string()));
    }
    root.insert("connections".into(), toml::Value::Table(connections));
    for key in ["agent", "gui", "tui", "desktop"] {
        if let Some(value) = root.get_mut(key) {
            migrate_model_references(value);
        }
    }
    Ok(())
}

fn migrate_model_references(value: &mut toml::Value) {
    match value {
        toml::Value::Table(table) => {
            if table.get("model").is_some_and(toml::Value::is_str) {
                if let Some(toml::Value::String(provider)) = table.get_mut("provider") {
                    if let Some(current) = model_provider_info::legacy_model_providers()
                        .iter()
                        .find_map(|(old, current)| (old.as_str() == provider).then_some(current))
                    {
                        *provider = current.to_string();
                    }
                }
            }
            for (_, value) in table.iter_mut() {
                migrate_model_references(value);
            }
        }
        toml::Value::Array(values) => {
            for value in values.iter_mut() {
                migrate_model_references(value);
            }
            // Favorites can contain the same model through several former GLM service IDs.
            // Keep the first position, without removing duplicates from unrelated user arrays.
            let mut models = std::collections::BTreeSet::new();
            values.retain(|value| {
                let Some(provider) = value.get("provider").and_then(toml::Value::as_str) else {
                    return true;
                };
                let Some(model) = value.get("model").and_then(toml::Value::as_str) else {
                    return true;
                };
                models.insert((provider.to_owned(), model.to_owned()))
            });
        }
        _ => {}
    }
}

fn migrate_subscription_models(document: &mut UserConfigDocument) {
    let old = ProviderId::new("xai-subscription").expect("legacy provider ID");
    let current = ProviderId::new("xai").expect("built-in provider ID");
    let migrate = |model: &mut ModelRef| {
        if model.provider == old {
            model.provider = current.clone();
        }
    };
    if let Some(model) = &mut document.agent.model {
        migrate(model);
    }
    if let crate::ApprovalReviewModelSelection::Explicit { model, .. } =
        &mut document.agent.approval_review_model
    {
        migrate(model);
    }
    if let Some(model) = &mut document.agent.commit_message_model {
        migrate(model);
    }
    if let Some(advisor) = &mut document.agent.advisor {
        migrate(&mut advisor.model);
    }
    if let Some(models) = &mut document.codebase.models {
        migrate(&mut models.embedding_model);
        if let Some(model) = &mut models.rerank_model {
            migrate(model);
        }
    }
    if let Some(model) = &mut document.tool_search.embedding_model {
        migrate(model);
    }
    // An egress grant binds both the old model identity and its old provider
    // configuration. Require a fresh authorization for the new identity.
    document
        .commit_messages
        .source_egress_grants
        .retain(|_, grant| grant.model.provider != old);
}

fn migrate_grep_backend(root: &mut toml::map::Map<String, toml::Value>) {
    if let Some(value) = root
        .get_mut("agent")
        .and_then(toml::Value::as_table_mut)
        .and_then(|a| a.get_mut("grepBackend"))
    {
        if value.as_str() == Some("fastRegex") {
            *value = toml::Value::String("tgrep".into());
        }
    }
}

fn migrate_grep_owner(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    let old = root
        .get_mut("agent")
        .and_then(toml::Value::as_table_mut)
        .and_then(|a| a.remove("grepBackend"));
    if let Some(backend) = old {
        if root.contains_key("grep") {
            return Err(ConfigError(
                "configuration contains both agent.grepBackend and grep".into(),
            ));
        }
        let mut grep = toml::map::Map::new();
        grep.insert("backend".into(), backend);
        root.insert("grep".into(), toml::Value::Table(grep));
    }
    Ok(())
}

fn validate_version(version: i64) -> Result<(), ConfigError> {
    if version > CURRENT_FILE_SCHEMA_VERSION {
        return Err(ConfigError(format!(
            "user configuration schema version {version} is newer than supported version {CURRENT_FILE_SCHEMA_VERSION}"
        )));
    }
    if version < MIN_SUPPORTED_FILE_SCHEMA_VERSION {
        return Err(ConfigError(format!(
            "user configuration schema version {version} is older than minimum supported version {MIN_SUPPORTED_FILE_SCHEMA_VERSION}"
        )));
    }
    Ok(())
}

fn migrate_unversioned(root: &mut toml::map::Map<String, toml::Value>) -> Result<(), ConfigError> {
    for migration in UNVERSIONED_MIGRATIONS {
        (migration.apply)(root)?;
    }
    Ok(())
}

fn migrate_agent_model_names(
    root: &mut toml::map::Map<String, toml::Value>,
) -> Result<(), ConfigError> {
    let Some(toml::Value::Table(agent)) = root.get_mut("agent") else {
        return Ok(());
    };
    for (old, new) in [
        ("preferredModel", "model"),
        ("preferredReasoningEffort", "modelReasoningEffort"),
    ] {
        if agent.contains_key(old) && agent.contains_key(new) {
            return Err(ConfigError(format!(
                "user configuration contains both agent.{old} and agent.{new}"
            )));
        }
        if let Some(value) = agent.remove(old) {
            agent.insert(new.into(), value);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn expired_migrations() -> Vec<&'static str> {
    UNVERSIONED_MIGRATIONS
        .iter()
        .filter(|migration| {
            MIN_SUPPORTED_FILE_SCHEMA_VERSION
                >= migration.remove_when_minimum_schema_version_reaches
        })
        .map(|migration| migration.name)
        .collect()
}

fn migrate_semantic_code_index(
    root: &mut toml::map::Map<String, toml::Value>,
) -> Result<(), ConfigError> {
    let Some(value) = root.remove("semanticCodeIndex") else {
        return Ok(());
    };
    if root.contains_key("codebase") {
        return Err(ConfigError(
            "user configuration contains both semanticCodeIndex and codebase".into(),
        ));
    }
    let legacy = value
        .try_into::<LegacySemanticCodeIndexConfig>()
        .map_err(|error| ConfigError(format!("invalid semanticCodeIndex: {error}")))?;
    let LegacySemanticCodeIndexConfig {
        selection,
        automatic_context,
        _source_egress_grants: _,
    } = legacy;
    let models = match selection {
        LegacySemanticCodeIndexSelection::Disabled => None,
        LegacySemanticCodeIndexSelection::Remote { models } => Some(models),
    };
    let codebase = CodebaseConfig {
        models,
        automatic_context,
    };
    let codebase =
        toml::Value::try_from(codebase).map_err(|error| ConfigError(error.to_string()))?;
    root.insert("codebase".into(), codebase);
    Ok(())
}

fn migrate_workspace_trust(
    root: &mut toml::map::Map<String, toml::Value>,
) -> Result<(), ConfigError> {
    let Some(value) = root.remove("workspaceTrust") else {
        return Ok(());
    };
    if root.contains_key("dirPermissions") {
        return Err(ConfigError(
            "user configuration contains both workspaceTrust and dirPermissions".into(),
        ));
    }
    let legacy = value
        .try_into::<LegacyWorkspaceTrustConfig>()
        .map_err(|error| ConfigError(format!("invalid workspaceTrust: {error}")))?;
    let mut config = DirPermissionsConfig::default();
    for (legacy_id, setting) in legacy.roots {
        if setting != LegacyWorkspaceTrustSetting::Trusted {
            continue;
        }
        let Some(path) = legacy.root_paths.get(&legacy_id) else {
            continue;
        };
        let Ok(dir) = Dir::open_local(path) else {
            continue;
        };
        if legacy_id_for_path(dir.canonical_path()) != legacy_id.to_string() {
            continue;
        }
        let id = dir.id();
        config.entries.insert(id.clone(), trusted_permissions());
        config.paths.insert(id, dir.canonical_path().to_path_buf());
    }
    let permissions =
        toml::Value::try_from(config).map_err(|error| ConfigError(error.to_string()))?;
    root.insert("dirPermissions".into(), permissions);
    Ok(())
}

fn trusted_permissions() -> Permissions {
    Permissions::new([
        Permission::ReadFiles,
        Permission::WriteFiles,
        Permission::ExecuteCommands,
        Permission::WatchFiles,
        Permission::BrowseFiles,
        Permission::SearchFiles,
        Permission::LoadInstructions,
        Permission::LoadConfig,
        Permission::DiscoverSkills,
        Permission::DiscoverMcp,
        Permission::UseLanguageServices,
        Permission::DiscoverHooks,
        Permission::DiscoverPlugins,
        Permission::InspectRepository,
        Permission::MutateRepository,
    ])
}

pub(crate) fn legacy_id_for_path(path: &Path) -> String {
    let mut digest = Sha256::new();
    hash_legacy_platform_path(&mut digest, path);
    format!("sha256:{:x}", digest.finalize())
}

#[cfg(unix)]
fn hash_legacy_platform_path(digest: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;

    digest.update(b"unix\0");
    digest.update(path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn hash_legacy_platform_path(digest: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;

    digest.update(b"windows\0");
    for code_unit in path.as_os_str().encode_wide() {
        digest.update(code_unit.to_le_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn hash_legacy_platform_path(digest: &mut Sha256, path: &Path) {
    digest.update(b"other\0");
    digest.update(path.as_os_str().to_string_lossy().as_bytes());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySemanticCodeIndexConfig {
    #[serde(default)]
    selection: LegacySemanticCodeIndexSelection,
    #[serde(default)]
    automatic_context: CodebaseAutomaticContext,
    #[serde(default, rename = "sourceEgressGrants")]
    _source_egress_grants: BTreeMap<DirId, LegacySemanticCodeIndexEgressGrant>,
}

#[derive(Default, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
enum LegacySemanticCodeIndexSelection {
    #[default]
    Disabled,
    Remote {
        models: CodebaseModelSelection,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySemanticCodeIndexEgressGrant {
    #[serde(rename = "models")]
    _models: CodebaseModelSelection,
    #[serde(rename = "providers")]
    _providers: BTreeMap<ProviderId, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyWorkspaceTrustConfig {
    #[serde(default)]
    roots: BTreeMap<DirId, LegacyWorkspaceTrustSetting>,
    #[serde(default)]
    root_paths: BTreeMap<DirId, PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum LegacyWorkspaceTrustSetting {
    #[default]
    Restricted,
    Trusted,
}

const REMOVED_ISSUE_FIELDS: &[&str] = &["repositories", "recommendMerge", "analysisModel"];

fn remove_issue_workflow(root: &mut toml::map::Map<String, toml::Value>) {
    if let Some(issues) = root.get_mut("issues").and_then(toml::Value::as_table_mut) {
        for field in REMOVED_ISSUE_FIELDS {
            issues.remove(*field);
        }
    }
}

pub(crate) fn decode_legacy_json(source: &str) -> Result<UserConfigDocument, ConfigError> {
    let mut value: serde_json::Value = serde_json::from_str(source)
        .map_err(|error| ConfigError(format!("invalid legacy config document: {error}")))?;
    if let Some(issues) = value
        .get_mut("issues")
        .and_then(serde_json::Value::as_object_mut)
    {
        for field in REMOVED_ISSUE_FIELDS {
            issues.remove(*field);
        }
    }
    if let Some(backend) = value
        .get_mut("agent")
        .and_then(|agent| agent.get_mut("grepBackend"))
    {
        if backend.as_str() == Some("fastRegex") {
            *backend = serde_json::Value::String("tgrep".into());
        }
    }
    let old = value
        .get_mut("agent")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|agent| agent.remove("grepBackend"));
    if let Some(backend) = old {
        let root = value
            .as_object_mut()
            .ok_or_else(|| ConfigError("invalid legacy configuration".into()))?;
        if root.contains_key("grep") {
            return Err(ConfigError(
                "configuration contains both agent.grepBackend and grep".into(),
            ));
        }
        root.insert("grep".into(), serde_json::json!({"backend": backend}));
    }
    // Old SQLite authorities use JSON. Remove absent optional values before passing the same
    // structural migration through TOML; both stores must produce identical selections.
    fn remove_nulls(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                fields.retain(|_, value| !value.is_null());
                for value in fields.values_mut() {
                    remove_nulls(value);
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    remove_nulls(value);
                }
            }
            _ => {}
        }
    }
    remove_nulls(&mut value);
    let source = toml::to_string(&value).map_err(|error| ConfigError(error.to_string()))?;
    Ok(decode(&source)?.document)
}
