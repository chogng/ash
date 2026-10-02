use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use ash_async_utils::CancellationToken;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use serde::Deserialize;
use tree_sitter::Node;
use tree_sitter::Parser;

use crate::TargetKind;
use crate::TestItem;
use crate::TestingError;
use crate::runner::execute;
use crate::service::MAX_TESTS;

#[derive(Deserialize)]
struct Metadata {
    packages: Vec<Package>,
    workspace_members: Vec<String>,
}

#[derive(Deserialize)]
struct Package {
    id: String,
    name: String,
    targets: Vec<Target>,
}

#[derive(Deserialize)]
struct Target {
    name: String,
    kind: Vec<String>,
    src_path: PathBuf,
    test: bool,
}

pub(crate) fn discover(
    read: &Authorization,
    command: &Authorization,
    cancellation: &CancellationToken,
) -> Result<Vec<TestItem>, TestingError> {
    let root = read.dir().canonical_path();
    if !root.join("Cargo.toml").is_file() {
        return Ok(Vec::new());
    }
    let output = execute(
        command,
        "cargo",
        &["metadata", "--no-deps", "--format-version", "1"],
        cancellation,
    )?;
    if output.exit_code != Some(0) {
        return Err(TestingError::Failed(output.stderr));
    }
    if output.stdout_truncated {
        return Err(TestingError::Failed(
            "Cargo metadata exceeded the output limit".into(),
        ));
    }
    let metadata: Metadata = serde_json::from_str(&output.stdout)
        .map_err(|error| TestingError::Failed(error.to_string()))?;
    let members: HashSet<_> = metadata.workspace_members.into_iter().collect();
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .map_err(|error| TestingError::Failed(error.to_string()))?;
    let mut tests = Vec::new();
    for package in metadata
        .packages
        .into_iter()
        .filter(|package| members.contains(&package.id))
    {
        for target in package.targets.into_iter().filter(|target| target.test) {
            let kind = if target
                .kind
                .iter()
                .any(|kind| kind == "lib" || kind == "rlib" || kind == "proc-macro")
            {
                TargetKind::Library
            } else if target.kind.iter().any(|kind| kind == "bin") {
                TargetKind::Binary
            } else if target.kind.iter().any(|kind| kind == "test") {
                TargetKind::Integration
            } else {
                continue;
            };
            let mut scanner = Scanner {
                parser: &mut parser,
                read,
                cancellation,
                package: &package.name,
                target: &target.name,
                kind,
                visited: HashSet::new(),
                active_files: HashSet::new(),
                tests: &mut tests,
            };
            scanner.file(
                &target.src_path,
                &[],
                target.src_path.parent().ok_or(TestingError::InvalidInput)?,
            )?;
        }
    }
    tests.sort_by(|a, b| a.id.cmp(&b.id));
    tests.dedup_by(|a, b| a.id == b.id);
    Ok(tests)
}

struct Scanner<'a> {
    parser: &'a mut Parser,
    read: &'a Authorization,
    cancellation: &'a CancellationToken,
    package: &'a str,
    target: &'a str,
    kind: TargetKind,
    visited: HashSet<(PathBuf, Vec<String>)>,
    tests: &'a mut Vec<TestItem>,
    active_files: HashSet<PathBuf>,
}

