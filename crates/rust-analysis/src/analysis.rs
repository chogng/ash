//! The only module coupled to rust-analyzer's pinned Rust APIs. Public HIR and
//! IDE queries are preferred; the MIR probe deliberately tests the deeper,
//! publicly callable but unstable database API without modifying its source.

use crate::Error;
use crate::MAX_FILE_BYTES;
use crate::Query;
use crate::WorkspaceMode;
use ra_ap_hir::ChangeWithProcMacros;
use ra_ap_hir::DisplayTarget;
use ra_ap_hir::Function;
use ra_ap_hir::GenericDef;
use ra_ap_hir::HasSource;
use ra_ap_hir::HirDisplay;
use ra_ap_hir::Semantics;
use ra_ap_hir::Type;
use ra_ap_hir::db::HirDatabase;
use ra_ap_hir_def::FunctionId;
use ra_ap_ide::AnalysisHost;
use ra_ap_ide::FileId;
use ra_ap_ide::FilePosition;
use ra_ap_ide::FindAllRefsConfig;
use ra_ap_ide::RaFixtureConfig;
use ra_ap_ide::TextRange;
use ra_ap_ide::TextSize;
use ra_ap_load_cargo::LoadCargoConfig;
use ra_ap_load_cargo::ProcMacroServerChoice;
use ra_ap_proc_macro_api::ProcMacroClient;
use ra_ap_project_model::CargoConfig;
use ra_ap_project_model::ProjectManifest;
use ra_ap_project_model::ProjectWorkspace;
use ra_ap_project_model::RustLibSource;
use ra_ap_syntax::AstNode;
use ra_ap_syntax::ast;
use ra_ap_vfs::AbsPathBuf;
use ra_ap_vfs::FileExcluded;
use ra_ap_vfs::Vfs;
use ra_ap_vfs::VfsPath;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

const MAX_ITEMS: usize = 2048;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Probe<T> {
    Available { value: T },
    Unavailable { reason: String },
}

#[derive(Serialize)]
struct Layout {
    size_bytes: u64,
    alignment_bytes: u64,
}

#[derive(Serialize)]
struct TypeReport {
    display: String,
    contains_unknown: bool,
    layout: Probe<Layout>,
}

pub(super) struct Session {
    host: AnalysisHost,
    vfs: Vfs,
    root: PathBuf,
    mode: WorkspaceMode,
    load_ms: u128,
    build_script_error: Option<String>,
    // Keep the helper's process owner alive for the database's proc-macro handles.
    proc_macro: Option<ProcMacroClient>,
    pub revision: u64,
}

impl Session {
    pub fn load(root: &Path, mode: WorkspaceMode) -> Result<Self, String> {
        let started = Instant::now();
        let root = dunce::canonicalize(root).map_err(|error| error.to_string())?;
        let root = if root.is_file() {
            root.parent().ok_or("manifest has no parent")?.to_path_buf()
        } else {
            root
        };
        root.to_str().ok_or("workspace path must be UTF-8")?;
        let absolute = AbsPathBuf::assert_utf8(root.clone());
        let manifest =
            ProjectManifest::discover_single(&absolute).map_err(|error| error.to_string())?;
        let config = CargoConfig {
            sysroot: Some(RustLibSource::Discover),
            metadata_extra_args: vec!["--locked".into(), "--offline".into()],
            extra_args: vec![
                "--locked".into(),
                "--offline".into(),
                "--profile".into(),
                "dev-small".into(),
            ],
            ..CargoConfig::default()
        };
        let progress = |message| eprintln!("[rust-analysis] {message}");
        let mut workspace = ProjectWorkspace::load(manifest, &config, &progress)
            .map_err(|error| error.to_string())?;
        let build_script_error = match mode {
            WorkspaceMode::Metadata => None,
            WorkspaceMode::BuildScripts => {
                let scripts = workspace
                    .run_build_scripts(&config, &progress)
                    .map_err(|error| error.to_string())?;
                let error = scripts.error().map(ToString::to_string);
                workspace.set_build_scripts(scripts);
                error
            }
        };
        let load = LoadCargoConfig {
            load_out_dirs_from_check: false, // handled above so failures are reported on the wire
            with_proc_macro_server: match mode {
                WorkspaceMode::Metadata => ProcMacroServerChoice::None,
                WorkspaceMode::BuildScripts => ProcMacroServerChoice::Sysroot,
            },
            prefill_caches: false,
            num_worker_threads: 2,
            proc_macro_processes: 1,
        };
        let (database, vfs, proc_macro) =
            ra_ap_load_cargo::load_workspace(workspace, &config.extra_env, &load)
                .map_err(|error| error.to_string())?;
        Ok(Self {
            host: AnalysisHost::with_database(database),
            vfs,
            root,
            mode,
            load_ms: started.elapsed().as_millis(),
            build_script_error,
            proc_macro,
            revision: 0,
        })
    }

