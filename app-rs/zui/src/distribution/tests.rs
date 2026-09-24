use std::fs;
use std::sync::Mutex;

use super::AppIdentifier;
use super::AppVersion;
use super::ArtifactSigner;
use super::BundleBuilder;
use super::BundleManifest;
use super::BundleResource;
use super::BundleTarget;
use super::InstallerBuilder;
use super::InstallerCommand;
use super::InstallerTarget;
use super::InstallerTool;
use super::InstallerToolError;
use super::LinuxSigning;
use super::MacOsApplicationSigning;
use super::MacOsPackageSigning;
use super::ProtocolScheme;
use super::ResourcePath;
use super::SigningCommand;
use super::SigningTool;
use super::SigningToolError;
use super::WindowsSigning;

fn manifest(directory: &std::path::Path) -> BundleManifest {
    let executable = directory.join("demo-bin");
    fs::write(&executable, b"executable").unwrap();
    BundleManifest::new(
        "Demo",
        AppIdentifier::new("com.example.demo").unwrap(),
        AppVersion::parse("1.2.3").unwrap(),
        executable,
    )
    .unwrap()
    .with_protocol(ProtocolScheme::new("demo").unwrap())
}

#[test]
fn platform_layouts_emit_protocol_manifests_and_executables() {
    for target in [
        BundleTarget::MacOsApplication,
        BundleTarget::LinuxAppDir,
        BundleTarget::WindowsPortable,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let output =
            BundleBuilder::build(&manifest(directory.path()), target, directory.path()).unwrap();
        assert!(output.executable.is_file());
        let metadata = fs::read_to_string(output.protocol_manifest).unwrap();
        assert!(metadata.contains("demo"));
        match target {
            BundleTarget::MacOsApplication => {
                assert!(metadata.contains("CFBundleURLSchemes"));
                assert!(metadata.contains("<string>demo</string>"));
            }
            BundleTarget::LinuxAppDir => {
                assert!(metadata.contains("MimeType=x-scheme-handler/demo;"));
                assert!(output.root.join("AppRun").is_file());
            }
            BundleTarget::WindowsPortable => {
                assert!(metadata.contains("HKCU:\\Software\\Classes\\demo"));
                assert!(metadata.contains("$PSScriptRoot"));
            }
        }
    }
}

#[test]
fn windows_bundle_places_the_appcontainer_runner_beside_the_application() {
    let directory = tempfile::tempdir().unwrap();
    let runner = directory.path().join("runner.exe");
    fs::write(&runner, b"runner").unwrap();
    let manifest = manifest(directory.path()).with_windows_appcontainer_runner(&runner);

    let output =
        BundleBuilder::build(&manifest, BundleTarget::WindowsPortable, directory.path()).unwrap();

    assert_eq!(output.helpers.len(), 1);
    assert_eq!(
        output.helpers[0].file_name().unwrap(),
        "zui-appcontainer-runner.exe"
    );
    assert_eq!(fs::read(&output.helpers[0]).unwrap(), b"runner");
}

#[test]
fn bundle_generation_never_overwrites_an_existing_output() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = manifest(directory.path());
    BundleBuilder::build(&manifest, BundleTarget::MacOsApplication, directory.path()).unwrap();
    assert!(
        BundleBuilder::build(&manifest, BundleTarget::MacOsApplication, directory.path()).is_err()
    );
}

#[test]
fn bundle_generation_rejects_overlapping_resource_destinations() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let manifest = manifest(directory.path())
        .with_resource(BundleResource {
            source: first,
            destination: ResourcePath::new("same").unwrap(),
        })
        .with_resource(BundleResource {
            source: second,
            destination: ResourcePath::new("same").unwrap(),
        });
    assert!(
        BundleBuilder::build(&manifest, BundleTarget::WindowsPortable, directory.path()).is_err()
    );
    assert!(!directory.path().join("Demo-windows").exists());
}

#[test]
fn json_manifest_validates_protocols_and_resource_destinations() {
    let manifest = BundleManifest::from_json(
        br#"{
            "name":"Demo",
            "identifier":"com.example.demo",
            "version":"1.0.0",
            "executable":"demo",
            "resources":[{"source":"assets","destination":"../escape"}],
            "protocols":["demo"]
        }"#,
    );
    assert!(manifest.is_err());
}

