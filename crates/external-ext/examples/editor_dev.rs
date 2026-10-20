//! Explicit local-code development host. Never used by production package admission.
use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::io::BufRead;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_external_ext::ActivateParams;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::ExtensionActivationSpec;
use ash_external_ext::ExtensionCapability;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::PackageBinding;
use ash_external_ext::ProcessIsolationPolicy;
use ash_external_ext::RestartPolicy;
use ash_external_ext::TrustedDevelopmentLauncher;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

struct LocalAuthority;
struct LocalLease;
impl ActivationLease for LocalLease {}
impl ActivationAuthority for LocalAuthority {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        Some(Box::new(LocalLease))
    }
}

// Shutdown also runs on an invocation or input error; no orphan is left on early return.
struct Running(ExtensionHostSupervisor);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}

fn start(root: &PathBuf, binary: &str, id: &str) -> Result<Running, Box<dyn Error>> {
    let executable = root.join(binary).canonicalize()?;
    if !executable.starts_with(root) || !executable.is_file() {
        return Err("Executable escapes development project".into());
    }
    let digest = format!("sha256:{:x}", Sha256::digest(std::fs::read(&executable)?));
    let host = ExtensionHostSupervisor::new(
        Arc::new(TrustedDevelopmentLauncher),
        ExtensionLaunchCommand::new(
            executable,
            Vec::<String>::new(),
            root.clone(),
            BTreeMap::new(),
        )?,
        ExtensionActivationSpec::new(
            ActivateParams {
                initialization: None,
                extension_id: id.into(),
                package: PackageBinding {
                    package_id: format!("development/{id}@0.0.0"),
                    package_digest: digest,
                    entrypoint: binary.replace('\\', "/"),
                },
                runtime_api_version: 1,
                activation_events: vec!["startup".into()],
                capabilities: vec![ExtensionCapability::DataChannel],
            },
            NonZeroU64::new(1).ok_or("Invalid activation generation")?,
            Arc::new(LocalAuthority),
        ),
        ExtensionHostLimits {
            isolation: ProcessIsolationPolicy::TrustedDevelopment,
            ..ExtensionHostLimits::default()
        },
        RestartPolicy::default(),
    )?;
    let running = Running(host);
    running.0.start()?;
    status(&running);
    Ok(running)
}

fn status(running: &Running) {
    let snapshot = running.0.snapshot();
    println!(
        "{}",
        json!({"event":"status", "status":format!("{:?}", snapshot.status), "packageDigest":snapshot.package.package_digest, "registrations":snapshot.registrations, "stderr":snapshot.stderr, "output":format!("{:?}", snapshot.output_events)})
    );
}

fn describe(running: &Running, root: &PathBuf, language: &str) -> Result<(), Box<dyn Error>> {
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .checked_add(Duration::from_secs(10))
        .ok_or("Invalid deadline")?
        .as_millis();
    let result = running.0.invoke(ExtensionInvocation {
        registration_id: "editor.client.v1".into(),
        operation: "receiveData".into(),
        payload: json!({"operation":"describe", "language":language}),
        deadline_unix_millis: NonZeroU64::new(u64::try_from(deadline)?)
            .ok_or("Invalid deadline")?,
    })?;
    let client: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("dist/client.json"))?)?;
    if result.payload["clientDigest"] != client["sourceDigest"]
        || result.payload["clientModule"] != client["entry"]
    {
        return Err(
            "Native/client source mismatch; rebuild native and browser sources before loading"
                .into(),
        );
    }
    println!(
        "{}",
        json!({"event":"description", "language":language, "result":result.payload})
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments.len() != 4 || arguments[0] != "--allow-local-code" {
        return Err("Usage: editor_dev --allow-local-code <project> <relative-executable> <extension-id>; runs trusted local code without OS isolation".into());
    }
    let root = PathBuf::from(&arguments[1]).canonicalize()?;
    let binary = &arguments[2];
    let id = &arguments[3];
    if !root.is_dir()
        || binary.is_empty()
        || PathBuf::from(binary).is_absolute()
        || binary
            .split(['/', '\\'])
            .any(|p| p.is_empty() || p == "." || p == "..")
        || id.len() > 256
        || !id.contains('.')
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return Err("Invalid development project, relative executable or extension ID".into());
    }
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ])?;
    let (send, receive) = mpsc::channel();
    let interrupt = send.clone();
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            let _ = interrupt.send(None);
        }
    });
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if send.send(Some(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = send.send(None);
    });
    let mut running = start(&root, binary, id)?;
    describe(&running, &root, "en")?;
    while let Some(line) = receive.recv()? {
        let words: Vec<_> = line.split_whitespace().collect();
        let result = match words.as_slice() {
            ["status"] => {
                status(&running);
                Ok(())
            }
            ["describe", language] => describe(&running, &root, language),
            ["reload"] => {
                running.0.shutdown()?;
                running = start(&root, binary, id)?;
                describe(&running, &root, "en")
            }
            ["quit"] => break,
            _ => Err("Commands: status | describe <language> | reload | quit".into()),
        };
        if let Err(error) = result {
            println!("{}", json!({"event":"error", "message":error.to_string()}));
        }
    }
    running.0.shutdown()?;
    println!("{}", json!({"event":"stopped"}));
    Ok(())
}