    pub fn ready(&self) -> Value {
        json!({
            "event": "ready", "upstream": {"package": "ra_ap_hir", "version": "0.0.358", "modified": false},
            "workspace": self.root, "loaded_files": self.vfs.iter().count(), "load_ms": self.load_ms,
            "build_scripts_requested": matches!(self.mode, WorkspaceMode::BuildScripts),
            "build_script_error": self.build_script_error, "proc_macro_server_running": self.proc_macro.is_some(),
            "methods": ["function", "lower", "references", "expand_macro", "change_file", "change_files"],
            "scalar_ir_version": ash_rust_build_ir::VERSION,
            "limits": {"new_files_or_cargo_changes": "restart_required", "diagnostics": "not_a_rustc_check",
                "call_graph": "syntax_calls_only_not_complete_invalidation", "mir": "structured_summary_and_debug_text_not_codegen_ir",
                "layout": "rust_analyzer_estimate_not_rustc_abi_proof", "editor_cache": "independent_database"}
        })
    }

    pub fn execute(&mut self, query: Query) -> Result<Value, Error> {
        match query {
            Query::Function { path, byte_offset } => self.function(&path, byte_offset),
            Query::Lower { path, byte_offset } => {
                let position = self.position(&path, byte_offset)?;
                let db: &dyn HirDatabase = self.host.raw_database();
                ra_ap_hir::attach_db(db, || {
                    let sema = Semantics::new_dyn(db);
                    let parsed = sema.parse_guess_edition(position.file_id);
                    let resolve_source = |id| {
                        let path = PathBuf::from(self.vfs.file_path(id).to_string());
                        let relative = path
                            .strip_prefix(&self.root)
                            .map_err(|_| "callee source is outside the workspace")?;
                        let text = self
                            .host
                            .analysis()
                            .file_text(id)
                            .map_err(|error| format!("{error:?}"))?;
                        Ok(ash_rust_build_ir::Source {
                            path: relative.to_string_lossy().replace('\\', "/"),
                            text: text.to_string(),
                        })
                    };
                    let result =
                        crate::lower::program(db, &sema, &parsed, position.offset, &resolve_source);
                    let result = match result {
                        Ok(program) => ash_rust_build_ir::Lowered::Available { program },
                        Err(reason) => ash_rust_build_ir::Lowered::Unsupported { reason },
                    };
                    serde_json::to_value(result)
                        .map_err(|error| Error::new("analysis_failed", error))
                })
            }
            Query::References {
                path,
                byte_offset,
                exclude_imports,
            } => self.references(&path, byte_offset, exclude_imports),
            Query::ExpandMacro { path, byte_offset } => {
                let position = self.position(&path, byte_offset)?;
                let expansion = self
                    .host
                    .analysis()
                    .expand_macro(position)
                    .map_err(analysis_error)?;
                match expansion {
                    Some(expansion) => {
                        Ok(json!({"name": expansion.name, "expansion": expansion.expansion}))
                    }
                    None => Err(Error::new(
                        "not_found",
                        "no expandable macro at this position; check workspace loading mode",
                    )),
                }
            }
            Query::ChangeFile { path, text } => {
                if text.len() > MAX_FILE_BYTES {
                    return Err(Error::new(
                        "budget_exceeded",
                        "file exceeds bridge byte budget",
                    ));
                }
                let (file_id, path) = self.file(&path)?;
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| Error::new("analysis_failed", "revision exhausted"))?;
                let mut change = ChangeWithProcMacros::default();
                change.change_file(file_id, Some(text.clone()));
                self.host.apply_change(change);
                self.vfs.set_file_contents(path, Some(text.into_bytes()));
                let _ = self.vfs.take_changes();
                self.revision = revision;
                Ok(json!({"changed": true, "disk_modified": false}))
            }
            Query::ChangeFiles { files } => {
                if files.is_empty() || files.len() > 64 {
                    return Err(Error::new("invalid_request", "invalid source batch size"));
                }
                let mut seen = std::collections::HashSet::new();
                let mut pending = Vec::new();
                for file in files {
                    if file.text.len() > MAX_FILE_BYTES {
                        return Err(Error::new(
                            "budget_exceeded",
                            "file exceeds bridge byte budget",
                        ));
                    }
                    let (id, path) = self.file(&file.path)?;
                    if !seen.insert(id) {
                        return Err(Error::new("invalid_request", "duplicate source in batch"));
                    }
                    pending.push((id, path, file.text));
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| Error::new("analysis_failed", "revision exhausted"))?;
                let mut change = ChangeWithProcMacros::default();
                for (id, _, text) in &pending {
                    change.change_file(*id, Some(text.clone()));
                }
                self.host.apply_change(change);
                for (_, path, text) in pending {
                    self.vfs.set_file_contents(path, Some(text.into_bytes()));
                }
                let _ = self.vfs.take_changes();
                self.revision = revision;
                Ok(json!({"changed": true, "disk_modified": false}))
            }
        }
    }

    fn file(&self, path: &str) -> Result<(FileId, VfsPath), Error> {
        if path.is_empty() || path.len() > 4096 {
            return Err(Error::new("invalid_request", "invalid source path"));
        }
        let path = dunce::canonicalize(self.root.join(path))
            .map_err(|error| Error::new("not_found", error))?;
        if !path.starts_with(&self.root)
            || path.extension().is_none_or(|extension| extension != "rs")
        {
            return Err(Error::new(
                "invalid_request",
                "source must be a Rust file inside the workspace",
            ));
        }
        path.to_str()
            .ok_or_else(|| Error::new("invalid_request", "source path must be UTF-8"))?;
        let path = VfsPath::from(AbsPathBuf::assert_utf8(path));
        let (file_id, excluded) = self
            .vfs
            .file_id(&path)
            .ok_or_else(|| Error::new("not_found", "file was not loaded; restart for new files"))?;
        if excluded != FileExcluded::No {
            return Err(Error::new("not_found", "file is excluded"));
        }
        Ok((file_id, path))
    }

    fn position(&self, path: &str, byte_offset: u32) -> Result<FilePosition, Error> {
        let (file_id, _) = self.file(path)?;
        let text = self
            .host
            .analysis()
            .file_text(file_id)
            .map_err(analysis_error)?;
        if text.len() > MAX_FILE_BYTES {
            return Err(Error::new(
                "budget_exceeded",
                "file exceeds bridge byte budget",
            ));
        }
        if !text.is_char_boundary(byte_offset as usize) {
            return Err(Error::new(
                "invalid_request",
                "offset must be an in-bounds UTF-8 byte boundary",
            ));
        }
        Ok(FilePosition {
            file_id,
            offset: TextSize::from(byte_offset),
        })
    }

    fn function(&self, path: &str, byte_offset: u32) -> Result<Value, Error> {
        let started = Instant::now();
        let position = self.position(path, byte_offset)?;
        let db = self.host.raw_database();
        ra_ap_hir::attach_db(db, || {
            let sema = Semantics::new(db);
            let parsed = sema.parse_guess_edition(position.file_id);
            let function = parsed
                .syntax()
                .token_at_offset(position.offset)
                .right_biased()
                .and_then(|token| token.parent_ancestors().find_map(ast::Fn::cast))
                .ok_or_else(|| {
                    Error::new("not_found", "position is not inside a source function")
                })?;
            let definition = sema.to_def(&function).ok_or_else(|| {
                Error::new("not_found", "function is inactive or cannot be resolved")
            })?;
            let target = definition.module(db).krate(db).to_display_target(db);
            let parameters: Vec<_> = definition
                .params_without_self(db)
                .iter()
                .map(|parameter| describe_type(db, target, parameter.ty()))
                .collect();
            let mut expressions = Vec::new();
            let mut calls = Vec::new();
            let mut expression_count = 0;
            let mut call_count = 0;
            if let Some(body) = function.body() {
                for expression in body.syntax().descendants().filter_map(ast::Expr::cast) {
                    expression_count += 1;
                    if expressions.len() < MAX_ITEMS
                        && let Some(info) = sema.type_of_expr(&expression)
                    {
                        expressions.push(json!({"range": range(expression.syntax().text_range()),
                            "type": describe_type(db, target, &info.adjusted())}));
                    }
                    let callable = match &expression {
                        ast::Expr::CallExpr(call) => Some(
                            call.expr()
                                .and_then(|callee| sema.resolve_expr_as_callable(&callee))
                                .and_then(|callable| callable.as_function()),
                        ),
                        ast::Expr::MethodCallExpr(call) => Some(sema.resolve_method_call(call)),
                        _ => None,
                    };
                    if let Some(callee) = callable {
                        call_count += 1;
                        if calls.len() < MAX_ITEMS {
                            let resolved = callee.map(|function| self.describe_function(function));
                            calls.push(json!({"range": range(expression.syntax().text_range()), "resolved_function": resolved}));
                        }
                    }
                }
            }
            let mir = match FunctionId::try_from(definition) {
                Ok(id) => match db.mir_body(id.into()) {
                    Ok(body) => {
                        json!({"status": "available", "api": "hir::db::HirDatabase::mir_body",
                        "block_count": body.basic_blocks.len(), "local_count": body.locals.len(),
                        "parameter_count": body.param_locals.len(), "closure_count": body.closures.len(),
                        "blocks": body.basic_blocks.iter().take(MAX_ITEMS).map(|(_, block)| json!({
                            "statement_count": block.statements.len(), "has_terminator": block.terminator.is_some(), "is_cleanup": block.is_cleanup
                        })).collect::<Vec<_>>(), "blocks_truncated": body.basic_blocks.len() > MAX_ITEMS,
                        "debug_text": clipped(body.pretty_print(db, target), 256 * 1024)})
                    }
                    Err(error) => json!({"status": "unavailable", "reason": format!("{error:?}")}),
                },
                Err(()) => {
                    json!({"status": "unavailable", "reason": "synthesized function has no source FunctionId"})
                }
            };
            Ok(json!({"function": self.describe_function(definition),
                "signature": definition.display(db, target).to_string(), "generic_parameter_count": GenericDef::from(definition).params(db).len(),
                "is_async": definition.is_async(db), "parameters": parameters, "return_type": describe_type(db, target, &definition.ret_type(db)),
                "expressions": expressions, "expressions_truncated": expression_count > MAX_ITEMS,
                "syntax_calls": calls, "calls_truncated": call_count > MAX_ITEMS, "mir": mir,
                "query_ms": started.elapsed().as_millis()}))
        })
    }

    fn describe_function(&self, function: Function) -> Value {
        let db = self.host.raw_database();
        let source = function.source(db).map(|source| {
            let original = source.as_ref().map(|node| node.syntax()).original_file_range_rooted(db);
            json!({"path": self.vfs.file_path(original.file_id.file_id(db)).to_string(), "range": range(original.range)})
        });
        json!({"name": function.name(db).as_str(), "source": source,
            "crate": function.module(db).krate(db).display_name(db).map(|name| name.to_string())})
    }

    fn references(
        &self,
        path: &str,
        byte_offset: u32,
        exclude_imports: bool,
    ) -> Result<Value, Error> {
        let position = self.position(path, byte_offset)?;
        let config = FindAllRefsConfig {
            search_scope: None,
            ra_fixture: RaFixtureConfig::default(),
            exclude_imports,
            exclude_tests: false,
        };
        let results = self
            .host
            .analysis()
            .find_all_refs(position, &config)
            .map_err(analysis_error)?
            .ok_or_else(|| Error::new("not_found", "no symbol at this position"))?;
        let mut references = Vec::new();
        let mut count = 0;
        for result in results {
            for (file, ranges) in result.references {
                for (reference, _) in ranges {
                    count += 1;
                    if references.len() < MAX_ITEMS {
                        references.push(json!({"path": self.vfs.file_path(file).to_string(), "range": range(reference)}));
                    }
                }
            }
        }
        references.sort_by_key(Value::to_string);
        Ok(json!({"references": references, "truncated": count > MAX_ITEMS}))
    }
}

fn analysis_error(error: impl std::fmt::Debug) -> Error {
    Error::new("analysis_failed", format!("{error:?}"))
}

fn range(range: TextRange) -> Value {
    json!({"start": u32::from(range.start()), "end": u32::from(range.end())})
}

fn clipped(mut text: String, maximum: usize) -> Value {
    let truncated = text.len() > maximum;
    if truncated {
        let mut end = maximum;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    json!({"text": text, "truncated": truncated})
}

fn describe_type(db: &ra_ap_ide::RootDatabase, target: DisplayTarget, ty: &Type<'_>) -> TypeReport {
    let layout = match ty.layout(db) {
        Ok(layout) => Probe::Available {
            value: Layout {
                size_bytes: layout.size(),
                alignment_bytes: layout.align(),
            },
        },
        Err(error) => Probe::Unavailable {
            reason: format!("{error:?}"),
        },
    };
    TypeReport {
        display: ty.display(db, target).to_string(),
        contains_unknown: ty.contains_unknown(),
        layout,
    }
}
