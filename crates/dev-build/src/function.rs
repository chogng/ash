//! Incremental compilation for the registered scalar function and its callees.
//! The semantic bridge selects native MIR code generation or the Rustc baseline;
//! context changes and unsupported syntax use the ordinary Cargo module build.

use crate::build::compile;
use crate::build::publish;
use crate::reload::ImageKind;
use crate::reload::digest;
use quote::ToTokens;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use syn2::Expr;
use syn2::Item;
use syn2::Stmt;
use syn2::spanned::Spanned;
use syn2::visit::Visit;

const SOURCE: &str = "crates/app-server-diff/src";
const FUNCTION: &str = "zero_based_line_index";

pub(crate) struct Snapshot {
    pub full: String,
    context: Option<String>,
    function: Option<String>,
    pub analysis_input: Option<(String, u32)>,
    pub files: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Baseline {
    context: String,
    generation: String,
    compiler: String,
    module_manifest: Vec<u8>,
    native_configuration: bool,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

fn sources(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            sources(&entry.path(), files)?;
        } else if entry.path().extension().is_some_and(|it| it == "rs") {
            files.push(entry.path());
        }
    }
    Ok(())
}

pub(crate) fn snapshot(repository: &Path) -> Result<Snapshot, String> {
    let mut files = Vec::new();
    sources(&repository.join(SOURCE), &mut files)?;
    // Changes to these inputs also prevent reusing the native host configuration.
    files.extend(
        [
            "Cargo.toml",
            "Cargo.lock",
            "crates/app-server-diff/Cargo.toml",
            ".cargo/config.toml",
            "rust-toolchain.toml",
        ]
        .map(|file| repository.join(file)),
    );
    files.sort();
    let target = repository.join(SOURCE).join("lib.rs");
    let mut full = Vec::new();
    let mut context = Vec::new();
    let mut extracted = None;
    let mut analysis_input = None;
    let mut has_context = false;
    let mut contents = BTreeMap::new();
    for path in files {
        let name = path
            .strip_prefix(repository)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        contents.insert(
            name.clone(),
            std::str::from_utf8(&bytes)
                .map_err(|error| error.to_string())?
                .to_owned(),
        );
        full.extend_from_slice(
            &serde_json::to_vec(&(&name, digest(&bytes))).map_err(|error| error.to_string())?,
        );
        let normalized = if path == target {
            if let Some(file) = std::str::from_utf8(&bytes)
                .ok()
                .and_then(|text| syn2::parse_file(text).ok())
            {
                let functions = file
                    .items
                    .iter()
                    .filter(|item| {
                        matches!(item,
                    Item::Fn(function) if function.sig.ident == FUNCTION)
                    })
                    .count();
                if functions == 1 {
                    for item in &file.items {
                        if let Item::Fn(function) = item
                            && function.sig.ident == FUNCTION
                        {
                            let expected: syn2::ItemFn = syn2::parse_quote! {
                                fn zero_based_line_index(line_number: usize) -> usize {}
                            };
                            if function.attrs.is_empty()
                                && matches!(function.vis, syn2::Visibility::Inherited)
                                && function.sig.to_token_stream().to_string()
                                    == expected.sig.to_token_stream().to_string()
                            {
                                let mut leaf = Leaf { valid: true };
                                leaf.visit_block(&function.block);
                                if leaf.valid {
                                    extracted = Some(function.to_token_stream().to_string());
                                }
                                analysis_input = Some((
                                    std::str::from_utf8(&bytes)
                                        .map_err(|error| error.to_string())?
                                        .to_owned(),
                                    function
                                        .sig
                                        .ident
                                        .span()
                                        .byte_range()
                                        .start
                                        .try_into()
                                        .map_err(|_| "function offset exceeds analysis budget")?,
                                ));
                                has_context = true;
                                let span = function.block.span();
                                let range = proc_macro2::Span::byte_range(&span);
                                let start = span.start();
                                let end = span.end();
                                // Preserve the surrounding bytes and the body's
                                // line/column footprint. Otherwise a later line!()
                                // or column!() could change without recompilation.
                                let mut normalized = bytes[..range.start].to_vec();
                                normalized.extend_from_slice(
                                    &serde_json::to_vec(&(
                                        start.line,
                                        start.column,
                                        end.line,
                                        end.column,
                                    ))
                                    .map_err(|error| error.to_string())?,
                                );
                                normalized.extend_from_slice(&bytes[range.end..]);
                                context.extend_from_slice(
                                    &serde_json::to_vec(&(&name, digest(&normalized)))
                                        .map_err(|error| error.to_string())?,
                                );
                            }
                        }
                    }
                }
                if has_context {
                    continue;
                }
                bytes
            } else {
                bytes
            }
        } else {
            bytes
        };
        context.extend_from_slice(
            &serde_json::to_vec(&(name, digest(&normalized))).map_err(|error| error.to_string())?,
        );
    }
    Ok(Snapshot {
        full: digest(&full),
        context: has_context.then(|| digest(&context)),
        function: extracted,
        analysis_input,
        files: contents,
    })
}

