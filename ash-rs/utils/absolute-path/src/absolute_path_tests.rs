use super::*;
use pretty_assertions::assert_eq;
use std::path::PathBuf;

/// Spells a test path that is absolute on every host: `/tmp/one` becomes `C:\tmp\one` on Windows.
fn absolute_test_path(unix_path: &str) -> PathBuf {
    if cfg!(windows) {
        let mut path = PathBuf::from(r"C:\");
        path.extend(unix_path.split('/').filter(|segment| !segment.is_empty()));
        path
    } else {
        PathBuf::from(unix_path)
    }
}

fn absolute(unix_path: &str) -> AbsolutePathBuf {
    AbsolutePathBuf::from_absolute(absolute_test_path(unix_path)).expect("absolute test path")
}

#[test]
fn from_absolute_collapses_dot_segments() {
    let path = AbsolutePathBuf::from_absolute(absolute_test_path("/tmp/one/./nested/../two"))
        .expect("absolute path");

    assert_eq!(path.as_path(), absolute_test_path("/tmp/one/two"));
}

#[test]
fn from_absolute_rejects_a_relative_path() {
    let error =
        AbsolutePathBuf::from_absolute("nested/file.txt").expect_err("relative path is rejected");

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn from_absolute_accepts_a_missing_path() {
    let path = absolute("/tmp/definitely/missing/file.txt");

    assert_eq!(
        path.as_path(),
        absolute_test_path("/tmp/definitely/missing/file.txt")
    );
}

#[test]
fn resolve_against_base_ignores_the_base_for_an_absolute_path() {
    let path = AbsolutePathBuf::resolve_against_base(
        absolute_test_path("/tmp/elsewhere/file.txt"),
        &absolute("/tmp/base"),
    );

    assert_eq!(
        path.as_path(),
        absolute_test_path("/tmp/elsewhere/file.txt")
    );
}

#[test]
fn resolve_against_base_anchors_a_relative_path() {
    let path = AbsolutePathBuf::resolve_against_base("nested/file.txt", &absolute("/tmp/base"));

    assert_eq!(
        path.as_path(),
        absolute_test_path("/tmp/base/nested/file.txt")
    );
}

#[test]
fn resolve_against_base_collapses_dot_segments() {
    let path =
        AbsolutePathBuf::resolve_against_base("./nested/../file.txt", &absolute("/tmp/base"));

    assert_eq!(path.as_path(), absolute_test_path("/tmp/base/file.txt"));
}

#[test]
fn resolve_against_base_climbs_out_of_the_base() {
    let path = AbsolutePathBuf::resolve_against_base("../sibling", &absolute("/tmp/base/nested"));

    assert_eq!(path.as_path(), absolute_test_path("/tmp/base/sibling"));
}

#[test]
fn resolve_against_base_stops_climbing_at_the_root() {
    let path = AbsolutePathBuf::resolve_against_base("../../../tmp/one", &absolute("/"));

    assert_eq!(path.as_path(), absolute_test_path("/tmp/one"));
}

#[test]
fn resolve_against_base_returns_the_base_for_an_empty_path() {
    let path = AbsolutePathBuf::resolve_against_base("", &absolute("/tmp/base"));

    assert_eq!(path.as_path(), absolute_test_path("/tmp/base"));
}

#[test]
fn resolve_against_current_dir_anchors_a_relative_path() -> io::Result<()> {
    let current_dir = AbsolutePathBuf::current_dir()?;
    let path = AbsolutePathBuf::resolve_against_current_dir("file.txt")?;

    assert_eq!(path, current_dir.join("file.txt"));
    Ok(())
}

#[cfg(unix)]
const REMOVED_CURRENT_DIR_CHILD: &str = "ASH_ABSOLUTE_PATH_REMOVED_CURRENT_DIR_CHILD";

/// The child runs alone in its own process because it replaces and then deletes the working
/// directory, which is process-wide state the rest of the suite depends on.
#[cfg(unix)]
#[test]
fn resolve_against_current_dir_skips_a_removed_current_dir_for_absolute_paths() {
    let status = std::process::Command::new(std::env::current_exe().expect("current test binary"))
        .arg("removed_current_dir_child")
        .arg("--ignored")
        .env(REMOVED_CURRENT_DIR_CHILD, "1")
        .status()
        .expect("run child test");

    assert!(status.success());
}

#[cfg(unix)]
#[test]
#[ignore = "driven by resolve_against_current_dir_skips_a_removed_current_dir_for_absolute_paths"]
fn removed_current_dir_child() {
    if std::env::var_os(REMOVED_CURRENT_DIR_CHILD).is_none() {
        return;
    }

    let original_current_dir = std::env::current_dir().expect("original working directory");
    let directory = tempfile::tempdir().expect("temporary directory");
    std::env::set_current_dir(directory.path()).expect("enter temporary directory");
    std::fs::remove_dir(directory.path()).expect("remove working directory");
    std::env::current_dir().expect_err("working directory is unavailable");

    let resolved =
        AbsolutePathBuf::resolve_against_current_dir(absolute_test_path("/tmp/one/../two"));

    std::env::set_current_dir(original_current_dir).expect("restore working directory");
    assert_eq!(
        resolved
            .expect("absolute path needs no working directory")
            .as_path(),
        absolute_test_path("/tmp/two")
    );
}

#[test]
fn join_appends_a_relative_path() {
    assert_eq!(
        absolute("/tmp/base").join("nested/file.txt").as_path(),
        absolute_test_path("/tmp/base/nested/file.txt")
    );
}

#[test]
fn join_replaces_the_receiver_with_an_absolute_path() {
    assert_eq!(
        absolute("/tmp/base")
            .join(absolute_test_path("/tmp/elsewhere"))
            .as_path(),
        absolute_test_path("/tmp/elsewhere")
    );
}

#[test]
fn parent_returns_the_containing_directory() {
    assert_eq!(
        absolute("/tmp/one/two").parent().expect("parent directory"),
        absolute("/tmp/one")
    );
}

#[test]
fn parent_returns_none_at_the_root() {
    assert_eq!(absolute("/").parent(), None);
}

#[test]
fn ancestors_stay_absolute_up_to_the_root() {
    let ancestors = absolute("/tmp/one/two").ancestors().collect::<Vec<_>>();

    assert_eq!(
        ancestors,
        vec![
            absolute("/tmp/one/two"),
            absolute("/tmp/one"),
            absolute("/tmp"),
            absolute("/"),
        ]
    );
}

#[test]
fn canonicalize_resolves_dot_segments_on_the_filesystem() {
    let directory = tempfile::tempdir().expect("temporary directory");
    std::fs::create_dir(directory.path().join("one")).expect("one directory");
    std::fs::create_dir(directory.path().join("two")).expect("two directory");
    std::fs::write(directory.path().join("two").join("file.txt"), "").expect("file");
    let path = AbsolutePathBuf::from_absolute(directory.path().join("one/../two/./file.txt"))
        .expect("absolute path");

    assert_eq!(
        path.canonicalize().expect("canonical path").as_path(),
        dunce::canonicalize(directory.path().join("two").join("file.txt"))
            .expect("expected canonical path")
    );
}

#[test]
fn canonicalize_fails_for_a_missing_path() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = AbsolutePathBuf::from_absolute(directory.path().join("missing.txt"))
        .expect("absolute path");

    assert_eq!(
        path.canonicalize().expect_err("missing path").kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn deref_exposes_path_queries() {
    assert_eq!(
        absolute("/tmp/one/file.txt").file_name(),
        Some(std::ffi::OsStr::new("file.txt"))
    );
}

#[test]
fn json_round_trips_through_the_absolute_spelling() {
    let path = absolute("/tmp/one/two");
    let json = serde_json::to_string(&path).expect("serialize");

    assert_eq!(
        serde_json::from_str::<AbsolutePathBuf>(&json).expect("deserialize"),
        path
    );
}

#[test]
fn deserialization_anchors_a_relative_path_to_the_base_directory() {
    let base_directory = absolute("/tmp/base");

    let path = with_base_directory(&base_directory, || {
        serde_json::from_str::<AbsolutePathBuf>(r#""nested/file.txt""#).expect("deserialize")
    });

    assert_eq!(
        path.as_path(),
        absolute_test_path("/tmp/base/nested/file.txt")
    );
}

#[test]
fn deserialization_rejects_a_relative_path_without_a_base_directory() {
    let error = serde_json::from_str::<AbsolutePathBuf>(r#""nested/file.txt""#)
        .expect_err("relative path is rejected");

    assert!(
        error.to_string().contains("path must be absolute"),
        "unexpected error: {error}"
    );
}

#[test]
fn deserialization_accepts_an_absolute_path_without_a_base_directory() {
    let json = serde_json::to_string(&absolute_test_path("/tmp/one")).expect("serialize");

    assert_eq!(
        serde_json::from_str::<AbsolutePathBuf>(&json).expect("deserialize"),
        absolute("/tmp/one")
    );
}

#[test]
fn nested_base_directory_scopes_restore_the_outer_base() {
    let outer = absolute("/tmp/outer");
    let inner = absolute("/tmp/inner");

    let (inner_path, restored_path) = with_base_directory(&outer, || {
        let inner_path = with_base_directory(&inner, || {
            serde_json::from_str::<AbsolutePathBuf>(r#""file.txt""#).expect("deserialize")
        });
        let restored_path =
            serde_json::from_str::<AbsolutePathBuf>(r#""file.txt""#).expect("deserialize");
        (inner_path, restored_path)
    });

    assert_eq!(inner_path, inner.join("file.txt"));
    assert_eq!(restored_path, outer.join("file.txt"));
}

#[test]
fn home_directory_scope_expands_a_bare_tilde() {
    let home = absolute("/tmp/home");

    let path = with_home_directory(home.as_path(), || {
        AbsolutePathBuf::from_absolute("~").expect("home directory")
    });

    assert_eq!(path, home);
}

#[test]
fn home_directory_scope_expands_a_tilde_subpath() {
    let home = absolute("/tmp/home");

    let path = with_home_directory(home.as_path(), || {
        AbsolutePathBuf::from_absolute("~//code/./project").expect("home subpath")
    });

    assert_eq!(path, home.join("code/project"));
}

#[test]
fn home_directory_scope_leaves_a_named_user_unexpanded() {
    let home = absolute("/tmp/home");

    let error = with_home_directory(home.as_path(), || {
        AbsolutePathBuf::from_absolute("~other/code").expect_err("named user is not expanded")
    });

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn nested_home_directory_scopes_restore_the_outer_home() {
    let outer = absolute("/tmp/outer-home");
    let inner = absolute("/tmp/inner-home");

    let (inner_path, restored_path) = with_home_directory(outer.as_path(), || {
        let inner_path = with_home_directory(inner.as_path(), || {
            AbsolutePathBuf::from_absolute("~/project").expect("inner home")
        });
        let restored_path = AbsolutePathBuf::from_absolute("~/project").expect("outer home");
        (inner_path, restored_path)
    });

    assert_eq!(inner_path, inner.join("project"));
    assert_eq!(restored_path, outer.join("project"));
}

#[test]
fn tilde_falls_back_to_the_operating_system_home() {
    let Some(home) = dirs::home_dir() else {
        return;
    };

    let path = AbsolutePathBuf::from_absolute("~/project").expect("operating-system home");

    assert_eq!(path.as_path(), home.join("project"));
}

#[cfg(windows)]
#[test]
fn verbatim_drive_prefix_becomes_an_ordinary_drive_path() {
    let path = AbsolutePathBuf::from_absolute(r"\\?\D:\workspace\project").expect("absolute path");

    assert_eq!(path.as_path(), Path::new(r"D:\workspace\project"));
}

#[cfg(windows)]
#[test]
fn root_relative_path_keeps_the_base_drive() {
    let path = AbsolutePathBuf::resolve_against_base(
        r"\workspace\project",
        &AbsolutePathBuf::from_absolute(r"C:\base\nested").expect("absolute base"),
    );

    assert_eq!(path.as_path(), Path::new(r"C:\workspace\project"));
}

#[cfg(windows)]
#[test]
fn drive_relative_path_keeps_its_own_drive_and_the_base_tail() {
    let path = AbsolutePathBuf::resolve_against_base(
        r"D:workspace\project",
        &AbsolutePathBuf::from_absolute(r"C:\base\nested").expect("absolute base"),
    );

    assert_eq!(
        path.as_path(),
        Path::new(r"D:\base\nested\workspace\project")
    );
}
