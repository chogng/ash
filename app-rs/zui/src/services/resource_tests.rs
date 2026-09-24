use std::path::Path;

use super::ResourcePath;
use super::ResourceService;
use super::SystemResourceLocator;
use super::resource_root_for_executable;

#[test]
fn resource_paths_reject_absolute_and_traversing_inputs() {
    assert!(ResourcePath::new("").is_err());
    assert!(ResourcePath::new("../secret").is_err());
    assert!(ResourcePath::new("./icons/app.png").is_err());
    assert!(ResourcePath::new("/icons/app.png").is_err());
    assert_eq!(
        ResourcePath::new("icons/app.png").unwrap().as_path(),
        Path::new("icons/app.png")
    );
}

#[test]
fn explicit_resource_roots_resolve_validated_paths() {
    let resources = SystemResourceLocator::from_root("/opt/demo/resources");
    assert_eq!(
        resources
            .resolve(&ResourcePath::new("icons/app.png").unwrap())
            .unwrap(),
        Path::new("/opt/demo/resources/icons/app.png")
    );
}

#[test]
fn executable_layout_uses_a_sibling_resources_directory() {
    assert_eq!(
        resource_root_for_executable(Path::new("/opt/demo/bin/demo")),
        Path::new("/opt/demo/bin/resources")
    );
}
