use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const MAX_PRODUCTION_MODULE_LINES: usize = 500;
const CAPABILITY_DIRECTORIES: &[&str] = &[
    "accessibility",
    "app",
    "devtools",
    "distribution",
    "input",
    "render",
    "runtime",
    "services",
    "testing",
    "ui",
    "window",
];
const CAPABILITY_ROOTS: &[&str] = &[
    "accessibility",
    "app",
    "devtools",
    "distribution",
    "input",
    "render",
    "runtime",
    "services",
    "testing",
    "ui",
    "window",
];
const ROOT_SOURCE_FILES: &[&str] = &[
    "accessibility.rs",
    "app.rs",
    "architecture_tests.rs",
    "devtools.rs",
    "distribution.rs",
    "input.rs",
    "internal.rs",
    "lib.rs",
    "prelude.rs",
    "render.rs",
    "runtime.rs",
    "services.rs",
    "task.rs",
    "testing.rs",
    "ui.rs",
    "window.rs",
];

struct LayerRule {
    path: &'static str,
    allowed_crate_paths: &'static [&'static str],
    excluded_files: &'static [&'static str],
}

const LAYER_RULES: &[LayerRule] = &[
    LayerRule {
        path: "ui/foundation",
        allowed_crate_paths: &[],
        excluded_files: &[],
    },
    LayerRule {
        path: "ui/layout",
        allowed_crate_paths: &["crate::ui::foundation::"],
        excluded_files: &[],
    },
    LayerRule {
        path: "ui/text",
        allowed_crate_paths: &["crate::ui::foundation::", "crate::ui::text::"],
        excluded_files: &[],
    },
    LayerRule {
        path: "ui/presentation",
        allowed_crate_paths: &["crate::ui::foundation::", "crate::ui::text::"],
        excluded_files: &[],
    },
    LayerRule {
        path: "runtime",
        allowed_crate_paths: &["crate::ui::foundation::"],
        excluded_files: &["task.rs", "timer.rs"],
    },
];

#[test]
fn framework_sources_are_physically_partitioned_by_capability() {
    let source_root = source_root();
    let mut unexpected = Vec::new();
    for entry in fs::read_dir(&source_root).expect("zui source root should be readable") {
        let path = entry.expect("zui source entry should be readable").path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if !CAPABILITY_DIRECTORIES.contains(&name) {
                unexpected.push(path.display().to_string());
            }
        } else if !ROOT_SOURCE_FILES.contains(&name) && !name.ends_with("_tests.rs") {
            unexpected.push(path.display().to_string());
        }
    }
    for path in all_files(&source_root) {
        if path.file_name().and_then(|name| name.to_str()) == Some("mod.rs") {
            unexpected.push(path.display().to_string());
        }
    }
    assert!(
        unexpected.is_empty(),
        "zui source must use capability roots and file-based module roots; unexpected paths:\n{}",
        unexpected.join("\n")
    );
}

#[test]
fn every_public_capability_has_a_matching_source_root() {
    let source_root = source_root();
    let facade =
        fs::read_to_string(source_root.join("lib.rs")).expect("zui facade should be readable");
    let mut missing = Vec::new();
    for capability in CAPABILITY_ROOTS {
        let path = source_root.join(format!("{capability}.rs"));
        if !path.is_file() {
            missing.push(format!("missing {}", path.display()));
        }
        let directory = source_root.join(capability);
        if !directory.is_dir() {
            missing.push(format!("missing {}", directory.display()));
        }
        if !facade.contains(&format!("pub mod {capability};")) {
            missing.push(format!("lib.rs does not declare `pub mod {capability};`"));
        }
    }
    assert!(
        missing.is_empty(),
        "public ZUI capabilities must be backed by same-named physical module roots:\n{}",
        missing.join("\n")
    );
}

