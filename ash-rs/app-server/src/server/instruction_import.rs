use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::instructions::InstructionDiagnosticDto;
use ash_app_server_protocol::protocol::instructions::InstructionImportItem;
use ash_app_server_protocol::protocol::instructions::InstructionImportParams;
use ash_app_server_protocol::protocol::instructions::InstructionImportPreviewParams;
use ash_app_server_protocol::protocol::instructions::InstructionImportPreviewResult;
use ash_app_server_protocol::protocol::instructions::InstructionImportResult;
use ash_app_server_protocol::protocol::instructions::InstructionImportSource;
use ash_app_server_protocol::protocol::instructions::InstructionImportStatus;
use ash_file_access::Permission;
use ash_file_system::FileSystem;
use ash_file_system::FileSystemError;
use ash_file_system::FileWriteCondition;
use external_agent_migration::AgentImportLocation;
use external_agent_migration::ExternalInstruction;
use external_agent_migration::ExternalInstructionKind;
use external_agent_migration::ExternalInstructionLoad;
use external_agent_migration::MigrationItemDetail;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

const MAX_CONTENT: usize = 32 * 1024;

impl AppServer {
    pub(super) fn instruction_import_preview(&self, params: &Value) -> Result<Value, RpcError> {
        result(&self.prepare_instruction_import(decode(params)?)?)
    }

