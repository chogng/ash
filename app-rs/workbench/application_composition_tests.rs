use std::fs;
use std::path::{Path, PathBuf};

#[test]
fn application_composition_uses_scene_draw_component() {
    let source_root = app_root().join("workbench");
    let mut violations = Vec::new();
    visit_rust_sources(&source_root, &mut |path, source| {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("_tests.rs"))
        {
            return;
        }
        for forbidden in [".paint(scene)", ".paint(&mut scene)"] {
            if source.contains(forbidden) {
                violations.push(format!("{} contains `{forbidden}`", path.display()));
            }
        }
    });

    assert!(
        violations.is_empty(),
        "Desktop application composition must use UiScene::draw_component so inspection ancestry is preserved:\n{}",
        violations.join("\n")
    );
}

#[test]
fn zui_backend_neutral_modules_remain_platform_independent() {
    let workspace = app_root();
    let zui_root = workspace.join("zui").join("src");
    let mut violations = Vec::new();
    for module in [
        "ui/foundation",
        "ui/layout",
        "ui/text",
        "ui/presentation",
        "runtime",
    ] {
        visit_rust_sources(&zui_root.join(module), &mut |path, source| {
            if is_test_source(path) {
                return;
            }
            for forbidden in [
                "wgpu::",
                "winit::",
                "glyphon::",
                "ash_ui_components::",
                "ash_workbench::",
            ] {
                if source.contains(forbidden) {
                    violations.push(format!("{} contains `{forbidden}`", path.display()));
                }
            }
        });
    }
    assert!(
        violations.is_empty(),
        "zui backend-neutral modules must remain independent from platform and graphics APIs:\n{}",
        violations.join("\n")
    );
}

#[test]
fn public_zui_facade_owns_desktop_framework_composition() {
    let workspace = app_root();
    let manifest = fs::read_to_string(workspace.join("zui").join("Cargo.toml"))
        .expect("zui manifest should be readable");
    for required in ["glyphon =", "wgpu =", "winit ="] {
        assert!(
            manifest
                .lines()
                .any(|line| line.trim_start().starts_with(required)),
            "zui must directly own its {required} implementation dependency"
        );
    }
    for forbidden in [
        "ash-ui-components =",
        "ash-workbench =",
        "ash-terminal =",
        "ash-app-server",
    ] {
        assert!(
            !manifest
                .lines()
                .any(|line| line.trim_start().starts_with(forbidden)),
            "zui must not depend on application capability {forbidden}"
        );
    }
}

#[test]
fn ui_crates_have_one_way_dependencies_while_backends_stay_internal_modules() {
    let workspace = app_root();
    assert!(
        !workspace.join("ui").exists(),
        "the mixed app-rs/ui crate must not return; use ui-components and workbench"
    );
    let components_root = workspace.join("ui-components");
    let components_manifest = fs::read_to_string(components_root.join("Cargo.toml"))
        .expect("UI components manifest should be readable");
    assert!(
        components_manifest
            .lines()
            .any(|line| line.trim_start().starts_with("zui =")),
        "components must consume the public zui facade"
    );
    for forbidden in ["ash-workbench ="] {
        assert!(
            !components_manifest
                .lines()
                .any(|line| line.trim_start().starts_with(forbidden)),
            "generic components must not depend on {forbidden}"
        );
    }
    let workbench_manifest = fs::read_to_string(workspace.join("workbench").join("Cargo.toml"))
        .expect("Workbench manifest should be readable");
    for required in ["ash-ui-components =", "zui ="] {
        assert!(
            workbench_manifest
                .lines()
                .any(|line| line.trim_start().starts_with(required)),
            "Workbench must directly depend on {required}"
        );
    }
    for retired_crate in ["icon", "renderer", "wgpu", "winit", "zui-core"] {
        assert!(
            !workspace.join(retired_crate).exists(),
            "{retired_crate} must remain an internal zui module rather than a sibling crate"
        );
    }
    for module in [
        "app", "input", "render", "runtime", "services", "ui", "window",
    ] {
        assert!(
            workspace.join("zui").join("src").join(module).is_dir(),
            "zui must physically own its {module} module"
        );
    }
    for module in [
        "accessibility.rs",
        "app.rs",
        "input.rs",
        "render.rs",
        "runtime.rs",
        "services.rs",
        "testing.rs",
        "ui.rs",
        "window.rs",
    ] {
        assert!(
            workspace.join("zui").join("src").join(module).is_file(),
            "zui must expose the physical capability root {module}"
        );
    }

    let components_root = fs::read_to_string(components_root.join("src").join("lib.rs"))
        .expect("UI components root should be readable");
    assert!(
        !components_root.contains("pub use zui::ui"),
        "UI components must not re-export the zui framework contract"
    );
    assert!(
        !components_root.contains("pub use zui::*;"),
        "UI components must not flatten application, renderer, service, or window capabilities"
    );
}

