use super::*;

#[test]
fn directories_are_sorted_and_deduplicated() {
    let beta = absolute_path("beta");
    let alpha = absolute_path("alpha");
    let ash = absolute_path("ash");
    let dirs = Dirs::new([ash.clone(), beta.clone(), alpha.clone(), ash.clone()]).unwrap();
    let mut expected = vec![alpha, beta, ash];
    expected.sort();

    assert_eq!(
        dirs.as_slice()
            .iter()
            .map(AbsolutePathBuf::as_path)
            .collect::<Vec<_>>(),
        expected
            .iter()
            .map(std::path::PathBuf::as_path)
            .collect::<Vec<_>>()
    );
}

#[test]
fn relative_directories_are_rejected_at_the_value_boundary() {
    assert!(matches!(
        Dirs::new(["relative".into()]),
        Err(AgentEnvironmentError::PathMustBeAbsolute {
            field: "accessible directory",
            ..
        })
    ));
}

fn absolute_path(name: &str) -> std::path::PathBuf {
    std::env::current_dir().unwrap().join(name)
}