// Restrict name resolution to the scalar parameter and usize's inherent methods.
// In particular, copying macros, imports, extension traits, constants, locals or
// nested items into a fresh crate could silently change what a name refers to.
struct Leaf {
    valid: bool,
}

impl<'ast> Visit<'ast> for Leaf {
    fn visit_attribute(&mut self, _attribute: &'ast syn2::Attribute) {
        self.valid = false;
    }

    fn visit_stmt(&mut self, statement: &'ast Stmt) {
        if !matches!(statement, Stmt::Expr(_, _)) {
            self.valid = false;
        }
        syn2::visit::visit_stmt(self, statement);
    }

    fn visit_expr(&mut self, expression: &'ast Expr) {
        let supported = match expression {
            Expr::Path(path) => path.qself.is_none() && path.path.is_ident("line_number"),
            Expr::Lit(literal) => matches!(literal.lit, syn2::Lit::Int(_) | syn2::Lit::Bool(_)),
            Expr::MethodCall(call) => {
                call.turbofish.is_none()
                    && matches!(
                        call.method.to_string().as_str(),
                        "saturating_add"
                            | "saturating_sub"
                            | "saturating_mul"
                            | "wrapping_add"
                            | "wrapping_sub"
                            | "wrapping_mul"
                    )
            }
            Expr::Binary(_)
            | Expr::Unary(_)
            | Expr::Paren(_)
            | Expr::Group(_)
            | Expr::Block(_)
            | Expr::If(_)
            | Expr::Return(_) => true,
            _ => false,
        };
        self.valid &= supported;
        syn2::visit::visit_expr(self, expression);
    }
}

pub(crate) fn compiler() -> Result<String, String> {
    let result = Command::new("rustc")
        .arg("-vV")
        .output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err("could not identify the Rust function compiler".into());
    }
    String::from_utf8(result.stdout).map_err(|error| error.to_string())
}