#[test]
fn component_crate_remains_graphics_backend_neutral() {
    let workspace = app_root();
    let ui_root = workspace.join("ui-components");
    let manifest = fs::read_to_string(ui_root.join("Cargo.toml"))
        .expect("UI components manifest should be readable");
    for forbidden in ["wgpu", "glyphon"] {
        assert!(
            !manifest
                .lines()
                .any(|line| line.trim_start().starts_with(forbidden)),
            "ash-ui-components must not depend on {forbidden}; graphics backends consume zui scenes"
        );
    }

    let mut violations = Vec::new();
    visit_rust_sources(&ui_root.join("src"), &mut |path, source| {
        for forbidden in ["wgpu::", "glyphon::"] {
            if source.contains(forbidden) {
                violations.push(format!("{} contains `{forbidden}`", path.display()));
            }
        }
    });
    assert!(
        violations.is_empty(),
        "ash-ui-components must remain graphics-backend neutral:\n{}",
        violations.join("\n")
    );
}

#[test]
fn application_uses_only_zui_for_desktop_framework_hosting() {
    let workspace = app_root();
    let workbench_manifest = fs::read_to_string(workspace.join("workbench/Cargo.toml"))
        .expect("Workbench manifest should be readable");
    assert!(
        workbench_manifest
            .lines()
            .any(|line| line.trim_start().starts_with("zui =")),
        "app must consume the complete zui framework"
    );
    for forbidden in [
        "zui-app =",
        "zui-core =",
        "ash-icon =",
        "ash-renderer =",
        "ash-wgpu =",
        "ash-winit =",
    ] {
        assert!(
            !workbench_manifest
                .lines()
                .any(|line| line.trim_start().starts_with(forbidden)),
            "app must obtain {forbidden} through zui rather than depending on an implementation layer"
        );
    }
    assert!(
        !workspace.join("app").exists(),
        "the retired app ownership layer must not return"
    );
}

#[test]
fn workbench_app_server_adapter_owns_the_ash_rs_client_boundary() {
    let workspace = app_root();
    let source_root = workspace.join("workbench");
    let app_server_file = source_root.join("app_server.rs");
    let app_server_root = source_root.join("app_server");
    let mut violations = Vec::new();
    visit_rust_sources(&source_root, &mut |path, source| {
        if path == app_server_file || path.starts_with(&app_server_root) || is_test_source(path) {
            return;
        }
        if source.contains("ash_app_server_client") {
            violations.push(
                path.strip_prefix(workspace)
                    .unwrap_or(path)
                    .display()
                    .to_string(),
            );
        }
    });
    assert!(
        violations.is_empty(),
        "Workbench modules must access ash-rs App Server client through crate::app_server:\n{}",
        violations.join("\n")
    );

    let workbench_manifest = fs::read_to_string(workspace.join("workbench/Cargo.toml"))
        .expect("Workbench manifest should be readable");
    assert!(
        workbench_manifest
            .lines()
            .any(|line| line.trim_start().starts_with("ash-app-server-client =")),
        "Workbench must own the shared ash-rs App Server client dependency"
    );

    for relative_manifest in [
        "ui-components/Cargo.toml",
        "zui/Cargo.toml",
        "editor/Cargo.toml",
        "settings/Cargo.toml",
    ] {
        let manifest = fs::read_to_string(workspace.join(relative_manifest))
            .unwrap_or_else(|error| panic!("could not read {relative_manifest}: {error}"));
        assert!(
            !manifest
                .lines()
                .any(|line| line.trim_start().starts_with("ash-app-server-client =")),
            "UI crate {relative_manifest} must not depend on the App Server client"
        );
    }
}

