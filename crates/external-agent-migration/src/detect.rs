use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value as JsonValue;

use crate::AgentImportError;
use crate::AgentImportLocation;
use crate::ExternalAgent;
use crate::ExternalAgentDefinition;
use crate::ExternalDocument;
use crate::ExternalHookEvent;
use crate::ImportItemKind;
use crate::ImportScope;
use crate::MigrationItemDetail;
use crate::MigrationPlan;
use crate::MigrationPlanItem;
use crate::agent_paths::ExpectedEntryKind;
use crate::frontmatter;
use crate::hooks;
use crate::mcp;
use crate::memory;
use crate::plugins;
use crate::settings;
use crate::settings::ClaudeSettings;
use crate::source::Source;

/// Reads known external layouts into a bounded, read-only migration plan.
///
/// Every selected root is validated before use. `user_home` authorizes reading that home's
/// `.claude.json` project MCP declarations; its canonical path is recorded and read errors
/// use User scope diagnostics.
/// Conversion into Ash domains and application belong to the caller's adapter.
pub fn detect_migration_plan(
    locations: impl IntoIterator<Item = AgentImportLocation>,
    user_home: Option<&Path>,
) -> Result<MigrationPlan, AgentImportError> {
    let mut items = Vec::new();
    let mut diagnostics = Vec::new();
    for location in locations {
        let mut home = if location.agent() == ExternalAgent::Claude
            && location.scope() == ImportScope::Project
        {
            user_home
                .map(|path| Source::new(AgentImportLocation::claude_user(path)))
                .transpose()?
        } else {
            None
        };
        let mut detection = Detection {
            source: Source::new(location)?,
            items: Vec::new(),
        };
        match detection.source.location.agent() {
            ExternalAgent::Claude => detection.detect_claude(home.as_mut()),
            ExternalAgent::Codex => detection.detect_codex(),
            ExternalAgent::Copilot | ExternalAgent::Cursor => {}
        }
        detection
            .items
            .extend(crate::instruction::detect(&mut detection.source));
        items.extend(detection.items);
        diagnostics.extend(detection.source.diagnostics);
        if let Some(home) = home {
            diagnostics.extend(home.diagnostics);
        }
    }
    items.sort_by(|left, right| {
        (left.agent(), left.scope(), left.kind(), left.source_paths()).cmp(&(
            right.agent(),
            right.scope(),
            right.kind(),
            right.source_paths(),
        ))
    });
    items.dedup_by(|left, right| left == right);
    diagnostics.sort();
    diagnostics.dedup();
    Ok(MigrationPlan::new(items, diagnostics))
}

enum NameSource {
    Directories,
    Files(&'static str),
}

struct Detection {
    source: Source,
    items: Vec<MigrationPlanItem>,
}

impl Detection {
    fn detect_claude(&mut self, home: Option<&mut Source>) {
        let settings = settings::claude_effective_settings(&mut self.source);
        if let Some(settings) = &settings {
            self.add(
                ImportItemKind::Settings,
                settings.paths(),
                MigrationItemDetail::Settings {
                    document: ExternalDocument::Json(settings.effective.clone()),
                },
            );
        }
        self.detect_names(
            ".claude/skills",
            ImportItemKind::Skills,
            NameSource::Directories,
        );
        self.detect_names(
            ".claude/commands",
            ImportItemKind::Commands,
            NameSource::Files("md"),
        );
        self.detect_agents(".claude/agents", "md");
        let collected = mcp::collect_mcp_servers(&mut self.source, home);
        let (enabled, disabled) = settings
            .as_ref()
            .map(|settings| mcp_enablement(&settings.effective))
            .unwrap_or_default();
        let servers = mcp::normalize_mcp_servers(collected.servers, &enabled, &disabled);
        if !servers.is_empty() {
            let mut paths = collected.paths;
            if let Some(settings) = &settings {
                paths.extend(settings.paths());
            }
            self.add(
                ImportItemKind::McpServers,
                paths,
                MigrationItemDetail::McpServers { servers },
            );
        }
        if let Some(settings) = &settings {
            self.detect_claude_hooks(settings);
            if self.source.location.scope() == ImportScope::User {
                self.detect_claude_plugins(settings);
            }
        }
        if self.source.location.scope() == ImportScope::User {
            let files = memory::discover_external_memory_files(&mut self.source);
            if !files.is_empty() {
                let paths = files.iter().map(|file| file.source_path.clone()).collect();
                self.add(
                    ImportItemKind::Memory,
                    paths,
                    MigrationItemDetail::Memory { files },
                );
            }
        }
    }

    fn detect_codex(&mut self) {
        if let Some(config) = self.source.read(
            Path::new(".codex/config.toml"),
            ImportItemKind::Settings,
            settings::parse_toml,
        ) {
            let servers = mcp::codex_mcp_servers(&config.value);
            if !servers.is_empty() {
                self.add(
                    ImportItemKind::McpServers,
                    vec![config.path.clone()],
                    MigrationItemDetail::McpServers { servers },
                );
            }
            self.add(
                ImportItemKind::Settings,
                vec![config.path],
                MigrationItemDetail::Settings {
                    document: ExternalDocument::Toml(config.value),
                },
            );
        }
        self.detect_names(
            ".agents/skills",
            ImportItemKind::Skills,
            NameSource::Directories,
        );
        self.detect_agents(".codex/agents", "toml");
        self.detect_names(
            ".codex/rules",
            ImportItemKind::ExecutionRules,
            NameSource::Files("rules"),
        );
    }

