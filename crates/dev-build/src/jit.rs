//! Development code generation with an independent rustc metadata gate.
//! No replacement is executable until that check and input revalidation succeed.

use crate::function::Snapshot;
use ash_rust_build_ir as ir;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::time::Instant;

pub(crate) fn check(
    repository: &Path,
    directory: &Path,
    program: &ir::Program,
    checker: &mut crate::check::Checker,
) -> Result<bool, String> {
    if program.check == ir::CheckMode::Package {
        let root = &program.functions[program.root as usize];
        let package = crate::workspace::Package::for_source(repository, &root.source_path)?;
        package.verify_library(repository, program)?;
        let snapshot = package.snapshot(repository)?;
        return checker
            .check(
                repository,
                &package,
                &snapshot,
                &directory.join("check"),
                crate::check::Policy::Reuse,
            )
            .map(|report| report.success && !report.invalidated);
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let root = &program.functions[program.root as usize];
    let mut source = program
        .functions
        .iter()
        .map(|function| function.source.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let parameters = root
        .parameters
        .iter()
        .enumerate()
        .map(|(index, parameter)| {
            format!("p{index}: {}", root.locals[*parameter as usize].rust_name())
        })
        .collect::<Vec<_>>()
        .join(", ");
    let arguments = (0..root.parameters.len())
        .map(|index| format!("p{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    source.push_str(&format!(
        "\npub fn ash_check_entry({parameters}) -> {} {{ {}({arguments}) }}\n",
        root.result.rust_name(),
        root.name
    ));
    let source_path = directory.join("check.rs");
    std::fs::File::create(&source_path)
        .and_then(|mut file| file.write_all(source.as_bytes()))
        .map_err(|error| error.to_string())?;
    let result = Command::new("rustc")
        .current_dir(repository)
        .args([
            "--edition=2024",
            "--crate-name=ash_scalar_check",
            "--crate-type=lib",
            "--emit=metadata",
        ])
        .arg(&source_path)
        .arg("-o")
        .arg(directory.join("check.rmeta"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !result.stderr.is_empty() {
        eprint!("{}", String::from_utf8_lossy(&result.stderr));
    }
    Ok(result.status.success())
}

pub(crate) fn build(
    repository: &Path,
    directory: &Path,
    source: &Snapshot,
    program: &ir::Program,
    checker: &mut crate::check::Checker,
) -> Result<bool, String> {
    let root = &program.functions[program.root as usize];
    if root.name != "zero_based_line_index"
        || root.result != ir::Scalar::Usize
        || root.parameters.len() != 1
        || root.locals[root.parameters[0] as usize] != ir::Scalar::Usize
    {
        return Ok(false);
    }
    crate::workspace::Package::for_source(repository, &root.source_path)?
        .verify_library(repository, program)?;
    let started = Instant::now();
    if !check(repository, directory, program, checker)? {
        return Ok(false);
    }
    let checked = started.elapsed();
    let image =
        match crate::codegen::compile(program, overflow_checks(repository, "ash-app-server-diff")?)
        {
            Ok(image) => image,
            Err(error) => {
                eprintln!("[ash-build] Native code generation requires Cargo: {error}");
                return Ok(false);
            }
        };
    let generated = started.elapsed();
    if crate::function::snapshot(repository)?.full != source.full {
        return Err("adapter changed during native code generation; retry the build".into());
    }
    crate::build::publish(directory, &image, crate::reload::ImageKind::UsizeCode)?;
    eprintln!(
        "[ash-build] Cranelift: rustc-check {:.3}ms, codegen {:.3}ms, publish {:.3}ms",
        checked.as_secs_f64() * 1000.0,
        (generated - checked).as_secs_f64() * 1000.0,
        (started.elapsed() - generated).as_secs_f64() * 1000.0
    );
    Ok(true)
}

pub(crate) fn overflow_checks(repository: &Path, package_name: &str) -> Result<bool, String> {
    let root: toml::Value = toml::from_str(
        &std::fs::read_to_string(repository.join("Cargo.toml"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let profiles = root.get("profile");
    let mut chain = Vec::new();
    let mut name = "dev-small";
    let mut overflow;
    loop {
        if chain.contains(&name) || chain.len() >= 16 {
            return Err("invalid development profile inheritance".into());
        }
        chain.push(name);
        match name {
            "dev" | "test" => {
                overflow = true;
                break;
            }
            "release" | "bench" => {
                overflow = false;
                break;
            }
            _ => {
                name = profiles
                    .and_then(|profiles| profiles.get(name))
                    .and_then(|profile| profile.get("inherits"))
                    .and_then(toml::Value::as_str)
                    .ok_or("development profile has no supported base")?
            }
        }
    }
    // Cargo first merges inherited profiles, then applies wildcard and exact
    // package overrides. A parent package override also beats a child global.
    for name in chain.iter().rev() {
        if let Some(value) = profiles
            .and_then(|profiles| profiles.get(name))
            .and_then(|profile| profile.get("overflow-checks"))
            .and_then(toml::Value::as_bool)
        {
            overflow = value;
        }
    }
    for package in ["*", package_name] {
        for name in chain.iter().rev() {
            if let Some(overrides) = profiles
                .and_then(|profiles| profiles.get(name))
                .and_then(|profile| profile.get("package"))
                .and_then(toml::Value::as_table)
            {
                if overrides.iter().any(|(name, value)| {
                    name != "*"
                        && !name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                        && value.get("overflow-checks").is_some()
                }) {
                    return Err("version-qualified overflow overrides require Cargo".into());
                }
                if let Some(value) = overrides
                    .get(package)
                    .and_then(|profile| profile.get("overflow-checks"))
                    .and_then(toml::Value::as_bool)
                {
                    overflow = value;
                }
            }
        }
    }
    Ok(overflow)
}

#[cfg(test)]
#[path = "jit_tests.rs"]
mod tests;

/// Exercises ordinary scalar functions from any source path through the same
/// bridge, verifier, metadata check, code generator and executable image loader.
pub fn evaluate(
    repository: &Path,
    bridge: &Path,
    path: &str,
    offset: u32,
    arguments: &[u64],
) -> Result<u64, String> {
    let repository = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let source_path = repository
        .join(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !source_path.starts_with(&repository)
        || source_path
            .extension()
            .is_none_or(|extension| extension != "rs")
        || std::fs::metadata(&source_path)
            .map_err(|error| error.to_string())?
            .len()
            > 2 * 1024 * 1024
    {
        return Err("evaluation source must be a bounded Rust file inside the workspace".into());
    }
    let path = source_path
        .strip_prefix(&repository)
        .map_err(|error| error.to_string())?
        .to_str()
        .ok_or("non-UTF-8 source path")?
        .replace('\\', "/");
    let package = crate::workspace::Package::for_source(&repository, &path)?;
    let snapshot = package.snapshot(&repository)?;
    snapshot.verify_configuration()?;
    let text = snapshot
        .files
        .get(&path)
        .ok_or("source is not part of its owning package")?;
    let mut client = crate::analysis::Client::start(bridge, &repository)?;
    client.sync(&snapshot.sources())?;
    let (lowered, _) = client.graph(&path, offset)?;
    let ir::Lowered::Available { program } = lowered else {
        return Err("function is outside the scalar MIR subset".into());
    };
    snapshot.verify_program(&program)?;
    package.verify_library(&repository, &program)?;
    let directory = repository.join(".build/jit-evaluate").join(format!(
        "{}-{}-{offset}",
        crate::reload::digest(text.as_bytes()),
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(
        directory.join("lowered.json"),
        serde_json::to_vec_pretty(&program).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if !check(
        &repository,
        &directory,
        &program,
        &mut crate::check::Checker::default(),
    )? {
        return Err("rustc rejected the function graph".into());
    }
    let image = crate::codegen::compile(&program, overflow_checks(&repository, &package.name)?)?;
    if package.snapshot(&repository)?.digest() != snapshot.digest() {
        return Err("package changed during evaluation; retry".into());
    }
    crate::machine::Code::load(&image)?.call(arguments)
}