#[test]
fn manifest_inputs_resolve_relative_to_the_manifest_directory() {
    let manifest = BundleManifest::from_json(
        br#"{
            "name":"Demo",
            "identifier":"com.example.demo",
            "version":"1.0.0",
            "executable":"bin/demo",
            "icon":"icons/demo.png",
            "resources":[{"source":"assets","destination":"assets"}]
        }"#,
    )
    .unwrap()
    .resolve_paths_from("/package");
    assert_eq!(
        manifest.executable,
        std::path::Path::new("/package/bin/demo")
    );
    assert_eq!(
        manifest.icon.as_deref(),
        Some(std::path::Path::new("/package/icons/demo.png"))
    );
    assert_eq!(
        manifest.resources[0].source,
        std::path::Path::new("/package/assets")
    );
}

#[test]
fn installer_plans_use_direct_platform_tools_and_emit_wix_protocol_registration() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = manifest(directory.path());
    let mac_bundle =
        BundleBuilder::build(&manifest, BundleTarget::MacOsApplication, directory.path()).unwrap();
    let mac_plan = InstallerBuilder::prepare(
        &manifest,
        &mac_bundle,
        InstallerTarget::MacOsPackage,
        directory.path(),
    )
    .unwrap();
    assert_eq!(
        mac_plan.command.program,
        std::path::Path::new("/usr/bin/pkgbuild")
    );
    assert!(mac_plan.command.arguments.contains(&"--component".into()));

    let windows_bundle =
        BundleBuilder::build(&manifest, BundleTarget::WindowsPortable, directory.path()).unwrap();
    let windows_plan = InstallerBuilder::prepare(
        &manifest,
        &windows_bundle,
        InstallerTarget::WindowsMsi,
        directory.path(),
    )
    .unwrap();
    assert_eq!(windows_plan.command.program, std::path::Path::new("wix"));
    let definition = fs::read_to_string(windows_plan.definition.unwrap()).unwrap();
    assert!(definition.contains("http://wixtoolset.org/schemas/v4/wxs"));
    assert!(definition.contains("Software\\Classes\\demo"));
    assert!(definition.contains("[INSTALLFOLDER]Demo.exe"));
    assert!(definition.contains("<ComponentRef"));
}

#[test]
fn native_metadata_uses_numeric_release_versions_for_semver_prereleases() {
    let directory = tempfile::tempdir().unwrap();
    let mut manifest = manifest(directory.path());
    manifest.version = AppVersion::parse("1.2.3-beta.4+build.9").unwrap();
    let mac_bundle =
        BundleBuilder::build(&manifest, BundleTarget::MacOsApplication, directory.path()).unwrap();
    let plist = fs::read_to_string(mac_bundle.protocol_manifest).unwrap();
    assert!(plist.contains("<string>1.2.3</string>"));
    assert!(!plist.contains("beta"));

    let windows_bundle =
        BundleBuilder::build(&manifest, BundleTarget::WindowsPortable, directory.path()).unwrap();
    let plan = InstallerBuilder::prepare(
        &manifest,
        &windows_bundle,
        InstallerTarget::WindowsMsi,
        directory.path(),
    )
    .unwrap();
    let definition = fs::read_to_string(plan.definition.unwrap()).unwrap();
    assert!(definition.contains("Version=\"1.2.3\""));
    assert!(!definition.contains("Version=\"1.2.3-beta"));
}

#[test]
fn injected_installer_tool_must_create_a_new_declared_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = manifest(directory.path());
    let bundle =
        BundleBuilder::build(&manifest, BundleTarget::LinuxAppDir, directory.path()).unwrap();
    let plan = InstallerBuilder::prepare(
        &manifest,
        &bundle,
        InstallerTarget::LinuxAppImage,
        directory.path(),
    )
    .unwrap();
    let tool = ArtifactTool {
        artifact: plan.artifact.clone(),
        commands: Mutex::new(Vec::new()),
    };
    let output = InstallerBuilder::execute(plan, &tool).unwrap();
    assert!(output.artifact.is_file());
    assert_eq!(tool.commands.lock().unwrap().len(), 1);
    assert!(
        InstallerBuilder::prepare(
            &manifest,
            &bundle,
            InstallerTarget::LinuxAppImage,
            directory.path()
        )
        .is_err()
    );
}

