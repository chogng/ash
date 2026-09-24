use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use ash_input_classifier::InputClassification;
use ash_input_classifier::InputClassificationContext;
use ash_input_classifier::InputClassificationTask;
use ash_input_classifier::InputRoute;

use super::ChatInput;
use super::ComposerRoute;
use super::ComposerSubmission;

const CLASSIFICATION_DELAY: Duration = Duration::from_millis(40);
static NEXT_CLASSIFICATION_ID: AtomicU64 = AtomicU64::new(1);

/// Captured input classification that the window host executes off the UI thread.
pub struct ComposerClassificationTask {
    id: u64,
    task: InputClassificationTask,
}

impl ComposerClassificationTask {
    /// Runs model work without accessing the input owner or any window state.
    pub fn run(self) -> ComposerClassificationResult {
        ComposerClassificationResult {
            id: self.id,
            classification: self.task.run(),
        }
    }
}

/// Result tied to one input revision, including across replacement Session Panes.
pub struct ComposerClassificationResult {
    id: u64,
    classification: InputClassification,
}

/// Effect of delivering a classification to its input owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerClassificationUpdate {
    Stale,
    Updated,
    Submit,
}

#[derive(Default)]
pub(super) struct ClassificationState {
    text: String,
    id: Option<u64>,
    pending: Option<(Instant, ComposerClassificationTask)>,
    submit_requested: bool,
}

impl ClassificationState {
    pub(super) fn reset(&mut self, text: &str) {
        self.text = text.to_owned();
        self.id = None;
        self.pending = None;
        self.submit_requested = false;
    }

    pub(super) fn cancel_submission(&mut self) {
        self.submit_requested = false;
    }

    pub(super) fn is_pending(&self) -> bool {
        self.id.is_some()
    }
}

impl ChatInput {
    pub(crate) fn classification_deadline(&self) -> Option<Instant> {
        if self.history.active() {
            return None;
        }
        self.classification
            .pending
            .as_ref()
            .map(|(deadline, _)| *deadline)
    }

    pub(crate) fn take_classification_task(
        &mut self,
        now: Instant,
    ) -> Option<ComposerClassificationTask> {
        if self
            .classification_deadline()
            .is_some_and(|deadline| deadline <= now)
        {
            self.classification.pending.take().map(|(_, task)| task)
        } else {
            None
        }
    }

    pub(crate) fn finish_classification(
        &mut self,
        result: ComposerClassificationResult,
    ) -> ComposerClassificationUpdate {
        if self.classification.id != Some(result.id) {
            return ComposerClassificationUpdate::Stale;
        }
        let submit = self.classification.submit_requested;
        self.classification.reset(self.input.text());
        self.set_classification(result.classification);
        self.refresh_shell_suggestion();
        self.refresh_interaction();
        if submit {
            ComposerClassificationUpdate::Submit
        } else {
            ComposerClassificationUpdate::Updated
        }
    }

    pub(crate) fn request_submission(&mut self) -> Option<ComposerSubmission> {
        if self.input.has_active_composition()
            || self.searching_history()
            || self.input.text().trim().is_empty()
        {
            return None;
        }
        if self.classification.is_pending() {
            self.classification.submit_requested = true;
            if let Some((deadline, _)) = self.classification.pending.as_mut() {
                *deadline = Instant::now();
            }
            return None;
        }
        self.submission()
    }

    pub(super) fn refresh_classification(&mut self) {
        if self.classification.text != self.input.text() {
            self.reclassify();
        } else {
            self.refresh_shell_suggestion();
            self.refresh_interaction();
        }
    }

    pub(crate) fn reclassify(&mut self) {
        let text = self.input.text();
        self.classification.reset(text);
        if let Some(route) = self.recalled_route {
            self.route = route;
            self.refresh_editor_language();
        } else if text.trim_start().starts_with('/') {
            self.route = ComposerRoute::Agent;
            self.refresh_editor_language();
        } else {
            let current_route = match self.route {
                ComposerRoute::Agent => InputRoute::Agent,
                ComposerRoute::Shell => InputRoute::Shell,
            };
            let task = self.classifier.prepare(
                text,
                InputClassificationContext::new(current_route, self.conversation),
            );
            if let Some(classification) = task.classification() {
                self.set_classification(classification);
            } else {
                let id = NEXT_CLASSIFICATION_ID.fetch_add(1, Ordering::Relaxed);
                self.classification.id = Some(id);
                self.classification.pending = Some((
                    Instant::now() + CLASSIFICATION_DELAY,
                    ComposerClassificationTask { id, task },
                ));
            }
        }
        self.refresh_shell_suggestion();
        self.refresh_interaction();
    }

    fn set_classification(&mut self, classification: InputClassification) {
        self.route = match classification.route {
            InputRoute::Agent => ComposerRoute::Agent,
            InputRoute::Shell => ComposerRoute::Shell,
        };
        self.refresh_editor_language();
    }
}

#[cfg(test)]
#[path = "classification_tests.rs"]
mod tests;