#[test]
fn desktop_app_state_is_private_to_the_workbench_composition_boundary() {
    let source_root = app_root().join("workbench");
    let state_source = fs::read_to_string(source_root.join("application/state.rs"))
        .expect("WorkbenchApplication state source should be readable");
    assert!(
        state_source.contains("pub(crate) struct WorkbenchApplication"),
        "WorkbenchApplication should remain available to the app without exposing its fields"
    );
    assert!(
        !state_source.contains("    pub(crate) "),
        "WorkbenchApplication fields must not be crate-wide; expose them only to app composition descendants"
    );
    assert!(
        state_source.contains("    pub(super) window:")
            && state_source.contains("    pub(super) app_server_host:"),
        "WorkbenchApplication state fields must use the app-composition visibility boundary"
    );

    let application_source = fs::read_to_string(source_root.join("application.rs"))
        .expect("WorkbenchApplication composition source should be readable");
    assert!(
        application_source.contains("mod state;")
            && application_source.contains("pub(crate) use state::WorkbenchApplication;"),
        "Workbench must own and re-export the application state type"
    );
    assert!(
        !application_source.contains("state: state::WorkbenchApplicationState"),
        "WorkbenchApplication must not add a second wrapper state layer"
    );

    for relative_path in [
        "application/frame.rs",
        "application/interaction.rs",
        "application/runtime.rs",
        "application/workbench.rs",
        "application/workbench_resize.rs",
        "application/workbench_tabs_resize.rs",
    ] {
        let source = fs::read_to_string(source_root.join(relative_path))
            .unwrap_or_else(|error| panic!("could not read {relative_path}: {error}"));
        assert!(
            !source.contains("pub(crate) fn"),
            "{relative_path} must not expose WorkbenchApplication composition methods at crate scope"
        );
    }
}

#[test]
fn gpu_backend_does_not_own_interaction_or_accessibility_frames() {
    let workspace = app_root();
    let backend_root = workspace.join("zui/src/render/wgpu");

    let mut violations = Vec::new();
    visit_rust_sources(&backend_root, &mut |path, source| {
        for forbidden in ["InteractionFrame", "AccessibilityNode"] {
            if source.contains(forbidden) {
                violations.push(format!("{} contains `{forbidden}`", path.display()));
            }
        }
    });
    assert!(
        violations.is_empty(),
        "GPU backend must not route input or accessibility semantics:\n{}",
        violations.join("\n")
    );
}

#[test]
fn every_component_declares_a_zui_element() {
    let dir_root = app_root();
    let mut violations = Vec::new();
    let mut implementation_count = 0;
    for crate_root in workspace_crate_roots(dir_root) {
        let source_root = crate_source_root(&crate_root);
        visit_rust_sources(&source_root, &mut |path, source| {
            let implementations = source
                .match_indices(" Component for ")
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            for (implementation_index, start) in implementations.iter().copied().enumerate() {
                implementation_count += 1;
                let end = implementations
                    .get(implementation_index + 1)
                    .copied()
                    .unwrap_or(source.len());
                let implementation = &source[start..end];
                if implementation.contains("fn element(&self)") {
                    continue;
                }
                let relative = path.strip_prefix(dir_root).unwrap_or(path);
                violations.push(relative.display().to_string());
            }
        });
    }

    assert!(
        implementation_count >= 20,
        "component audit found too few implementations"
    );
    assert!(
        violations.is_empty(),
        "Every Component must declare a zui Element so layout and inspection cannot diverge:\n{}",
        violations.join("\n")
    );
}