#[test]
fn backend_neutral_layers_only_depend_in_the_declared_direction() {
    let source_root = source_root();
    let mut violations = Vec::new();
    for rule in LAYER_RULES {
        for path in production_rust_files(&source_root.join(rule.path)) {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if rule.excluded_files.contains(&name) {
                continue;
            }
            let source = fs::read_to_string(&path).expect("zui source should be readable");
            for (index, line) in source.lines().enumerate() {
                let Some(offset) = line.find("crate::") else {
                    continue;
                };
                // Exported macros must use `$crate` so they still resolve after downstream
                // renaming. That hygiene path is not a source-layer dependency.
                if offset > 0 && line.as_bytes()[offset - 1] == b'$' {
                    continue;
                }
                let crate_path = &line[offset..];
                if line.trim_start().starts_with("//")
                    || rule
                        .allowed_crate_paths
                        .iter()
                        .any(|allowed| crate_path.starts_with(allowed))
                {
                    continue;
                }
                violations.push(format!(
                    "{}:{} crosses the {} boundary with `{}`",
                    path.display(),
                    index + 1,
                    rule.path,
                    line.trim()
                ));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "backend-neutral dependencies must flow foundation → layout/text → presentation while core runtime remains presentation-independent:\n{}",
        violations.join("\n")
    );
}

#[test]
fn backend_neutral_sources_do_not_absorb_native_or_product_owners() {
    let source_root = source_root();
    let forbidden = [
        "accesskit::",
        "accesskit_platform::",
        "wgpu::",
        "winit::",
        "ash_icons::",
        "ash_ui_components::",
        "ash_workbench::",
        "app::",
    ];
    let mut violations = Vec::new();
    for root in ["ui", "runtime"] {
        for path in production_rust_files(&source_root.join(root)) {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if root == "runtime" && ["task.rs", "timer.rs"].contains(&name) {
                continue;
            }
            scan_file_forbidden(&path, &forbidden, &mut violations);
        }
    }
    assert!(
        violations.is_empty(),
        "backend-neutral ZUI capabilities must not import native adapters or product owners:\n{}",
        violations.join("\n")
    );
}

#[test]
fn native_dependencies_stay_with_their_capability_owners() {
    let source_root = source_root();
    let mut violations = Vec::new();
    for path in production_rust_files(&source_root) {
        let relative = path
            .strip_prefix(&source_root)
            .expect("zui source should remain below its root")
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read_to_string(&path).expect("zui source should be readable");
        let imports_wgpu = source
            .match_indices("wgpu::")
            .any(|(offset, _)| !source[..offset].ends_with("crate::render::"));
        if imports_wgpu && !relative.starts_with("render/wgpu/") {
            violations.push(format!(
                "{} imports wgpu outside render/wgpu",
                path.display()
            ));
        }
        if source.contains("winit::")
            && ![
                "app-rs/native_host.rs",
                "input/device.rs",
                "input/keyboard.rs",
                "internal.rs",
                "window/capability.rs",
                "window/chrome.rs",
                "window/display.rs",
                "window/event.rs",
                "window/icon.rs",
                "window/native.rs",
                "window/operations.rs",
                "window/parent.rs",
                "window/platform.rs",
                "window/policy.rs",
                "window/state.rs",
            ]
            .contains(&relative.as_str())
        {
            violations.push(format!(
                "{} imports winit outside app/input/window integration",
                path.display()
            ));
        }
        if source.contains("ashpd::") && !relative.starts_with("services/global_shortcut/") {
            violations.push(format!(
                "{} imports ashpd outside the global-shortcut owner",
                path.display()
            ));
        }
        if source.contains("gio::")
            && relative != "services/file_icon/platform/linux.rs"
            && relative != "services/protocol_client/platform.rs"
        {
            violations.push(format!(
                "{} imports GIO outside audited platform owners",
                path.display()
            ));
        }
        if source.contains("zbus::") && relative != "services/application_badge/platform.rs" {
            violations.push(format!(
                "{} imports zbus outside the application-badge owner",
                path.display()
            ));
        }
        if (source.contains("gtk::") || source.contains("tray_icon::"))
            && relative != "services/file_icon/platform/linux.rs"
            && relative != "services/tray.rs"
            && !relative.starts_with("services/tray/")
        {
            violations.push(format!(
                "{} imports GTK/tray-icon outside the tray owner",
                path.display()
            ));
        }
        if source.contains("muda::")
            && relative != "services/menu.rs"
            && !relative.starts_with("services/menu/")
        {
            violations.push(format!(
                "{} imports muda outside the menu owner",
                path.display()
            ));
        }
        if source.contains("x11rb::") && relative != "window/display/linux.rs" {
            violations.push(format!(
                "{} imports X11 outside the display owner",
                path.display()
            ));
        }
        if (source.contains("fs2::") || source.contains("uds_windows::"))
            && relative != "app/single_instance/transport.rs"
        {
            violations.push(format!(
                "{} imports process coordination outside the single-instance transport owner",
                path.display()
            ));
        }
        if (source.contains("objc2::")
            || source.contains("objc2_app_kit::")
            || source.contains("objc2_foundation::"))
            && relative != "app/macos.rs"
            && relative != "app/locale/platform.rs"
            && relative != "app/presentation/platform.rs"
            && relative != "services/application_badge/platform/macos.rs"
            && relative != "services/file_icon/platform/macos.rs"
            && relative != "services/login_item/platform/macos.rs"
            && relative != "services/protocol_client/platform/macos.rs"
            && relative != "services/recent_document/platform.rs"
            && relative != "window/display/macos.rs"
        {
            violations.push(format!(
                "{} imports AppKit/Objective-C outside audited macOS owners",
                path.display()
            ));
        }
        if source.contains("windows_sys::")
            && relative != "app/locale/platform.rs"
            && relative != "app/presentation/platform.rs"
            && relative != "app/presentation/platform/windows.rs"
            && relative != "services/login_item/platform/windows.rs"
            && relative != "services/file_icon/platform/windows.rs"
            && relative != "services/menu/windows.rs"
            && relative != "services/protocol_client/platform.rs"
            && relative != "services/recent_document/platform.rs"
            && relative != "window/display/windows.rs"
            && !relative.starts_with("services/process/sandbox/windows/")
        {
            violations.push(format!(
                "{} imports Win32 APIs outside audited platform owners",
                path.display()
            ));
        }
        if source.contains("windows::Win32::")
            && relative != "services/jump_list/platform/windows.rs"
        {
            violations.push(format!(
                "{} imports typed Win32 APIs outside the audited Jump List owner",
                path.display()
            ));
        }
        if ["ash_icons", "ash_ui_components", "ash_workbench", "app"]
            .iter()
            .any(|crate_name| imports_external_crate(&source, crate_name))
            && relative != "architecture_tests.rs"
        {
            violations.push(format!("{} imports a product owner", path.display()));
        }
    }
    assert!(
        violations.is_empty(),
        "native and product dependencies must remain with their declared capability owners:\n{}",
        violations.join("\n")
    );
}

#[test]
fn production_modules_stay_small() {
    let source_root = source_root();
    let mut oversized = Vec::new();
    for path in production_rust_files(&source_root) {
        let source = fs::read_to_string(&path).expect("zui source should be readable");
        let line_count = source.lines().count();
        if line_count > MAX_PRODUCTION_MODULE_LINES {
            oversized.push(format!("{} has {line_count} lines", path.display()));
        }
    }
    assert!(
        oversized.is_empty(),
        "zui production modules must stay under {MAX_PRODUCTION_MODULE_LINES} lines:\n{}",
        oversized.join("\n")
    );
}

#[test]
fn public_capability_roots_hide_native_backend_types() {
    let source_root = source_root();
    let forbidden = [
        "pub use accesskit::",
        "pub use wgpu::",
        "pub use winit::",
        "pub mod internal",
        "pub mod wgpu",
    ];
    let mut violations = Vec::new();
    for name in CAPABILITY_ROOTS
        .iter()
        .map(|name| format!("{name}.rs"))
        .chain(["lib.rs".to_owned()])
    {
        let path = source_root.join(name);
        let source = fs::read_to_string(&path).expect("public module root should be readable");
        for token in forbidden {
            if source.contains(token) {
                violations.push(format!("{} exposes `{token}`", path.display()));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "public capability roots must hide native backend types:\n{}",
        violations.join("\n")
    );
}

#[test]
fn legacy_facade_and_technical_layer_roots_do_not_return() {
    let source_root = source_root();
    let legacy_paths = [
        "api.rs",
        "application",
        "core.rs",
        "foundation",
        "layout",
        "packaging",
        "platform",
        "presentation",
        "renderer",
        "renderer_support.rs",
        "testkit",
        "text",
    ];
    let present = legacy_paths
        .iter()
        .map(|path| source_root.join(path))
        .filter(|path| path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    assert!(
        present.is_empty(),
        "legacy facade and technical-layer roots must not return:\n{}",
        present.join("\n")
    );
}

fn source_root() -> PathBuf {
    let cargo_source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    if cargo_source_root.is_dir() {
        return cargo_source_root;
    }

    let workspace = env::var("TEST_WORKSPACE").unwrap_or_else(|_| "_main".to_owned());
    for runfiles_variable in ["RUNFILES_DIR", "TEST_SRCDIR"] {
        let Ok(runfiles_root) = env::var(runfiles_variable) else {
            continue;
        };
        let source_root = Path::new(&runfiles_root)
            .join(&workspace)
            .join("app-rs/zui/src");
        if source_root.is_dir() {
            return source_root;
        }
    }

    cargo_source_root
}

fn scan_file_forbidden(path: &Path, forbidden: &[&str], violations: &mut Vec<String>) {
    let source = fs::read_to_string(path).expect("zui source should be readable");
    for token in forbidden {
        if source.contains(token) {
            violations.push(format!("{} contains `{token}`", path.display()));
        }
    }
}

fn imports_external_crate(source: &str, crate_name: &str) -> bool {
    let path = format!("{crate_name}::");
    source.match_indices(&path).any(|(offset, _)| {
        let prefix = &source[..offset];
        !prefix.ends_with("crate::")
            && !prefix.ends_with("self::")
            && !prefix.ends_with("super::")
            && !prefix
                .as_bytes()
                .last()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    })
}

fn production_rust_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    visit_files(root, &mut files);
    files.retain(|path| {
        path.extension().and_then(|extension| extension.to_str()) == Some("rs")
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("_tests.rs") || name == "architecture_tests.rs")
    });
    files.sort();
    files
}

fn all_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    visit_files(root, &mut files);
    files
}

fn visit_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).unwrap_or_else(|error| {
        panic!(
            "could not read zui source directory {}: {error}",
            root.display()
        )
    }) {
        let path = entry.expect("zui source entry should be readable").path();
        if path.is_dir() {
            visit_files(&path, files);
        } else {
            files.push(path);
        }
    }
}