#[test]
fn signing_plans_use_platform_verification_and_notarization_tools() {
    let mac_app = ArtifactSigner::macos_application(
        "/release/Demo.app",
        &MacOsApplicationSigning::new("Developer ID Application: Example").unwrap(),
    );
    assert_eq!(
        mac_app.commands[0].program,
        std::path::Path::new("/usr/bin/codesign")
    );
    assert!(mac_app.commands[0].arguments.contains(&"runtime".into()));
    assert!(mac_app.commands[1].arguments.contains(&"--strict".into()));

    let mac_package = ArtifactSigner::macos_package(
        "/release/Demo.pkg",
        &MacOsPackageSigning::new("Developer ID Installer: Example", "ci-notary").unwrap(),
    )
    .unwrap();
    assert_eq!(
        mac_package.artifact,
        std::path::Path::new("/release/Demo-signed.pkg")
    );
    assert!(mac_package.commands.iter().any(|command| {
        command.program == std::path::Path::new("/usr/bin/xcrun")
            && command.arguments.contains(&"notarytool".into())
    }));
    assert!(
        mac_package
            .commands
            .iter()
            .any(|command| { command.program == std::path::Path::new("/usr/sbin/spctl") })
    );

    let windows = ArtifactSigner::windows(
        "C:\\release\\Demo.msi",
        &WindowsSigning::new(
            "00112233445566778899AABBCCDDEEFF00112233",
            "https://timestamp.example.com",
        )
        .unwrap(),
    );
    assert!(windows.commands[0].arguments.contains(&"/fd".into()));
    assert!(windows.commands[0].arguments.contains(&"/td".into()));
    assert!(windows.commands[1].arguments.contains(&"verify".into()));

    let linux = ArtifactSigner::linux_appimage(
        "/release/Demo.AppImage",
        &LinuxSigning::new("release@example.com").unwrap(),
    )
    .unwrap();
    assert_eq!(
        linux.auxiliary_artifacts,
        [std::path::PathBuf::from("/release/Demo.AppImage.asc")]
    );
    assert!(linux.commands[1].arguments.contains(&"--verify".into()));
}

#[test]
fn signing_configuration_rejects_ambiguous_or_weak_windows_identity() {
    assert!(WindowsSigning::new("not a thumbprint", "https://timestamp.example.com").is_err());
    assert!(WindowsSigning::new("0011", "https://timestamp.example.com").is_err());
    assert!(
        WindowsSigning::new(
            "00112233445566778899AABBCCDDEEFF00112233",
            "http://timestamp.example.com"
        )
        .is_err()
    );
    assert!(WindowsSigning::new("00112233445566778899AABBCCDDEEFF00112233", "https://").is_err());
    assert!(MacOsApplicationSigning::new(" ").is_err());
    assert!(LinuxSigning::new("").is_err());
}

#[test]
fn signing_execution_runs_the_complete_plan_and_requires_a_new_output() {
    let directory = tempfile::tempdir().unwrap();
    let package = directory.path().join("Demo.pkg");
    fs::write(&package, b"unsigned package").unwrap();
    let config = MacOsPackageSigning::new("Developer ID Installer: Example", "ci-notary").unwrap();
    let plan = ArtifactSigner::macos_package(&package, &config).unwrap();
    let tool = SigningArtifactTool {
        artifact: plan.artifact.clone(),
        commands: Mutex::new(Vec::new()),
    };

    let output = ArtifactSigner::execute(plan, &tool).unwrap();

    assert_eq!(output.artifact, tool.artifact);
    assert_eq!(tool.commands.lock().unwrap().len(), 5);
    let second_plan = ArtifactSigner::macos_package(&package, &config).unwrap();
    assert!(ArtifactSigner::execute(second_plan, &tool).is_err());
    assert_eq!(tool.commands.lock().unwrap().len(), 5);
}

struct ArtifactTool {
    artifact: std::path::PathBuf,
    commands: Mutex<Vec<InstallerCommand>>,
}

impl InstallerTool for ArtifactTool {
    fn run(&self, command: &InstallerCommand) -> Result<(), InstallerToolError> {
        self.commands.lock().unwrap().push(command.clone());
        fs::write(&self.artifact, b"installer")
            .map_err(|error| InstallerToolError::message(error.to_string()))
    }
}

struct SigningArtifactTool {
    artifact: std::path::PathBuf,
    commands: Mutex<Vec<SigningCommand>>,
}

impl SigningTool for SigningArtifactTool {
    fn run(&self, command: &SigningCommand) -> Result<(), SigningToolError> {
        self.commands.lock().unwrap().push(command.clone());
        fs::write(&self.artifact, b"signed artifact")
            .map_err(|error| SigningToolError::message(error.to_string()))
    }
}
