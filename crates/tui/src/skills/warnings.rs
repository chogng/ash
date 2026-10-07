use ash_app_server_protocol::protocol::skills::SkillDiagnosticDto;

/// Tracks active backend diagnostics so the TUI reports only newly visible Skill errors.
#[derive(Debug, Default)]
pub(crate) struct SkillDiagnosticWarnings {
    active: Vec<SkillDiagnosticDto>,
}

impl SkillDiagnosticWarnings {
    pub(crate) fn update(&mut self, diagnostics: &[SkillDiagnosticDto]) -> Vec<String> {
        let mut current = Vec::new();
        let mut new = Vec::new();
        for diagnostic in diagnostics {
            if current.contains(diagnostic) {
                continue;
            }
            if !self.active.contains(diagnostic) {
                new.push(diagnostic);
            }
            current.push(diagnostic.clone());
        }
        self.active = current;

        if new.is_empty() {
            return Vec::new();
        }
        let count = new.len();
        let noun = if count == 1 { "error" } else { "errors" };
        let mut notices = vec![format!("Skill catalog reported {count} new {noun}.")];
        notices.extend(new.into_iter().map(|diagnostic| {
            let subject = diagnostic.subject.as_deref().unwrap_or(&diagnostic.source);
            format!("{subject}: {}", diagnostic.message)
        }));
        notices
    }

    pub(crate) fn clear(&mut self) {
        self.active.clear();
    }
}

#[cfg(test)]
#[path = "warnings_tests.rs"]
mod tests;