pub(crate) fn save_baseline(
    repository: &Path,
    directory: &Path,
    source: &Snapshot,
    generation: &str,
    module_manifest: &[u8],
) -> Result<(), String> {
    if let Some(context) = &source.context {
        let baseline = Baseline {
            context: context.clone(),
            generation: generation.to_string(),
            compiler: compiler()?,
            module_manifest: module_manifest.to_owned(),
            native_configuration: native_configuration(),
            files: source.files.clone(),
        };
        // Publication is still pending: a rejected snapshot must leave both the
        // running module and its old function namespace intact.
        if snapshot(repository)?.full != source.full {
            return Err("adapter changed before its function baseline was saved".into());
        }
        std::fs::write(
            directory.join("baseline.json"),
            serde_json::to_vec(&baseline).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn native_configuration() -> bool {
    !std::env::vars_os().any(|(name, _)| {
        let name = name.to_string_lossy();
        matches!(
            name.as_ref(),
            "RUSTFLAGS"
                | "CARGO_ENCODED_RUSTFLAGS"
                | "RUSTC"
                | "RUSTC_WRAPPER"
                | "RUSTC_WORKSPACE_WRAPPER"
                | "CARGO_BUILD_TARGET"
        ) || name.starts_with("CARGO_PROFILE_")
            || name.starts_with("CARGO_TARGET_")
    })
}

pub(crate) fn build(
    repository: &Path,
    directory: &Path,
    compiler: &str,
    verify: &mut impl FnMut(&Snapshot) -> Result<Option<serde_json::Value>, String>,
    checker: &mut crate::check::Checker,
) -> Result<bool, String> {
    // Custom targets, flags and compiler wrappers use ordinary Cargo. The saved
    // baseline must also have been built without these overrides: removing an
    // override cannot make an existing custom module into a native baseline.
    if !native_configuration() {
        return Ok(false);
    }
    let baseline = std::fs::read(directory.join("baseline.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Baseline>(&bytes).ok());
    let Some(baseline) = baseline else {
        return Ok(false);
    };
    if !baseline.native_configuration {
        return Ok(false);
    }
    let source = snapshot(repository)?;
    if source.analysis_input.is_none() {
        return Ok(false);
    }
    if let Err(reason) = (crate::workspace::Snapshot {
        files: source.files.clone(),
    })
    .verify_configuration()
    {
        eprintln!("[ash-build] Configuration requires Cargo: {reason}");
        return Ok(false);
    }
    let same_context = source.context.as_ref() == Some(&baseline.context);
    if compiler != baseline.compiler
        || std::fs::read(directory.join("current.json")).ok().as_ref()
            != Some(&baseline.module_manifest)
        || baseline.generation.len() != 64
        || !baseline
            .generation
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(false);
    }
    let Some(analysis) = verify(&source)? else {
        return Ok(false);
    };
    let directory = directory
        .join("functions")
        .join(&baseline.generation)
        .join(FUNCTION);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(
        directory.join("analysis.json"),
        serde_json::to_vec(&analysis).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Some(program) = analysis.get("program") {
        let program: ash_rust_build_ir::Program =
            serde_json::from_value(program.clone()).map_err(|error| error.to_string())?;
        if !same_context && !graph_context_matches(&baseline.files, &source.files, &program)? {
            return Ok(false);
        }
        for dependency in &program.sources {
            if source.files.get(&dependency.path) != Some(&dependency.text) {
                return Err("dependency source differs from the analysis snapshot".into());
            }
        }
        return crate::jit::build(repository, &directory, &source, &program, checker);
    }
    if !same_context {
        return Ok(false);
    }
    let Some(function) = &source.function else {
        return Ok(false);
    };
    std::fs::write(directory.join("function.rs"), wrapper(function))
        .map_err(|error| error.to_string())?;
    let manifest = directory.join("Cargo.toml");
    std::fs::write(&manifest, function_manifest(repository)?).map_err(|error| error.to_string())?;
    // A dependency-free generated crate gives Cargo just this function as input,
    // while inheriting the real workspace's target, linker and Cargo cache.
    let mut command = Command::new("cargo");
    command.current_dir(repository).args([
        "build",
        "--offline",
        "--profile",
        "dev-small",
        "--message-format=json-render-diagnostics",
    ]);
    command.arg("--manifest-path").arg(manifest);
    let image = compile(command, "ash_live_function")?;
    if snapshot(repository)?.full != source.full {
        return Err("adapter changed during function compilation; retry the build".into());
    }
    publish(
        &directory,
        &std::fs::read(image).map_err(|error| error.to_string())?,
        ImageKind::Usize,
    )?;
    Ok(true)
}

fn graph_context_matches(
    previous: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
    program: &ash_rust_build_ir::Program,
) -> Result<bool, String> {
    if previous.keys().ne(current.keys()) {
        return Ok(false);
    }
    struct Functions<'a> {
        nodes: Vec<&'a syn2::ItemFn>,
    }
    impl<'a> Visit<'a> for Functions<'a> {
        fn visit_item_fn(&mut self, node: &'a syn2::ItemFn) {
            self.nodes.push(node);
            // Nested functions cannot be compiled by the scalar bridge.
        }
    }
    fn mask(
        text: &str,
        definitions: &[(usize, &ash_rust_build_ir::Function)],
    ) -> Option<(Vec<u8>, BTreeMap<usize, String>)> {
        let file = syn2::parse_file(text).ok()?;
        let mut functions = Functions { nodes: Vec::new() };
        functions.visit_file(&file);
        let mut ranges = Vec::new();
        let mut bodies = BTreeMap::new();
        for (index, definition) in definitions {
            let matches: Vec<_> = functions
                .nodes
                .iter()
                .filter(|function| function.sig.ident == definition.name)
                .collect();
            if matches.len() != 1 {
                return None;
            }
            let span = matches[0].block.span();
            let range = span.byte_range();
            bodies.insert(*index, text.get(range.clone())?.to_owned());
            let marker = serde_json::to_vec(&(
                span.start().line,
                span.start().column,
                span.end().line,
                span.end().column,
            ))
            .ok()?;
            ranges.push((range, marker));
        }
        ranges.sort_by_key(|(range, _)| range.start);
        let mut normalized = Vec::new();
        let mut start = 0;
        for (range, marker) in ranges {
            if range.start < start {
                return None;
            }
            normalized.extend_from_slice(text.as_bytes().get(start..range.start)?);
            normalized.extend_from_slice(&marker);
            start = range.end;
        }
        normalized.extend_from_slice(text.as_bytes().get(start..)?);
        Some((normalized, bodies))
    }
    for (path, current) in current {
        let previous = &previous[path];
        if previous == current {
            continue;
        }
        let definitions: Vec<_> = program
            .functions
            .iter()
            .enumerate()
            .filter(|(_, function)| function.source_path == *path)
            .collect();
        if definitions.is_empty() {
            return Ok(false);
        }
        let Some((old, old_bodies)) = mask(previous, &definitions) else {
            return Ok(false);
        };
        let Some((new, new_bodies)) = mask(current, &definitions) else {
            return Ok(false);
        };
        if old != new {
            return Ok(false);
        }
        for (index, definition) in definitions {
            if old_bodies[&index] != new_bodies[&index]
                && index != program.root as usize
                && !definition.exclusive
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn function_manifest(repository: &Path) -> Result<String, String> {
    let root: toml::Value = toml::from_str(
        &std::fs::read_to_string(repository.join("Cargo.toml"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut manifest: toml::Value = toml::from_str(
        r#"
[package]
name = "ash-live-function"
version = "0.0.0"
edition = "2024"
publish = false
[lib]
path = "function.rs"
crate-type = ["cdylib"]
[workspace]
"#,
    )
    .map_err(|error| error.to_string())?;
    let mut profiles = toml::map::Map::new();
    for name in ["dev", "dev-small"] {
        let mut profile = root
            .get("profile")
            .and_then(|profiles| profiles.get(name))
            .and_then(toml::Value::as_table)
            .ok_or("missing native development profile")?
            .clone();
        let packages = profile.remove("package");
        if let Some(overrides) = packages
            .as_ref()
            .and_then(|packages| packages.get("ash-app-server-diff"))
            .and_then(toml::Value::as_table)
        {
            profile.extend(overrides.clone());
        }
        profiles.insert(name.into(), toml::Value::Table(profile));
    }
    manifest
        .as_table_mut()
        .ok_or("invalid generated function manifest")?
        .insert("profile".into(), toml::Value::Table(profiles));
    toml::to_string(&manifest).map_err(|error| error.to_string())
}

fn wrapper(function: &str) -> String {
    format!(
        r#"
{function}
#[cfg(panic = "abort")]
compile_error!("development function requires panic=unwind");
#[unsafe(no_mangle)]
pub extern "C" fn ash_dev_abi_version() -> u32 {{ {version} }}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ash_dev_usize_v1(input: usize, output: *mut usize) -> i32 {{
    if output.is_null() {{ return 2; }}
    match ::std::panic::catch_unwind(|| zero_based_line_index(input)) {{
        Ok(value) => {{ unsafe {{ output.write(value) }}; 0 }}
        Err(_) => 1,
    }}
}}
"#,
        version = crate::ABI_VERSION
    )
}

#[cfg(test)]
#[path = "function_tests.rs"]
mod tests;