    fn detect_names(&mut self, relative: &str, kind: ImportItemKind, names: NameSource) {
        let Some(directory) = self.source.directory(Path::new(relative), kind) else {
            return;
        };
        let mut names: Vec<_> = directory
            .entries
            .into_iter()
            .filter_map(|entry| {
                match names {
                    NameSource::Directories if entry.kind == ExpectedEntryKind::Directory => {
                        entry.path.file_name()
                    }
                    NameSource::Files(extension)
                        if entry.kind == ExpectedEntryKind::File
                            && matches_extension(&entry.path, extension) =>
                    {
                        entry.path.file_stem()
                    }
                    _ => None,
                }
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
            })
            .collect();
        names.sort();
        names.dedup();
        if names.is_empty() {
            return;
        }
        let detail = match kind {
            ImportItemKind::Skills => MigrationItemDetail::Skills { names },
            ImportItemKind::Commands => MigrationItemDetail::Commands { names },
            _ => MigrationItemDetail::Rules { names },
        };
        self.add(kind, vec![directory.path], detail);
    }

    fn detect_agents(&mut self, relative: &str, extension: &str) {
        let Some(directory) = self
            .source
            .directory(Path::new(relative), ImportItemKind::Agents)
        else {
            return;
        };
        let mut definitions = Vec::new();
        let mut paths = Vec::new();
        for entry in directory.entries {
            if entry.kind != ExpectedEntryKind::File || !matches_extension(&entry.path, extension) {
                continue;
            }
            let definition = if extension == "toml" {
                self.source
                    .read(
                        &entry.relative_path,
                        ImportItemKind::Agents,
                        settings::parse_toml,
                    )
                    .and_then(|document| {
                        let name = document.value.get("name")?.as_str()?.trim();
                        if name.is_empty() {
                            return None;
                        }
                        let description = document
                            .value
                            .get("description")
                            .and_then(toml::Value::as_str)
                            .unwrap_or_default();
                        Some((
                            document.path,
                            ExternalAgentDefinition {
                                name: name.to_owned(),
                                description: description.to_owned(),
                            },
                        ))
                    })
            } else {
                self.source
                    .read(&entry.relative_path, ImportItemKind::Agents, |text| {
                        let document = frontmatter::parse_frontmatter_document(text);
                        match frontmatter::frontmatter_error(&document) {
                            Some(code) => Err(code),
                            None => Ok(document),
                        }
                    })
                    .and_then(|document| {
                        let name =
                            frontmatter::frontmatter_scalar(&document.value.frontmatter, "name")?;
                        let description = frontmatter::frontmatter_scalar(
                            &document.value.frontmatter,
                            "description",
                        )?;
                        if name.trim().is_empty() || description.trim().is_empty() {
                            return None;
                        }
                        Some((document.path, ExternalAgentDefinition { name, description }))
                    })
            };
            if let Some((path, definition)) = definition {
                paths.push(path);
                definitions.push(definition);
            }
        }
        if !definitions.is_empty() {
            self.add(
                ImportItemKind::Agents,
                paths,
                MigrationItemDetail::Agents { definitions },
            );
        }
    }

    fn detect_claude_hooks(&mut self, settings: &ClaudeSettings) {
        if settings
            .effective
            .get("disableAllHooks")
            .and_then(JsonValue::as_bool)
            == Some(true)
        {
            return;
        }
        let mut counts = BTreeMap::<String, ExternalHookEvent>::new();
        for document in &settings.documents {
            for event in hooks::claude_hook_events(&document.value) {
                let count = counts
                    .entry(event.event.clone())
                    .or_insert(ExternalHookEvent {
                        event: event.event,
                        groups: 0,
                        command_groups: 0,
                    });
                count.groups += event.groups;
                count.command_groups += event.command_groups;
            }
        }
        if !counts.is_empty() {
            self.add(
                ImportItemKind::Hooks,
                settings.paths(),
                MigrationItemDetail::Hooks {
                    events: counts.into_values().collect(),
                },
            );
        }
    }

    fn detect_claude_plugins(&mut self, settings: &ClaudeSettings) {
        let registry = self.source.read(
            Path::new(plugins::KNOWN_MARKETPLACES_PATH),
            ImportItemKind::Plugins,
            settings::parse_json,
        );
        let home = self.source.root().join(".claude");
        let marketplaces = plugins::claude_plugin_marketplaces(
            &settings.effective,
            registry.as_ref().map(|document| &document.value),
            &home,
            self.source.root(),
        );
        if !marketplaces.is_empty() {
            let mut paths = settings.paths();
            if let Some(registry) = registry {
                paths.push(registry.path);
            }
            self.add(
                ImportItemKind::Plugins,
                paths,
                MigrationItemDetail::Plugins { marketplaces },
            );
        }
    }

    fn add(&mut self, kind: ImportItemKind, mut paths: Vec<PathBuf>, detail: MigrationItemDetail) {
        paths.sort();
        paths.dedup();
        self.items.push(MigrationPlanItem::new(
            self.source.location.agent(),
            self.source.location.scope(),
            kind,
            paths,
            detail,
        ));
    }
}

fn matches_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        && path.file_stem().and_then(|stem| stem.to_str()) != Some("README")
}

fn mcp_enablement(document: &JsonValue) -> (Vec<String>, BTreeSet<String>) {
    let enabled = document
        .get("enabledMcpjsonServers")
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let disabled = document
        .get("disabledMcpjsonServers")
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    (enabled, disabled)
}
