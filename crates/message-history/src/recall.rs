use crate::MessageHistory;
use crate::MessageHistoryKind;
use crate::MessageHistoryPage;
use crate::MessageHistoryQuery;
use crate::MessageHistorySubmission;
use crate::MessageHistoryTask;
use std::collections::VecDeque;

#[derive(Debug)]
pub enum MessageHistoryRecallEffect {
    Keep,
    Recall(MessageHistorySubmission),
    Restore,
}

#[derive(Debug)]
struct Navigation {
    query: Option<String>,
    entries: Vec<MessageHistorySubmission>,
    index: Option<usize>,
    next_before: Option<u64>,
    pending: Option<MessageHistoryTask<MessageHistoryPage>>,
    error: Option<String>,
}

/// Input-owned recall cursor. Each input owns its own instance, including its search state.
/// Persistent requests run on the shared local worker; replacing a query
/// drops its task so an old response cannot replace the current draft or search.
#[derive(Debug, Default)]
pub struct MessageHistoryRecall {
    client: Option<MessageHistory>,
    thread_id: Option<String>,
    local: VecDeque<MessageHistorySubmission>,
    writes: Vec<MessageHistoryTask<()>>,
    navigation: Option<Navigation>,
    write_error: Option<String>,
    unavailable: Option<String>,
}

impl MessageHistoryRecall {
    pub fn connect(&mut self, client: MessageHistory) {
        self.client = Some(client);
        self.unavailable = None;
    }

    /// Reports a failed local store without substituting another persistence source.
    pub fn unavailable(&mut self, error: String) {
        self.client = None;
        self.unavailable = Some(error);
        self.reset();
    }

    pub fn set_thread_id(&mut self, thread_id: String) {
        self.thread_id = Some(thread_id);
    }

    pub fn record(&mut self, text: String, kind: MessageHistoryKind) {
        if self.unavailable.is_some() {
            return;
        }
        let submission = MessageHistorySubmission {
            text,
            kind,
            thread_id: self.thread_id.clone(),
        };
        if self.local.back() != Some(&submission) {
            self.local.push_back(submission.clone());
            if self.local.len() > 100 {
                self.local.pop_front();
            }
        }
        if let Some(client) = &self.client {
            match client.append(submission) {
                Ok(task) => self.writes.push(task),
                Err(error) => self.write_error = Some(error),
            }
        }
    }

    pub fn active(&self) -> bool {
        self.navigation.is_some()
    }

    pub fn query(&self) -> Option<&str> {
        self.navigation
            .as_ref()
            .and_then(|navigation| navigation.query.as_deref())
    }

    pub fn reset(&mut self) {
        self.navigation = None;
    }

    pub fn search(&mut self, query: String) -> MessageHistoryRecallEffect {
        self.begin(Some(query))
    }

    fn begin(&mut self, query: Option<String>) -> MessageHistoryRecallEffect {
        self.navigation = Some(Navigation {
            query,
            entries: Vec::new(),
            index: None,
            next_before: None,
            pending: None,
            error: None,
        });
        if self.unavailable.is_some() {
            return MessageHistoryRecallEffect::Keep;
        }
        if self.client.is_some() {
            self.request(None);
            MessageHistoryRecallEffect::Keep
        } else {
            let navigation = self.navigation.as_mut().unwrap();
            let query = navigation.query.as_deref().unwrap_or("").to_lowercase();
            for text in self.local.iter().rev() {
                if text.text.to_lowercase().contains(&query)
                    && !navigation
                        .entries
                        .iter()
                        .any(|entry| entry.text == text.text && entry.kind == text.kind)
                {
                    navigation.entries.push(text.clone());
                }
            }
            self.older()
        }
    }

