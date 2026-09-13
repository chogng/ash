use std::path::Path;

use crate::ExternalMemoryFile;
use crate::ImportItemKind;
use crate::agent_paths::ExpectedEntryKind;
use crate::source::Source;

/// Discovers memory metadata through the selected source's bounded directory reader.
/// Project attribution and body conversion belong to the caller's adapter.
pub(crate) fn discover_external_memory_files(source: &mut Source) -> Vec<ExternalMemoryFile> {
    let mut files = Vec::new();
    if let Some(projects) = source.directory(Path::new(".claude/projects"), ImportItemKind::Memory)
    {
        for project in projects.entries {
            if project.kind != ExpectedEntryKind::Directory {
                continue;
            }
            let project_key = project
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let memory = project.relative_path.join("memory");
            collect_markdown_files(source, &memory, &memory, &project_key, &mut files);
        }
    }
    files.sort_by(|left, right| {
        (&left.project_key, &left.relative_path, &left.source_path).cmp(&(
            &right.project_key,
            &right.relative_path,
            &right.source_path,
        ))
    });
    files
}

fn collect_markdown_files(
    source: &mut Source,
    memory_root: &Path,
    relative: &Path,
    project_key: &str,
    files: &mut Vec<ExternalMemoryFile>,
) {
    let Some(directory) = source.directory(relative, ImportItemKind::Memory) else {
        return;
    };
    for entry in directory.entries {
        if entry.kind == ExpectedEntryKind::Directory {
            collect_markdown_files(
                source,
                memory_root,
                &entry.relative_path,
                project_key,
                files,
            );
        } else if entry
            .path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            files.push(ExternalMemoryFile {
                project_key: project_key.to_owned(),
                source_path: entry.path,
                relative_path: entry
                    .relative_path
                    .strip_prefix(memory_root)
                    .expect("memory traversal stays under its root")
                    .to_path_buf(),
            });
        }
    }
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
