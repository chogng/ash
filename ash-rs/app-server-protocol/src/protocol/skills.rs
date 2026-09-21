use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::CommandId;
use crate::protocol::resources::ResourceMetadataResult;
use ash_protocol::ContentDigest;
use ash_protocol::SkillId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillCatalogReloadDto {
    #[default]
    Cached,
    Refresh,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillEnablementDto {
    Disabled,
    Enabled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillSourceKindDto {
    BuiltIn,
    User,
    Directory,
    Plugin,
    Marketplace,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SkillCompatibilityDto {
    Compatible,
    Unknown { note: String },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub id: SkillId,
    pub description: String,
    pub source_kind: SkillSourceKindDto,
    pub content_digest: ContentDigest,
    pub enablement: SkillEnablementDto,
    pub compatibility: SkillCompatibilityDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillDiagnosticCodeDto {
    SourceUnavailable,
    SourceLimitExceeded,
    SkillNotFound,
    InvalidFrontmatter,
    InvalidSkillName,
    DescriptionInvalid,
    PathEscapesRoot,
    UnsupportedFileType,
    ContentTooLarge,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiagnosticDto {
    pub source: String,
    pub subject: Option<String>,
    pub code: SkillDiagnosticCodeDto,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {
    #[serde(default)]
    pub reload: SkillCatalogReloadDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<ash_protocol::SessionId>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillListResult {
    #[ts(type = "number")]
    pub generation: u64,
    pub skills: Vec<SkillDto>,
    pub diagnostics: Vec<SkillDiagnosticDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetEnablementParams {
    pub command_id: CommandId,
    #[schemars(range(min = 0))]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub skill_id: SkillId,
    pub enablement: SkillEnablementDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillResourceKindDto {
    Instructions,
    Reference,
    Script,
    Asset,
    AgentMetadata,
    Other,
}

/// Opens one inert package resource from an exact Skill revision.
///
/// `path` remains package-relative. The server revalidates both the Skill digest and the rooted
/// resource path before publishing bytes into the connection-owned Resource store.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceOpenParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<ash_protocol::SessionId>,
    pub skill_id: SkillId,
    pub skill_content_digest: ContentDigest,
    #[schemars(length(min = 1, max = 1024))]
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceOpenResult {
    pub path: String,
    pub kind: SkillResourceKindDto,
    pub resource: ResourceMetadataResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillsChanged {
    #[ts(type = "number")]
    pub generation: u64,
}
