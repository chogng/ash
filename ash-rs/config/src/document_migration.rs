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
use ash_model_provider_config::ModelProviderConfig;
use ash_protocol::ProviderId;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub(crate) const CURRENT_FILE_SCHEMA_VERSION: i64 = 3;
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
    let rewrite_required = match version {
        None => {
            migrate_unversioned(root)?;
            remove_issue_workflow(root);
            migrate_agent_model_names(root)?;
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
            version != CURRENT_FILE_SCHEMA_VERSION
        }
        Some(_) => {
            return Err(ConfigError(
                "user configuration schemaVersion must be an integer".into(),
            ));
        }
    };
    let document = value
        .try_into::<UserConfigDocument>()
        .map_err(|error| ConfigError(error.to_string()))?;
    document.validate()?;
    Ok(DecodedDocument {
        document,
        rewrite_required,
    })
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
    _providers: BTreeMap<ProviderId, ModelProviderConfig>,
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
    serde_json::from_value(value)
        .map_err(|error| ConfigError(format!("invalid legacy config document: {error}")))
}
