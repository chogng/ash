use crate::ABI_VERSION;
use crate::contract_directory;
use crate::function;
use crate::reload::ImageKind;
use crate::reload::Manifest;
use crate::reload::Module;
use crate::reload::digest;
use crate::reload::image_path;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Only watcher batches confined to the adapter may request function compilation.
/// Initial preparation and dependency changes must refresh the complete module.
pub enum BuildMode {
    Module,
    Functions,
}

/// Builds the stateless diff module with Cargo's full input and borrow checking.
///
/// The caller holds Ash's normal Cargo cache lease. A failed compiler or publisher
/// cannot advance the current generation. The module and host exchange JSON over
/// C ABI, so Windows may use distinct CRTs without sharing their allocations.
pub fn build_diff(repository: &Path, directory: &Path) -> Result<(), String> {
    build(
        repository,
        directory,
        BuildMode::Module,
        "",
        &mut crate::check::Checker::default(),
        &mut |_| Ok(None),
    )
    .map(|_| ())
}

pub(crate) fn build(
    repository: &Path,
    directory: &Path,
    mode: BuildMode,
    compiler: &str,
    checker: &mut crate::check::Checker,
    verify: &mut impl FnMut(&function::Snapshot) -> Result<Option<Value>, String>,
) -> Result<&'static str, String> {
    let started = Instant::now();
    let metadata_path = repository.join(".build/protocol/metadata.json");
    let metadata = std::fs::read(&metadata_path).map_err(|error| error.to_string())?;
    let protocol: Value = serde_json::from_slice(&metadata).map_err(|error| error.to_string())?;
    let contract = protocol["schemaHash"]
        .as_str()
        .ok_or("protocol metadata has no schema hash")?;
    let directory = contract_directory(directory, contract);
    let directory = directory.as_path();
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("build.lock"))
        .map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    if matches!(mode, BuildMode::Functions)
        && function::build(repository, directory, compiler, verify, checker)?
    {
        eprintln!(
            "[ash-build] Function published in {:.3}s",
            started.elapsed().as_secs_f64()
        );
        return Ok("function");
    }
    let source = function::snapshot(repository)?;
    // Each full module owns a distinct function namespace. An older in-flight
    // module must never select replacements compiled for a newer baseline.
    let generation = digest(
        format!(
            "{}:{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        )
        .as_bytes(),
    );
    let mut command = Command::new("cargo");
    command.current_dir(repository).args([
        "build",
        "--locked",
        "--package",
        "ash-app-server-diff-live",
        "--lib",
        "--profile",
        "dev-small",
        "--message-format=json-render-diagnostics",
    ]);
    command.env("ASH_DIFF_LIVE_GENERATION", &generation);
    let artifact = compile(command, "ash_app_server_diff_live")?;
    if std::fs::read(metadata_path).map_err(|error| error.to_string())? != metadata {
        return Err("protocol changed during module compilation; retry the build".into());
    }
    let bytes = std::fs::read(artifact).map_err(|error| error.to_string())?;
    if function::snapshot(repository)?.full != source.full {
        return Err("adapter changed during module compilation; retry the build".into());
    }
    let publication = prepare_publication(directory, &bytes, ImageKind::Json)?;
    function::save_baseline(
        repository,
        directory,
        &source,
        &generation,
        &publication.manifest,
    )?;
    // The RPC consumer may observe current.json immediately. Finish every
    // fallible baseline check before making this generation visible.
    publication.commit()?;
    eprintln!(
        "[ash-build] Diff module published in {:.3}s",
        started.elapsed().as_secs_f64()
    );
    Ok("module")
}

pub(crate) fn compile(mut command: Command, target: &str) -> Result<PathBuf, String> {
    // The persistent server owns stdin for its protocol. Build scripts and Cargo
    // must not inherit that pipe or consume a queued build request.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut artifact = None;
    for line in BufReader::new(child.stdout.take().ok_or("missing Cargo stdout")?).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(rendered) = message.pointer("/message/rendered").and_then(Value::as_str) {
            eprint!("{rendered}");
        }
        if message["reason"] == "compiler-artifact"
            && message["target"]["name"] == target
            && let Some(files) = message["filenames"].as_array()
        {
            artifact = files
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .find(|path| {
                    path.extension()
                        .is_some_and(|it| it == std::env::consts::DLL_EXTENSION)
                });
        }
    }
    if !child.wait().map_err(|error| error.to_string())?.success() {
        return Err("compilation failed; previous generation retained".into());
    }
    artifact.ok_or_else(|| "Cargo reported no development dynamic library".into())
}

pub(crate) fn publish(directory: &Path, bytes: &[u8], kind: ImageKind) -> Result<(), String> {
    prepare_publication(directory, bytes, kind)?.commit()
}

struct Publication<'a> {
    directory: &'a Path,
    manifest: Vec<u8>,
    kind: ImageKind,
}

fn prepare_publication<'a>(
    directory: &'a Path,
    bytes: &[u8],
    kind: ImageKind,
) -> Result<Publication<'a>, String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let sha256 = digest(bytes);
    let path = image_path(directory, &sha256);
    std::fs::create_dir_all(path.parent().ok_or("module image has no parent")?)
        .map_err(|error| error.to_string())?;
    if !path.exists() {
        let temporary = directory.join("module.tmp");
        std::fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
        std::fs::rename(temporary, &path).map_err(|error| error.to_string())?;
    } else if digest(&std::fs::read(&path).map_err(|error| error.to_string())?) != sha256 {
        return Err("immutable module image was modified".into());
    }
    let manifest = Manifest {
        version: ABI_VERSION,
        sha256,
        kind,
    };
    // Refuse unloadable images or broken exports before advancing the pointer.
    drop(Module::load(directory, &manifest)?);
    let manifest = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    Ok(Publication {
        directory,
        manifest,
        kind,
    })
}

impl Publication<'_> {
    fn commit(self) -> Result<(), String> {
        let current = self.directory.join("current.json");
        if std::fs::read(&current).ok().as_deref() != Some(&self.manifest) {
            let temporary = self.directory.join("current.tmp");
            let mut file = std::fs::File::create(&temporary).map_err(|error| error.to_string())?;
            file.write_all(&self.manifest)
                .map_err(|error| error.to_string())?;
            // Code images are disposable development cache entries. Atomic visibility
            // matters; power-loss durability does not. Corrupt images are rejected.
            if self.kind != ImageKind::UsizeCode {
                file.sync_all().map_err(|error| error.to_string())?;
            }
            drop(file);
            std::fs::rename(temporary, current).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}