    fn prepare_instruction_import(
        &self,
        params: InstructionImportPreviewParams,
    ) -> Result<InstructionImportPreviewResult, RpcError> {
        if params.sources.len() > 128 {
            return Err(invalid());
        }
        let authorization = self.session_dir_authorization(
            &params.directory.session_id,
            &params.directory.path,
            Permission::ReadFiles,
        )?;
        let browsing = self.file_system_service_for_session_directory(
            &params.directory,
            Permission::BrowseFiles,
        )?;
        let root = authorization.dir().canonical_path();
        let plan = authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                Permission::ReadFiles,
                || {
                    external_agent_migration::detect_instruction_plan(match params.source {
                        InstructionImportSource::Copilot => {
                            AgentImportLocation::copilot_project(root)
                        }
                        InstructionImportSource::Claude => {
                            AgentImportLocation::claude_project(root)
                        }
                        InstructionImportSource::Codex => AgentImportLocation::codex_project(root),
                        InstructionImportSource::Cursor => {
                            AgentImportLocation::cursor_project(root)
                        }
                    })
                },
            )
            .map_err(|_| invalid())?
            .map_err(|_| invalid())?;
        let files = self
            .file_system_service_for_session_directory(&params.directory, Permission::ReadFiles)?;
        let requested: BTreeSet<_> = params.sources.iter().cloned().collect();
        if requested.len() != params.sources.len() {
            return Err(invalid());
        }
        let mut documents = Vec::new();
        let mut mappings = BTreeMap::new();
        for item in plan.items() {
            let MigrationItemDetail::Instruction { document } = item.detail() else {
                continue;
            };
            let source = item.source_paths()[0]
                .strip_prefix(root)
                .map_err(|_| invalid())?
                .to_string_lossy()
                .replace('\\', "/");
            if !requested.is_empty() && !requested.contains(&source) {
                continue;
            }
            let target = match &document.kind {
                ExternalInstructionKind::Root => "ASH.md".to_owned(),
                ExternalInstructionKind::Rule { name } => format!(".ash/instructions/{name}.md"),
            };
            mappings.insert(PathBuf::from(&source), PathBuf::from(&target));
            documents.push((source, target, document));
        }
        if !requested.is_empty() && documents.len() != requested.len() {
            return Err(invalid());
        }
        if documents.len() > 128 {
            return Err(invalid());
        }
        let existing = match browsing.read_directory(Path::new(".ash/instructions")) {
            Ok(entries) => entries
                .into_iter()
                .map(|entry| format!(".ash/instructions/{}", entry.name))
                .collect::<BTreeSet<_>>(),
            Err(FileSystemError::NotFound(_)) => BTreeSet::new(),
            Err(_) => return Err(invalid()),
        };
        let future_entries = existing
            .iter()
            .cloned()
            .chain(
                mappings
                    .values()
                    .filter(|path| path.starts_with(".ash/instructions"))
                    .map(|path| path.to_string_lossy().into_owned()),
            )
            .collect::<BTreeSet<_>>();
        let mut items = Vec::new();
        let mut revisions = Vec::new();
        for (source, target, document) in documents {
            let body = rewrite_links(
                &document.body,
                Path::new(&source),
                Path::new(&target),
                &mappings,
            );
            let content = render(document, &body).map_err(|_| invalid())?;
            revisions.push((
                source.clone(),
                ash_file_system::file_revision(document.source.as_bytes()),
                target.clone(),
                content.clone(),
            ));
            let validation = document.unsupported.as_deref().map_or(Ok(()), Err)
                .and_then(|()| if mappings.values().filter(|path| **path == PathBuf::from(&target)).count() > 1 { Err("Multiple source files map to this target; rename them before importing") } else { Ok(()) })
                .and_then(|()| ash_instructions::validate_instruction(Path::new(&target), &content))
                .and_then(|()| {
                    if future_entries.len() > 128 {
                        Err("Instruction catalog would exceed 128 entries")
                    } else {
                        Ok(())
                    }
                });
            let (status, message) = match validation {
                Err(message) => (InstructionImportStatus::Unsupported, Some(message.into())),
                Ok(())
                    if !authorization
                        .dir()
                        .resolve_for_write(Path::new(&target))
                        .is_ok_and(|resolved| resolved == root.join(&target)) =>
                {
                    (
                        InstructionImportStatus::Conflict,
                        Some("Instruction target cannot traverse symbolic links.".into()),
                    )
                }
                Ok(()) => target_status(
                    files.as_ref(),
                    browsing.as_ref(),
                    Path::new(&target),
                    &content,
                ),
            };
            items.push(InstructionImportItem {
                source,
                target,
                content,
                status,
                message,
            });
        }
        let mut diagnostics = plan
            .diagnostics()
            .iter()
            .map(|diagnostic| InstructionDiagnosticDto {
                path: diagnostic.relative_path().display().to_string(),
                message: format!("{:?}", diagnostic.code()),
            })
            .collect::<Vec<_>>();
        if browsing.get_metadata(Path::new("AGENTS.md")).is_ok() {
            diagnostics.push(InstructionDiagnosticDto { path: "AGENTS.md".into(), message: "Shared AGENTS.md is not copied or changed. Review any references it contains to external instruction files.".into() });
        }
        // Bind approval to this directory, source bytes, selected files and converted output.
        // Target status is excluded so a retry can recognize already published identical files.
        let digest = ash_file_system::file_revision(
            &serde_json::to_vec(&("instructions-v2", params.source, root, revisions))
                .map_err(|_| invalid())?,
        );
        Ok(InstructionImportPreviewResult {
            digest,
            items,
            diagnostics,
        })
    }

    pub(super) fn instruction_import(&self, params: &Value) -> Result<Value, RpcError> {
        let params: InstructionImportParams = decode(params)?;
        let mut preview = self.prepare_instruction_import(InstructionImportPreviewParams {
            source: params.source,
            directory: params.directory.clone(),
            sources: params.sources,
        })?;
        if preview.digest != params.digest {
            return Err(RpcError::new(
                -32042,
                AppServerErrorName::FileSystemRevisionConflict,
            ));
        }
        if preview.items.iter().any(|item| {
            matches!(
                item.status,
                InstructionImportStatus::Conflict | InstructionImportStatus::Unsupported
            )
        }) {
            return result(&InstructionImportResult {
                items: preview.items,
            });
        }
        let files = self
            .file_system_service_for_session_directory(&params.directory, Permission::WriteFiles)?;
        for item in &mut preview.items {
            if item.status == InstructionImportStatus::Unchanged {
                continue;
            }
            let target = Path::new(&item.target);
            let published = (|| {
                if let Some(parent) = target
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    files.create_directory(parent)?;
                }
                files.write_file_with_condition(
                    target,
                    item.content.as_bytes(),
                    MAX_CONTENT,
                    &FileWriteCondition::MissingOrEmpty,
                )
            })();
            match published {
                Ok(_) => item.status = InstructionImportStatus::Imported,
                Err(error) => {
                    item.status = if matches!(error, FileSystemError::RevisionConflict(_)) {
                        InstructionImportStatus::Conflict
                    } else {
                        InstructionImportStatus::Failed
                    };
                    item.message = Some(
                        "Instruction was not published; refresh the preview before retrying."
                            .into(),
                    );
                }
            }
        }
        result(&InstructionImportResult {
            items: preview.items,
        })
    }
}

fn invalid() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn target_status(
    files: &dyn FileSystem,
    browsing: &dyn FileSystem,
    path: &Path,
    content: &str,
) -> (InstructionImportStatus, Option<String>) {
    for parent in path
        .ancestors()
        .skip(1)
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if let Ok(metadata) = browsing.get_metadata(parent) {
            if metadata.file_type != ash_file_system::FileType::Directory {
                return (
                    InstructionImportStatus::Conflict,
                    Some("Instruction directories must be real directories.".into()),
                );
            }
        }
    }
    if let Ok(metadata) = browsing.get_metadata(path) {
        if metadata.file_type != ash_file_system::FileType::File {
            return (
                InstructionImportStatus::Conflict,
                Some("Instruction target must be a regular file.".into()),
            );
        }
    }
    match files.read_file(path, MAX_CONTENT) {
        Ok(bytes) if bytes == content.as_bytes() => (InstructionImportStatus::Unchanged, None),
        Ok(bytes) if bytes.is_empty() => (InstructionImportStatus::Ready, None),
        Err(FileSystemError::NotFound(_)) => (InstructionImportStatus::Ready, None),
        _ => (InstructionImportStatus::Conflict, Some("Target exists with different content or cannot be read; it will not be overwritten.".into())),
    }
}

