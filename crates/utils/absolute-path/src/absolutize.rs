// Lexical normalization adapted from path-absolutize 3.1.1:
// Copyright (c) 2018 magiclen.org (Ron Li). Licensed under the MIT License.
//
// The implementation stays local so resolving against an explicit base is infallible; only
// reading the process working directory remains fallible.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// Collapses `.` and `..` in an already absolute path without touching the filesystem.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

/// Anchors `path` to `base_path` and collapses `.` and `..`.
pub(crate) fn absolutize_from(path: &Path, base_path: &Path) -> PathBuf {
    normalize(&path_with_base(path, base_path))
}

#[cfg(not(windows))]
fn path_with_base(path: &Path, base_path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_path.join(path)
    }
}

/// Windows spells three kinds of non-absolute path: relative (`sub\file`), root-relative
/// (`\sub\file`, which keeps the base drive), and drive-relative (`D:sub\file`, which keeps its
/// own drive but takes the remaining segments from the base).
#[cfg(windows)]
fn path_with_base(path: &Path, base_path: &Path) -> PathBuf {
    if path.is_absolute() || path.has_root() {
        return base_path.join(path);
    }

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return base_path.join(path);
    };

    let mut path = PathBuf::new();
    path.push(prefix.as_os_str());

    if components.clone().next().is_none() {
        path.push(std::path::MAIN_SEPARATOR_STR);
        return path;
    }

    let skip_base_prefix = matches!(base_path.components().next(), Some(Component::Prefix(_)));
    for component in base_path
        .components()
        .skip(usize::from(skip_base_prefix))
        .chain(components)
    {
        path.push(component.as_os_str());
    }
    path
}
