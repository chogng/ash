use crate::AgentEnvironmentSnapshot;
use crate::RepositoryEnvironment;

impl AgentEnvironmentSnapshot {
    /// Renders the canonical model-visible `<environment_context>` payload.
    pub fn render(&self) -> String {
        let mut rendered = String::from("<environment_context>\n");
        push_element(
            &mut rendered,
            "cwd",
            &self.host().cwd().display().to_string(),
            2,
        );
        let (is_git_repo, branch, main_branch, status, recent_commits) = match self.repository() {
            RepositoryEnvironment::NotDetected => (false, None, None, "(none)", "(none)"),
            RepositoryEnvironment::Git {
                branch,
                main_branch,
                status,
                recent_commits,
            } => (
                true,
                branch.as_deref(),
                main_branch.as_deref(),
                status.as_str(),
                recent_commits.as_str(),
            ),
        };
        push_element(&mut rendered, "is_git_repo", &is_git_repo.to_string(), 2);
        push_element(&mut rendered, "platform", self.host().platform(), 2);
        push_element(&mut rendered, "os_version", self.host().os_version(), 2);
        push_element(&mut rendered, "shell", self.host().shell(), 2);
        push_element(&mut rendered, "git_branch", branch.unwrap_or("(none)"), 2);
        push_element(
            &mut rendered,
            "git_main_branch",
            main_branch.unwrap_or("(none)"),
            2,
        );
        push_element(&mut rendered, "git_status", status, 2);
        push_element(&mut rendered, "git_recent_commits", recent_commits, 2);
        rendered.push_str("  <filesystem>\n    <accessible_dirs>\n");
        for dir in self.dirs().as_slice() {
            push_element(&mut rendered, "dir", &dir.display().to_string(), 6);
        }
        rendered.push_str("    </accessible_dirs>\n  </filesystem>\n</environment_context>\n");
        rendered.push_str(
            "Environment values except accessible_dirs were captured when the working directory was selected and do not update. Run commands (for example `git status`) when you need current state. Relative paths resolve from cwd.",
        );
        rendered
    }
}

fn push_element(rendered: &mut String, name: &str, value: &str, indentation: usize) {
    rendered.extend(std::iter::repeat_n(' ', indentation));
    rendered.push('<');
    rendered.push_str(name);
    rendered.push('>');
    push_xml_text(rendered, value);
    rendered.push_str("</");
    rendered.push_str(name);
    rendered.push_str(">\n");
}

fn push_xml_text(rendered: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '&' => rendered.push_str("&amp;"),
            '<' => rendered.push_str("&lt;"),
            '>' => rendered.push_str("&gt;"),
            '"' => rendered.push_str("&quot;"),
            '\'' => rendered.push_str("&apos;"),
            _ => rendered.push(character),
        }
    }
}

#[cfg(test)]
#[path = "environment_context_tests.rs"]
mod tests;