    pub fn older(&mut self) -> MessageHistoryRecallEffect {
        let Some(navigation) = self.navigation.as_mut() else {
            return self.begin(None);
        };
        if navigation.pending.is_some() {
            return MessageHistoryRecallEffect::Keep;
        }
        let next = navigation.index.map_or(0, |index| index + 1);
        if let Some(text) = navigation.entries.get(next) {
            navigation.index = Some(next);
            return MessageHistoryRecallEffect::Recall(text.clone());
        }
        if let Some(before) = navigation.next_before {
            self.request(Some(before));
        }
        MessageHistoryRecallEffect::Keep
    }

    pub fn newer(&mut self) -> MessageHistoryRecallEffect {
        let Some(navigation) = self.navigation.as_mut() else {
            return MessageHistoryRecallEffect::Keep;
        };
        if let Some(index) = navigation.index.and_then(|index| index.checked_sub(1)) {
            navigation.pending = None;
            navigation.index = Some(index);
            MessageHistoryRecallEffect::Recall(navigation.entries[index].clone())
        } else if navigation.query.is_some() {
            MessageHistoryRecallEffect::Keep
        } else {
            self.reset();
            MessageHistoryRecallEffect::Restore
        }
    }

    pub fn accept(&mut self) -> MessageHistoryRecallEffect {
        let selected = self
            .navigation
            .as_ref()
            .is_some_and(|navigation| navigation.index.is_some());
        self.reset();
        if selected {
            MessageHistoryRecallEffect::Keep
        } else {
            MessageHistoryRecallEffect::Restore
        }
    }

    pub fn poll(&mut self) -> (bool, MessageHistoryRecallEffect) {
        let mut changed = false;
        self.writes.retain_mut(|task| match task.poll() {
            Some(result) => {
                if let Err(error) = result {
                    self.write_error = Some(error);
                    changed = true;
                }
                false
            }
            None => true,
        });
        let result = self
            .navigation
            .as_mut()
            .and_then(|navigation| navigation.pending.as_mut())
            .and_then(MessageHistoryTask::poll);
        let Some(result) = result else {
            return (changed, MessageHistoryRecallEffect::Keep);
        };
        let navigation = self.navigation.as_mut().unwrap();
        navigation.pending = None;
        match result {
            Ok(page) => {
                navigation.next_before = page.next_before;
                for entry in page.entries {
                    let text = entry.submission;
                    if !navigation
                        .entries
                        .iter()
                        .any(|entry| entry.text == text.text && entry.kind == text.kind)
                    {
                        navigation.entries.push(text);
                    }
                }
                (true, self.older())
            }
            Err(error) => {
                navigation.error = Some(error);
                (true, MessageHistoryRecallEffect::Keep)
            }
        }
    }

    fn request(&mut self, before: Option<u64>) {
        let Some(client) = &self.client else {
            return;
        };
        let navigation = self.navigation.as_mut().unwrap();
        let query = MessageHistoryQuery {
            before,
            text: navigation.query.clone().unwrap_or_default(),
            ..MessageHistoryQuery::default()
        };
        match client.read(query) {
            Ok(task) => {
                navigation.pending = Some(task);
                navigation.error = None;
            }
            Err(error) => navigation.error = Some(error),
        }
    }

    pub fn status(&self) -> MessageHistoryRecallStatus<'_> {
        MessageHistoryRecallStatus {
            active: self.navigation.is_some(),
            query: self.query(),
            loading: self
                .navigation
                .as_ref()
                .is_some_and(|navigation| navigation.pending.is_some()),
            empty: self
                .navigation
                .as_ref()
                .is_some_and(|navigation| navigation.entries.is_empty()),
            error: self
                .unavailable
                .as_deref()
                .or(self.write_error.as_deref())
                .or_else(|| {
                    self.navigation
                        .as_ref()
                        .and_then(|navigation| navigation.error.as_deref())
                }),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MessageHistoryRecallStatus<'a> {
    pub active: bool,
    pub query: Option<&'a str>,
    pub loading: bool,
    pub empty: bool,
    pub error: Option<&'a str>,
}
