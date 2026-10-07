use file_system::FileSystem;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorDeclaration {
    pub schema_version: u32,
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub authentication: Option<String>,
    #[serde(default, rename = "provider")]
    _provider: Option<String>,
    pub mcp_server: Option<String>,
}

/// Loads one capability declaration through its owning execution filesystem.
/// The filesystem owns path confinement; the caller binds this declaration to its verified package.
pub fn load_connector_declaration(
    files: &dyn FileSystem,
    path: &Path,
) -> Result<ConnectorDeclaration, String> {
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Connector declaration path must be relative to its package".into());
    }
    let bytes = files
        .read_file(path, 64 * 1024)
        .map_err(|e| e.to_string())?;
    let definition: ConnectorDeclaration =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if definition.schema_version != 1
        || definition.id.trim().is_empty()
        || definition.id.len() > 256
        || definition.display_name.trim().is_empty()
        || definition.display_name.len() > 4096
        || definition.id.chars().any(char::is_control)
        || definition.display_name.chars().any(char::is_control)
    {
        return Err("Connector declaration is invalid".into());
    }
    Ok(definition)
}
