use super::*;
use crate::Dirs;
use crate::HostEnvironment;

#[test]
fn render_is_deterministic_and_escapes_host_values_and_paths() {
    let dir = absolute_path("dir&main");
    let other_dir = absolute_path("other>root");
    let snapshot = AgentEnvironmentSnapshot::new(
        HostEnvironment::new(
            dir,
            "darwin".into(),
            "Darwin <version>".into(),
            "/bin/zsh".into(),
        )
        .unwrap(),
        RepositoryEnvironment::git(
            Some("feature/<agent>".into()),
            Some("main".into()),
            " M src/lib.rs".into(),
            "abc123 'message'".into(),
        )
        .unwrap(),
        Dirs::new([absolute_path("dir&main"), other_dir]).unwrap(),
    );

    let rendered = snapshot.render();

    assert!(rendered.contains("dir&amp;main</cwd>"));
    assert!(rendered.contains("<os_version>Darwin &lt;version&gt;</os_version>"));
    assert!(rendered.contains("<git_branch>feature/&lt;agent&gt;</git_branch>"));
    assert!(
        rendered.contains("<git_recent_commits>abc123 &apos;message&apos;</git_recent_commits>")
    );
    assert!(rendered.contains("other&gt;root</dir>"));
    assert_eq!(rendered, snapshot.render());
}

#[test]
fn missing_repository_is_rendered_explicitly() {
    let dir = absolute_path("dir");
    let snapshot = AgentEnvironmentSnapshot::new(
        HostEnvironment::new(
            dir.clone(),
            "linux".into(),
            "Linux".into(),
            "/bin/bash".into(),
        )
        .unwrap(),
        RepositoryEnvironment::NotDetected,
        Dirs::new([dir]).unwrap(),
    );

    let rendered = snapshot.render();

    assert!(rendered.contains("<is_git_repo>false</is_git_repo>"));
    assert!(rendered.contains("<git_branch>(none)</git_branch>"));
}

fn absolute_path(name: &str) -> std::path::PathBuf {
    std::env::current_dir().unwrap().join(name)
}
