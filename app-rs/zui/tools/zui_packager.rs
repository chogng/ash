use std::path::PathBuf;
use std::process::ExitCode;

use zui::distribution::ArtifactSigner;
use zui::distribution::BundleBuilder;
use zui::distribution::BundleManifest;
use zui::distribution::BundleTarget;
use zui::distribution::InstallerBuilder;
use zui::distribution::InstallerTarget;
use zui::distribution::LinuxSigning;
use zui::distribution::MacOsApplicationSigning;
use zui::distribution::MacOsPackageSigning;
use zui::distribution::SigningPlan;
use zui::distribution::SystemInstallerTool;
use zui::distribution::SystemSigningTool;
use zui::distribution::WindowsSigning;

fn main() -> ExitCode {
    match run(std::env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("zui-packager: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Vec<std::ffi::OsString>) -> Result<(), String> {
    if arguments.len() < 3 || arguments.len() > 4 {
        return Err(
            "usage: zui-packager <bundle|installer|release> <manifest.json> <output-directory> [macos|linux|windows]"
                .to_owned(),
        );
    }
    let operation = arguments[0].to_string_lossy();
    if operation != "bundle" && operation != "installer" && operation != "release" {
        return Err("first argument must be `bundle`, `installer`, or `release`".to_owned());
    }
    let manifest_path = PathBuf::from(&arguments[1]);
    let output_directory = PathBuf::from(&arguments[2]);
    let target = match arguments.get(3) {
        Some(target) => parse_target(target.to_string_lossy().as_ref())?,
        None => current_targets()?,
    };
    let bytes = std::fs::read(&manifest_path)
        .map_err(|error| format!("could not read {}: {error}", manifest_path.display()))?;
    let manifest_directory = manifest_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let manifest = BundleManifest::from_json(&bytes)
        .map_err(|error| error.to_string())?
        .resolve_paths_from(manifest_directory);
    let release_signing = if operation == "release" {
        Some(release_signing(target.0)?)
    } else {
        None
    };
    let bundle = BundleBuilder::build(&manifest, target.0, &output_directory)
        .map_err(|error| error.to_string())?;
    if operation == "bundle" {
        println!("{}", bundle.root.display());
        return Ok(());
    }
    if let Some(signing) = &release_signing {
        sign_bundle(&bundle, signing)?;
    }
    let installer = InstallerBuilder::build(
        &manifest,
        &bundle,
        target.1,
        output_directory,
        &SystemInstallerTool,
    )
    .map_err(|error| error.to_string())?;
    if let Some(signing) = &release_signing {
        let signed = sign_installer(installer.artifact, signing)?;
        println!("{}", signed.artifact.display());
        for artifact in signed.auxiliary_artifacts {
            println!("{}", artifact.display());
        }
    } else {
        println!("{}", installer.artifact.display());
    }
    Ok(())
}

fn sign_bundle(
    bundle: &zui::distribution::BundleOutput,
    signing: &ReleaseSigning,
) -> Result<(), String> {
    match signing {
        ReleaseSigning::MacOs { application, .. } => {
            execute_signing(ArtifactSigner::macos_application(&bundle.root, application))?;
        }
        ReleaseSigning::Windows(config) => {
            execute_signing(ArtifactSigner::windows(&bundle.executable, config))?;
            for helper in &bundle.helpers {
                execute_signing(ArtifactSigner::windows(helper, config))?;
            }
        }
        ReleaseSigning::Linux(_) => {}
    }
    Ok(())
}

fn sign_installer(
    artifact: PathBuf,
    signing: &ReleaseSigning,
) -> Result<zui::distribution::SigningOutput, String> {
    let plan = match signing {
        ReleaseSigning::MacOs { package, .. } => {
            ArtifactSigner::macos_package(artifact, package).map_err(|error| error.to_string())?
        }
        ReleaseSigning::Linux(config) => {
            ArtifactSigner::linux_appimage(artifact, config).map_err(|error| error.to_string())?
        }
        ReleaseSigning::Windows(config) => ArtifactSigner::windows(artifact, config),
    };
    execute_signing(plan)
}

fn execute_signing(plan: SigningPlan) -> Result<zui::distribution::SigningOutput, String> {
    ArtifactSigner::execute(plan, &SystemSigningTool).map_err(|error| error.to_string())
}

enum ReleaseSigning {
    MacOs {
        application: MacOsApplicationSigning,
        package: MacOsPackageSigning,
    },
    Linux(LinuxSigning),
    Windows(WindowsSigning),
}

fn release_signing(target: BundleTarget) -> Result<ReleaseSigning, String> {
    match target {
        BundleTarget::MacOsApplication => Ok(ReleaseSigning::MacOs {
            application: MacOsApplicationSigning::new(required_env(
                "ZUI_MACOS_APPLICATION_IDENTITY",
            )?)
            .map_err(|error| error.to_string())?,
            package: MacOsPackageSigning::new(
                required_env("ZUI_MACOS_INSTALLER_IDENTITY")?,
                required_env("ZUI_MACOS_NOTARY_PROFILE")?,
            )
            .map_err(|error| error.to_string())?,
        }),
        BundleTarget::LinuxAppDir => Ok(ReleaseSigning::Linux(
            LinuxSigning::new(required_env("ZUI_LINUX_GPG_KEY_ID")?)
                .map_err(|error| error.to_string())?,
        )),
        BundleTarget::WindowsPortable => Ok(ReleaseSigning::Windows(
            WindowsSigning::new(
                required_env("ZUI_WINDOWS_CERTIFICATE_SHA1")?,
                required_env("ZUI_WINDOWS_TIMESTAMP_URL")?,
            )
            .map_err(|error| error.to_string())?,
        )),
    }
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("release signing requires environment variable `{name}`"))
}

fn parse_target(value: &str) -> Result<(BundleTarget, InstallerTarget), String> {
    match value {
        "macos" => Ok((
            BundleTarget::MacOsApplication,
            InstallerTarget::MacOsPackage,
        )),
        "linux" => Ok((BundleTarget::LinuxAppDir, InstallerTarget::LinuxAppImage)),
        "windows" => Ok((BundleTarget::WindowsPortable, InstallerTarget::WindowsMsi)),
        _ => Err(format!("unsupported bundle target `{value}`")),
    }
}

fn current_targets() -> Result<(BundleTarget, InstallerTarget), String> {
    let bundle = BundleTarget::current()
        .ok_or_else(|| format!("unsupported build host `{}`", std::env::consts::OS))?;
    let installer = InstallerTarget::current()
        .ok_or_else(|| format!("unsupported build host `{}`", std::env::consts::OS))?;
    Ok((bundle, installer))
}