#[test]
fn production_components_do_not_reintroduce_manual_component_inspection() {
    let dir_root = app_root();
    let mut violations = Vec::new();
    for crate_root in workspace_crate_roots(dir_root) {
        visit_rust_sources(&crate_source_root(&crate_root), &mut |path, source| {
            if is_test_source(path) {
                return;
            }
            if source.contains("ComponentInspection") {
                violations.push(
                    path.strip_prefix(dir_root)
                        .unwrap_or(path)
                        .display()
                        .to_string(),
                );
            }
        });
    }
    assert!(
        violations.is_empty(),
        "ComponentInspection is obsolete; declare Element style and let zui generate inspection:\n{}",
        violations.join("\n")
    );
}

#[test]
fn production_composition_does_not_register_inspection_nodes_directly() {
    let dir_root = app_root();
    let registration_owner = dir_root.join("zui/src/ui/presentation/scene.rs");
    let mut violations = Vec::new();
    for crate_root in workspace_crate_roots(dir_root) {
        visit_rust_sources(&crate_source_root(&crate_root), &mut |path, source| {
            if is_test_source(path)
                || path == registration_owner
                || !source.contains("with_inspection_node(")
            {
                return;
            }
            violations.push(
                path.strip_prefix(dir_root)
                    .unwrap_or(path)
                    .display()
                    .to_string(),
            );
        });
    }
    assert!(
        violations.is_empty(),
        "Application composition must declare Element style and let zui register inspection nodes:\n{}",
        violations.join("\n")
    );
}

#[test]
fn zui_consumers_use_capability_oriented_namespaces() {
    let dir_root = app_root();
    let zui_root = dir_root.join("zui");
    let mut violations = Vec::new();
    for crate_root in workspace_crate_roots(dir_root) {
        if crate_root == zui_root {
            continue;
        }
        visit_rust_sources(&crate_source_root(&crate_root), &mut |path, source| {
            if is_test_source(path) {
                return;
            }
            for (offset, _) in source.match_indices("zui::") {
                let capability = &source[offset + "zui::".len()..];
                if capability.chars().next().is_some_and(char::is_uppercase) {
                    violations.push(
                        path.strip_prefix(dir_root)
                            .unwrap_or(path)
                            .display()
                            .to_string(),
                    );
                    break;
                }
            }
        });
    }
    assert!(
        violations.is_empty(),
        "ZUI consumers must import app, input, render, services, ui, or window capabilities instead of flat root aliases:\n{}",
        violations.join("\n")
    );
}

fn is_test_source(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with("_tests.rs"))
}

fn visit_rust_sources(root: &Path, visitor: &mut impl FnMut(&Path, &str)) {
    let mut entries = fs::read_dir(root)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", root.display()))
        .map(|entry| entry.expect("source directory entry").path())
        .collect::<Vec<PathBuf>>();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            visit_rust_sources(&path, visitor);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
            visitor(&path, &source);
        }
    }
}

fn workspace_crate_roots(dir_root: &Path) -> Vec<PathBuf> {
    let mut roots = fs::read_dir(dir_root)
        .expect("Rust workspace directory")
        .map(|entry| entry.expect("Rust workspace entry").path())
        .filter(|path| path.join("Cargo.toml").is_file())
        .collect::<Vec<_>>();
    roots.sort();
    roots
}

fn crate_source_root(crate_root: &Path) -> PathBuf {
    let conventional = crate_root.join("src");
    if conventional.is_dir() {
        conventional
    } else {
        crate_root.to_path_buf()
    }
}

fn app_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Workbench must remain inside app")
}