fn render(document: &ExternalInstruction, body: &str) -> Result<String, serde_yaml::Error> {
    if document.kind == ExternalInstructionKind::Root {
        return Ok(body.into());
    }
    let (load, patterns) = match &document.load {
        ExternalInstructionLoad::Always => ("global", Vec::new()),
        ExternalInstructionLoad::Files { patterns } => ("contextual", patterns.clone()),
        ExternalInstructionLoad::Selected => ("on-demand", Vec::new()),
    };
    let mut header = BTreeMap::new();
    header.insert("load", serde_yaml::Value::String(load.into()));
    if let Some(description) = &document.description {
        header.insert(
            "description",
            serde_yaml::Value::String(description.clone()),
        );
    }
    if !patterns.is_empty() {
        header.insert("patterns", serde_yaml::to_value(patterns)?);
    }
    Ok(format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&header)?,
        body
    ))
}

// Rebase Markdown link destinations, preserving labels, prose, code blocks and external URLs.
// References between selected files point to their Ash targets; other relative links retain
// their original destination. Reference definitions are handled separately from inline links.
fn rewrite_links(
    body: &str,
    source: &Path,
    target: &Path,
    mappings: &BTreeMap<PathBuf, PathBuf>,
) -> String {
    let parser = pulldown_cmark::Parser::new(body);
    let mut edits = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        let span = definition.span.clone();
        let raw = &body[span.clone()];
        if let Some(offset) = raw.find("]:").and_then(|start| {
            raw[start + 2..]
                .find(definition.dest.as_ref())
                .map(|offset| start + 2 + offset)
        }) {
            if let Some(replacement) = rebase(definition.dest.as_ref(), source, target, mappings) {
                edits.push((
                    span.start + offset..span.start + offset + definition.dest.len(),
                    replacement,
                ));
            }
        }
    }
    for (event, span) in parser.into_offset_iter() {
        let destination = match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link {
                link_type: pulldown_cmark::LinkType::Inline,
                dest_url,
                ..
            })
            | pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image {
                link_type: pulldown_cmark::LinkType::Inline,
                dest_url,
                ..
            }) => dest_url,
            _ => continue,
        };
        let raw = &body[span.clone()];
        if let Some(start) = raw.rfind("](").map(|offset| offset + 2) {
            if let Some(offset) = raw[start..].find(destination.as_ref()) {
                if let Some(replacement) = rebase(&destination, source, target, mappings) {
                    let start = span.start + start + offset;
                    edits.push((start..start + destination.len(), replacement));
                }
            }
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut output = body.to_owned();
    for (range, replacement) in edits.into_iter().rev() {
        output.replace_range(range, &replacement);
    }
    output
}

fn rebase(
    destination: &str,
    source: &Path,
    target: &Path,
    mappings: &BTreeMap<PathBuf, PathBuf>,
) -> Option<String> {
    if destination.is_empty() || destination.starts_with(['#', '/']) || destination.contains(':') {
        return None;
    }
    let (path, suffix) = destination
        .find(['#', '?'])
        .map(|index| destination.split_at(index))
        .unwrap_or((destination, ""));
    let mut resolved = PathBuf::new();
    for component in source.parent()?.join(path).components() {
        match component {
            Component::Normal(name) => resolved.push(name),
            Component::ParentDir => {
                if resolved.as_os_str().is_empty()
                    || resolved.components().next_back() == Some(Component::ParentDir)
                {
                    resolved.push("..");
                } else {
                    resolved.pop();
                }
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    let resolved = mappings.get(&resolved).unwrap_or(&resolved);
    let base = target.parent()?.components().collect::<Vec<_>>();
    let parts = resolved.components().collect::<Vec<_>>();
    let common = base.iter().zip(&parts).take_while(|(a, b)| a == b).count();
    let mut relative = PathBuf::new();
    for _ in common..base.len() {
        relative.push("..");
    }
    for part in &parts[common..] {
        relative.push(part.as_os_str());
    }
    Some(format!(
        "{}{suffix}",
        relative.to_string_lossy().replace('\\', "/")
    ))
}

#[cfg(test)]
#[path = "instruction_import_tests.rs"]
mod tests;
