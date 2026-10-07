//! Compile Ash's path restrictions into trailing Seatbelt rules. Glob matching
//! uses the same globset grammar as preparation snapshots; the SDK still owns
//! the baseline profile, process creation and platform cleanup.

use ash_sandboxing::PROTECTED_DIR_METADATA_NAMES;
use ash_sandboxing::ResolvedFileSystem;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxScope;
use globset::GlobBuilder;
use globset::GlobMatcher;
use std::collections::BTreeSet;
use std::fmt::Write;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

pub(super) fn rules(
    scope: &SandboxScope,
    filesystem: &ResolvedFileSystem,
) -> Result<String, SandboxError> {
    let mut rules = BTreeSet::new();
    // These names are reserved even before creation, without creating host
    // directories merely to install a pathname restriction.
    for grant in scope.grants() {
        if filesystem
            .readwrite_paths()
            .contains(&grant.dir().canonical_path().to_owned())
        {
            for name in PROTECTED_DIR_METADATA_NAMES {
                let path = grant.dir().canonical_path().join(name);
                let regex = format!("^{}(/.*)?$", escape(path_text(&path)?));
                rules.insert(format!(
                    "(deny file-write* network-bind network-outbound (regex #{}))",
                    quote(&regex)
                ));
            }
        }
    }
    for rule in scope.path_rules() {
        let Some(pattern) = rule.continuous_pattern() else {
            continue;
        };
        let operations = match rule.access() {
            SandboxPathAccess::Denied => "file-read* file-write* network-bind network-outbound",
            SandboxPathAccess::ReadOnly => "file-write* network-bind network-outbound",
            SandboxPathAccess::ReadWrite => {
                return Err(SandboxError::UnsupportedPolicy(
                    "continuous patterns cannot grant additional write access".into(),
                ));
            }
        };
        // A continuous carveout still restricts file authority when the SDK's
        // concrete path list otherwise grants full disk write access.
        rules.insert("(deny system-fcntl (fcntl-command 80 110))".to_owned());
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| SandboxError::InvalidScope(error.to_string()))?;
        if rule.access() == SandboxPathAccess::Denied {
            inspect_denied_matches(rule.owner().canonical_path(), &glob.compile_matcher())?;
        }
        let expression = seatbelt_expression(glob.regex())?;
        let owner = escape(path_text(rule.owner().canonical_path())?);
        let expression = format!("^{owner}/{}", &expression[1..]);
        // A matching directory protects its descendants too, as a resolved
        // snapshot directory does. These rules also cover later-created paths.
        rules.insert(format!(
            "(deny {operations} (regex #{}))",
            quote(&format!("{}(/.*)?$", &expression[..expression.len() - 1]))
        ));
        // A pathname restriction must survive moves within and between grants.
        // Derive possible ancestor matches from the compiled expression rather
        // than reparsing a glob prefix that may end inside a brace alternative.
        for ancestor in ancestor_expressions(&expression) {
            rules.insert(format!(
                "(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex #{})))",
                quote(&ancestor)
            ));
        }
    }
    let mut output = String::new();
    for rule in rules {
        writeln!(output, "\n{rule}").unwrap();
    }
    Ok(output)
}

fn seatbelt_expression(regex: &str) -> Result<String, SandboxError> {
    // globset emits byte escapes for Unicode literals. Seatbelt accepts the
    // literal UTF-8 text, but does not interpret those escapes equivalently.
    let regex = regex
        .strip_prefix("(?-u)")
        .expect("globset byte expression")
        .replace("(?:", "(");
    let bytes = regex.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    let mut class = false;
    while index < bytes.len() {
        match bytes[index] {
            b'[' => {
                class = true;
                output.push('[');
                index += 1;
            }
            b']' => {
                class = false;
                output.push(']');
                index += 1;
            }
            b'\\' if bytes.get(index + 1) == Some(&b'x') => {
                if class {
                    return Err(SandboxError::UnsupportedPolicy(
                        "Seatbelt cannot preserve byte-based non-ASCII glob character classes"
                            .into(),
                    ));
                }
                let mut literal = Vec::new();
                while bytes.get(index..index + 2) == Some(b"\\x") {
                    literal.push(
                        u8::from_str_radix(&regex[index + 2..index + 4], 16)
                            .expect("globset hex escape"),
                    );
                    index += 4;
                }
                output.push_str(std::str::from_utf8(&literal).expect("globset Unicode literal"));
            }
            b'\\' => {
                output.push('\\');
                output.push(char::from(bytes[index + 1]));
                index += 2;
            }
            ch => {
                output.push(char::from(ch));
                index += 1;
            }
        }
    }
    Ok(output)
}

fn ancestor_expressions(expression: &str) -> BTreeSet<String> {
    let mut ancestors = BTreeSet::new();
    let mut groups = 0;
    let mut class = false;
    let mut escaped = false;
    for (index, ch) in expression.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        match ch {
            '[' if !class => class = true,
            ']' if class => class = false,
            '(' if !class => groups += 1,
            ')' if !class => groups -= 1,
            '/' if !class && index > 1 => {
                ancestors.insert(format!("{}{}$", &expression[..index], ")".repeat(groups)));
            }
            _ => {}
        }
    }
    ancestors
}

fn inspect_denied_matches(root: &Path, matcher: &GlobMatcher) -> Result<(), SandboxError> {
    let started = Instant::now();
    let mut pending = vec![(root.to_owned(), false)];
    while let Some((directory, protected)) = pending.pop() {
        if started.elapsed() > Duration::from_secs(30) {
            return Err(SandboxError::InvalidScope(
                "continuous denied-path link inspection exceeded its preparation budget".into(),
            ));
        }
        for entry in std::fs::read_dir(&directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            let kind = entry.file_type().map_err(io_error)?;
            let denied = protected || matcher.is_match(path.strip_prefix(root).unwrap());
            if denied {
                if kind.is_symlink() {
                    return Err(SandboxError::UnsupportedPolicy(format!(
                        "continuous denied path is a symbolic link: {}",
                        path.display()
                    )));
                }
                ash_sandboxing::reject_linked_file(&path)?;
            }
            if kind.is_dir() {
                pending.push((path, denied));
            }
        }
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> SandboxError {
    SandboxError::Io(error.to_string())
}

fn path_text(path: &Path) -> Result<&str, SandboxError> {
    path.to_str()
        .ok_or_else(|| SandboxError::UnsupportedPolicy("Seatbelt requires Unicode paths".into()))
}

fn escape(text: &str) -> String {
    let mut escaped = String::new();
    for ch in text.chars() {
        if ".+*?()|[]{}^$\\".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn quote(text: &str) -> String {
    // Regex literals retain backslashes; only quote delimiters need escaping.
    format!("\"{}\"", text.replace('"', "\\\""))
}

#[cfg(test)]
#[path = "seatbelt_tests.rs"]
mod tests;
