use github::Error;
use github::Repository;
use github::Result;
use github::ShareLink;
use github::SharePathKind;
use github::ShareReference;
use github::ShareTarget;

pub(crate) fn share_link(link: ShareLink) -> Result<String> {
    let repository = Repository::new(
        link.repository.host,
        link.repository.owner,
        link.repository.name,
    )?;
    let reference = match link.reference {
        ShareReference::Commit(commit) => {
            if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid());
            }
            commit
        }
        ShareReference::Branch(branch) => {
            if branch.is_empty()
                || branch.len() > 1024
                || branch
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
                || branch.starts_with('/')
                || branch.ends_with('/')
                || branch.contains("..")
                || branch.contains("@{")
                || branch.contains("//")
                || branch == "@"
                || branch.split('/').any(|part| {
                    part.starts_with('.') || part.ends_with('.') || part.ends_with(".lock")
                })
            {
                return Err(invalid());
            }
            branch
        }
    };
    let base = match link.target {
        ShareTarget::GitHub => format!("https://{}", repository.host),
        ShareTarget::VscodeDev => {
            if repository.host != "github.com" {
                return Err(Error::InvalidInput(
                    "vscode.dev links require GitHub.com".into(),
                ));
            }
            "https://vscode.dev/github".into()
        }
    };
    let mut url = url::Url::parse(&base).map_err(|_| invalid())?;
    {
        let mut path = url.path_segments_mut().map_err(|_| invalid())?;
        path.pop_if_empty()
            .push(&repository.owner)
            .push(&repository.name);
        path.push(match (&link.path, link.path_kind) {
            (Some(_), SharePathKind::File) => "blob",
            (None, _) | (Some(_), SharePathKind::Directory) => "tree",
        });
        for segment in reference.split('/') {
            path.push(segment);
        }
        if let Some(file) = &link.path {
            if file.is_empty()
                || file.len() > 32768
                || file.contains('\\')
                || file.chars().any(char::is_control)
                || file
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(invalid());
            }
            for segment in file.split('/') {
                path.push(segment);
            }
        }
    }
    if (link.path.is_none() || matches!(link.path_kind, SharePathKind::Directory))
        && (link.lines.is_some() || link.notebook_cell.is_some())
    {
        return Err(invalid());
    }
    let mut fragment = if let Some(cell) = link.notebook_cell {
        if cell == 0 {
            return Err(invalid());
        }
        format!("C{cell}")
    } else {
        String::new()
    };
    if let Some(lines) = link.lines {
        if lines.start == 0 || lines.end < lines.start {
            return Err(invalid());
        }
        if !fragment.is_empty() {
            fragment.push(':');
        }
        fragment.push_str(&format!("L{}", lines.start));
        if lines.end != lines.start {
            fragment.push_str(&format!("-L{}", lines.end));
        }
    }
    if !fragment.is_empty() {
        url.set_fragment(Some(&fragment));
    }
    Ok(url.into())
}
fn invalid() -> Error {
    Error::InvalidInput("Invalid GitHub share link".into())
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