impl Scanner<'_> {
    fn file(
        &mut self,
        path: &Path,
        modules: &[String],
        module_directory: &Path,
    ) -> Result<(), TestingError> {
        self.cancellation
            .check()
            .map_err(|_| TestingError::Cancelled)?;
        let canonical = path
            .canonicalize()
            .map_err(|error| TestingError::Failed(error.to_string()))?;
        if !canonical.starts_with(self.read.dir().canonical_path()) {
            return Err(TestingError::PermissionRequired);
        }
        if !self.visited.insert((canonical.clone(), modules.to_vec())) {
            return Ok(());
        }
        if !self.active_files.insert(canonical.clone()) {
            return Err(TestingError::Failed(
                "Rust module source contains a cycle".into(),
            ));
        }
        let source = self
            .read
            .execute(
                self.read.subject(),
                self.read.dir(),
                Permission::ReadFiles,
                || std::fs::read_to_string(&canonical),
            )
            .map_err(|_| TestingError::PermissionRequired)?
            .map_err(|error| TestingError::Failed(error.to_string()))?;
        let tree = self
            .parser
            .parse(&source, None)
            .ok_or_else(|| TestingError::Failed("Rust syntax could not be parsed".into()))?;
        let result = self.items(
            tree.root_node(),
            &source,
            &canonical,
            modules,
            module_directory,
        );
        self.active_files.remove(&canonical);
        result
    }

    fn items(
        &mut self,
        node: Node<'_>,
        source: &str,
        path: &Path,
        modules: &[String],
        module_directory: &Path,
    ) -> Result<(), TestingError> {
        let mut cursor = node.walk();
        let mut attributes = Vec::new();
        for item in node.named_children(&mut cursor) {
            self.cancellation
                .check()
                .map_err(|_| TestingError::Cancelled)?;
            let text = &source[item.byte_range()];
            if item.kind() == "attribute_item" {
                attributes.push(text.to_owned());
                continue;
            }
            if item.kind() == "line_comment" || item.kind() == "block_comment" {
                continue;
            }
            if item.kind() == "function_item"
                && attributes
                    .iter()
                    .any(|attribute| attribute.replace(char::is_whitespace, "") == "#[test]")
            {
                let name = item
                    .child_by_field_name("name")
                    .ok_or(TestingError::InvalidInput)?;
                let mut segments = modules.to_vec();
                segments.push(source[name.byte_range()].to_owned());
                let qualified = segments.join("::");
                let target_kind = match self.kind {
                    TargetKind::Library => "lib",
                    TargetKind::Binary => "bin",
                    TargetKind::Integration => "test",
                };
                self.tests.push(TestItem {
                    id: format!("{}:{target_kind}:{}:{qualified}", self.package, self.target),
                    package: self.package.to_owned(),
                    target: self.target.to_owned(),
                    target_kind: self.kind,
                    name: qualified,
                    path: path
                        .strip_prefix(self.read.dir().canonical_path())
                        .map_err(|_| TestingError::PermissionRequired)?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    line: name.start_position().row + 1,
                });
                if self.tests.len() > MAX_TESTS {
                    return Err(TestingError::Failed(
                        "Rust test discovery exceeded 10000 tests".into(),
                    ));
                }
            }
            if item.kind() == "mod_item" {
                let name = item
                    .child_by_field_name("name")
                    .ok_or(TestingError::InvalidInput)?;
                let name = source[name.byte_range()].to_owned();
                let mut nested = modules.to_vec();
                nested.push(name.clone());
                let module_name = name.trim_start_matches("r#");
                if let Some(body) = item.child_by_field_name("body") {
                    self.items(
                        body,
                        source,
                        path,
                        &nested,
                        &module_directory.join(module_name),
                    )?;
                } else {
                    let configured = attributes.iter().find_map(|attribute| {
                        // Whitespace around the attribute is syntax; whitespace inside
                        // the path is part of the filename and must remain unchanged.
                        let value = attribute.strip_prefix("#[")?.strip_suffix(']')?.trim();
                        let value = value
                            .strip_prefix("path")?
                            .trim_start()
                            .strip_prefix('=')?
                            .trim();
                        serde_json::from_str::<String>(value).ok()
                    });
                    let child = match configured {
                        Some(configured) => path
                            .parent()
                            .ok_or(TestingError::InvalidInput)?
                            .join(configured),
                        None => {
                            let flat = module_directory.join(format!("{module_name}.rs"));
                            if flat.is_file() {
                                flat
                            } else {
                                module_directory.join(module_name).join("mod.rs")
                            }
                        }
                    };
                    // A cfg-disabled module may not have a source file on this host.
                    if child.is_file() {
                        let child_directory =
                            if child.file_name().is_some_and(|name| name == "mod.rs") {
                                child.parent().ok_or(TestingError::InvalidInput)?.to_owned()
                            } else {
                                child
                                    .parent()
                                    .ok_or(TestingError::InvalidInput)?
                                    .join(child.file_stem().ok_or(TestingError::InvalidInput)?)
                            };
                        self.file(&child, &nested, &child_directory)?;
                    }
                }
            }
            attributes.clear();
        }
        Ok(())
    }
}
