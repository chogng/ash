use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::instructions::InstructionCatalogDiagnosticDto;
use ash_app_server_protocol::protocol::instructions::InstructionDiagnosticCodeDto;
use ash_app_server_protocol::protocol::instructions::InstructionDto;
use ash_app_server_protocol::protocol::instructions::InstructionListParams;
use ash_app_server_protocol::protocol::instructions::InstructionListResult;
use ash_app_server_protocol::protocol::instructions::InstructionLoadPolicyDto;
use ash_core::CoreError;
use ash_home::AshHome;
use ash_instructions::InstructionCatalogSnapshot;
use ash_instructions::InstructionDiagnosticCode;
use ash_instructions::InstructionLoadPolicy;
use ash_protocol::ContentDigest;
use ash_protocol::InstructionRef;
use ash_protocol::InstructionSource;
use ash_protocol::SessionId;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

pub(super) struct InstructionCatalogSource {
    pub source: InstructionSource,
    pub root: PathBuf,
    pub snapshot: Arc<InstructionCatalogSnapshot>,
}

impl InstructionCatalogSource {
    pub fn user(home: &AshHome) -> Self {
        Self {
            source: InstructionSource::User,
            root: home.root().join("instructions"),
            snapshot: home.instructions(),
        }
    }
}

impl AppServer {
    pub(super) fn instruction_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: InstructionListParams = decode(params)?;
        let sources = self.instruction_catalog_sources(params.session_id.as_ref());
        let mut instructions = Vec::new();
        let mut diagnostics = Vec::new();
        for catalog in sources {
            for entry in catalog.snapshot.entries() {
                instructions.push(InstructionDto {
                    reference: InstructionRef {
                        source: catalog.source.clone(),
                        relative_path: entry.relative_path().to_path_buf(),
                        digest: ContentDigest::sha256(entry.body().as_bytes()),
                    },
                    name: entry.name().to_owned(),
                    load_policy: match entry.load_policy() {
                        InstructionLoadPolicy::Global => InstructionLoadPolicyDto::Global,
                        InstructionLoadPolicy::Contextual { .. } => {
                            InstructionLoadPolicyDto::Contextual
                        }
                        InstructionLoadPolicy::OnDemand => InstructionLoadPolicyDto::OnDemand,
                    },
                    path: catalog.root.join(entry.relative_path()),
                });
            }
            for diagnostic in catalog.snapshot.diagnostics() {
                diagnostics.push(InstructionCatalogDiagnosticDto {
                    source: catalog.source.clone(),
                    relative_path: diagnostic.relative_path().map(PathBuf::from),
                    code: diagnostic_code(diagnostic.code()),
                    message: diagnostic.message().to_owned(),
                });
            }
        }
        result(&InstructionListResult {
            instructions,
            diagnostics,
        })
    }

    pub(super) fn instruction_catalog_sources(
        &self,
        session_id: Option<&SessionId>,
    ) -> Vec<InstructionCatalogSource> {
        let contributions = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            ._dir_contributions
            .clone();
        if let Some(contributions) = contributions {
            return contributions.instruction_sources_for(session_id);
        }
        self.home
            .as_ref()
            .map(|home| vec![InstructionCatalogSource::user(home)])
            .unwrap_or_default()
    }

    pub(super) fn validate_instruction_ref(
        &self,
        session_id: &SessionId,
        reference: &InstructionRef,
    ) -> Result<(), RpcError> {
        selected_instruction_content(
            &self.instruction_catalog_sources(Some(session_id)),
            std::slice::from_ref(reference),
        )
        .map(|_| ())
        .map_err(|_| RpcError {
            code: -32082,
            message: AppServerErrorName::InstructionSelectionInvalid,
            detail: Some("Selected Instruction changed or is unavailable. Choose it again.".into()),
        })
    }
}

fn diagnostic_code(code: InstructionDiagnosticCode) -> InstructionDiagnosticCodeDto {
    match code {
        InstructionDiagnosticCode::SourceUnavailable => {
            InstructionDiagnosticCodeDto::SourceUnavailable
        }
        InstructionDiagnosticCode::EntryLimitExceeded => {
            InstructionDiagnosticCodeDto::EntryLimitExceeded
        }
        InstructionDiagnosticCode::UnsupportedFileType => {
            InstructionDiagnosticCodeDto::UnsupportedFileType
        }
        InstructionDiagnosticCode::SymlinkNotAllowed => {
            InstructionDiagnosticCodeDto::SymlinkNotAllowed
        }
        InstructionDiagnosticCode::InvalidName => InstructionDiagnosticCodeDto::InvalidName,
        InstructionDiagnosticCode::InvalidFrontmatter => {
            InstructionDiagnosticCodeDto::InvalidFrontmatter
        }
        InstructionDiagnosticCode::InvalidLoadPolicy => {
            InstructionDiagnosticCodeDto::InvalidLoadPolicy
        }
        InstructionDiagnosticCode::ContentTooLarge => InstructionDiagnosticCodeDto::ContentTooLarge,
        InstructionDiagnosticCode::ContentInvalidUtf8 => {
            InstructionDiagnosticCodeDto::ContentInvalidUtf8
        }
        InstructionDiagnosticCode::EmptyBody => InstructionDiagnosticCodeDto::EmptyBody,
    }
}

pub(super) fn selected_instruction_content(
    catalogs: &[InstructionCatalogSource],
    references: &[InstructionRef],
) -> Result<BTreeMap<InstructionSource, String>, CoreError> {
    if references.len() > 32 {
        return Err(CoreError::InvalidInput(
            "too many selected Instructions".into(),
        ));
    }
    let mut selected = BTreeSet::new();
    for reference in references {
        let catalog = catalogs
            .iter()
            .find(|catalog| catalog.source == reference.source)
            .ok_or_else(|| {
                CoreError::InvalidInput("selected Instruction source is unavailable".into())
            })?;
        let entry = catalog
            .snapshot
            .entries()
            .iter()
            .find(|entry| entry.relative_path() == reference.relative_path)
            .filter(|entry| matches!(entry.load_policy(), InstructionLoadPolicy::OnDemand))
            .filter(|entry| ContentDigest::sha256(entry.body().as_bytes()) == reference.digest)
            .ok_or_else(|| {
                CoreError::InvalidInput("selected Instruction is unavailable or changed".into())
            })?;
        selected.insert((
            reference.source.clone(),
            entry.relative_path().to_path_buf(),
        ));
    }
    let mut content = BTreeMap::new();
    for catalog in catalogs {
        let bodies = catalog
            .snapshot
            .entries()
            .iter()
            .filter(|entry| {
                selected.contains(&(catalog.source.clone(), entry.relative_path().to_path_buf()))
            })
            .map(|entry| entry.render())
            .collect::<Vec<_>>();
        if !bodies.is_empty() {
            content.insert(catalog.source.clone(), bodies.join("\n\n"));
        }
    }
    Ok(content)
}
