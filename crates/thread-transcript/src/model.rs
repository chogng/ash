use ash_protocol::ItemId;
use ash_protocol::PlanUpdate;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::StreamCursor;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

/// One complete, render-neutral entry in a Thread transcript.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadTranscriptEntry {
    VoiceTranscript {
        entry_id: String,
        transcript: ash_protocol::VoiceTranscript,
    },
    SkillLoad {
        entry_id: String,
        turn_id: TurnId,
        skill: ash_protocol::FrozenSkillActivation,
    },
    HookRun {
        entry_id: String,
        turn_id: TurnId,
        run: ash_protocol::HookRunRecord,
    },
    Item {
        entry_id: String,
        turn_id: TurnId,
        item: ThreadItem,
        transient: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable, type = "number")]
        timestamp: Option<u64>,
    },
    TurnPlan {
        entry_id: String,
        turn_id: TurnId,
        plan: PlanUpdate,
    },
    TurnError {
        entry_id: String,
        turn_id: TurnId,
        error: StableTurnError,
    },
    ToolOutput {
        entry_id: String,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        stream: ToolOutputStream,
        text: String,
    },
}

impl ThreadTranscriptEntry {
    pub fn entry_id(&self) -> &str {
        match self {
            Self::VoiceTranscript { entry_id, .. }
            | Self::Item { entry_id, .. }
            | Self::HookRun { entry_id, .. }
            | Self::SkillLoad { entry_id, .. }
            | Self::TurnPlan { entry_id, .. }
            | Self::TurnError { entry_id, .. }
            | Self::ToolOutput { entry_id, .. } => entry_id,
        }
    }

    pub fn turn_id(&self) -> Option<&TurnId> {
        match self {
            Self::VoiceTranscript { .. } => None,
            Self::Item { turn_id, .. }
            | Self::HookRun { turn_id, .. }
            | Self::SkillLoad { turn_id, .. }
            | Self::TurnPlan { turn_id, .. }
            | Self::TurnError { turn_id, .. }
            | Self::ToolOutput { turn_id, .. } => Some(turn_id),
        }
    }

    pub fn is_transient(&self) -> bool {
        match self {
            Self::Item { transient, .. } => *transient,
            Self::ToolOutput { .. } => true,
            Self::VoiceTranscript { .. }
            | Self::TurnPlan { .. }
            | Self::TurnError { .. }
            | Self::HookRun { .. }
            | Self::SkillLoad { .. } => false,
        }
    }
}

/// Initial or resynchronized transcript derived from one canonical Thread snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTranscriptSnapshot {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[ts(type = "number")]
    pub durable_sequence: u64,
    #[ts(type = "number")]
    pub revision: u64,
    pub entries: Vec<ThreadTranscriptEntry>,
}

impl ThreadTranscriptSnapshot {
    /// Projects original message times into a bounded history page.
    pub fn with_message_times(mut self, times: &BTreeMap<ItemId, u64>) -> Self {
        for entry in &mut self.entries {
            if let ThreadTranscriptEntry::Item {
                item, timestamp, ..
            } = entry
            {
                *timestamp = times.get(item.item_id()).copied();
            }
        }
        self
    }

    /// Adds only speech belonging to visible history anchors, preserving each span's stable identity.
    pub fn with_voice_transcripts(mut self, transcripts: &[ash_protocol::VoiceTranscript]) -> Self {
        for transcript in transcripts.iter().rev() {
            let position = match &transcript.after_item_id {
                Some(item) => self.entries.iter().position(|entry| matches!(entry, ThreadTranscriptEntry::Item { item: original, .. } if original.item_id() == item)).map(|position| position + 1),
                None => Some(0),
            };
            if let Some(position) = position {
                self.entries.insert(
                    position,
                    ThreadTranscriptEntry::VoiceTranscript {
                        entry_id: transcript.item_id.to_string(),
                        transcript: transcript.clone(),
                    },
                );
            }
        }
        self
    }

    pub fn from_thread(thread: &Thread) -> Self {
        let mut entries = Vec::new();
        for turn in &thread.turns {
            let mut loads = turn
                .skill_loads
                .as_deref()
                .unwrap_or_default()
                .iter()
                .peekable();
            let mut append_loads = |after_item_id, entries: &mut Vec<_>| {
                while let Some(load) =
                    loads.next_if(|load| load.after_item_id.as_ref() == after_item_id)
                {
                    entries.push(skill_load_entry(&turn.turn_id, load));
                }
            };
            append_loads(None, &mut entries);
            for item in &turn.items {
                if !matches!(item, ThreadItem::Reasoning { text, .. } if text.is_empty()) {
                    entries.push(ThreadTranscriptEntry::Item {
                        entry_id: item_entry_id(item.item_id().as_str()),
                        turn_id: turn.turn_id.clone(),
                        item: item.clone(),
                        transient: false,
                        timestamp: None,
                    });
                }
                append_loads(Some(item.item_id()), &mut entries);
            }
            entries.extend(loads.map(|load| skill_load_entry(&turn.turn_id, load)));
            entries.extend(
                thread
                    .hook_runs
                    .iter()
                    .filter(|run| run.turn_id.as_ref() == Some(&turn.turn_id))
                    .map(|run| ThreadTranscriptEntry::HookRun {
                        entry_id: format!("hook:{}", run.run_id),
                        turn_id: turn.turn_id.clone(),
                        run: run.clone(),
                    }),
            );
            if let Some(plan) = &turn.plan {
                entries.push(ThreadTranscriptEntry::TurnPlan {
                    entry_id: turn_plan_entry_id(turn.turn_id.as_str()),
                    turn_id: turn.turn_id.clone(),
                    plan: plan.clone(),
                });
            }
            if let Some(error) = &turn.error {
                entries.push(ThreadTranscriptEntry::TurnError {
                    entry_id: turn_error_entry_id(turn.turn_id.as_str()),
                    turn_id: turn.turn_id.clone(),
                    error: error.clone(),
                });
            }
        }
        Self {
            session_id: thread.session_id.clone(),
            thread_id: thread.thread_id.clone(),
            durable_sequence: thread.sequence,
            revision: 0,
            entries,
        }
    }
}

/// Mechanical list mutation applied by transcript consumers before rendering.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadTranscriptChange {
    Upsert { entry: ThreadTranscriptEntry },
    Remove { entry_ids: Vec<String> },
    ClearTransient,
}

/// One backend-assembled transcript update delivered through App Server.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTranscriptUpdateEnvelope {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[ts(type = "number")]
    pub durable_sequence: u64,
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub stream_cursor: Option<StreamCursor>,
    pub changes: Vec<ThreadTranscriptChange>,
}

pub(crate) fn skill_load_entry(
    turn_id: &TurnId,
    load: &ash_protocol::TurnSkillLoad,
) -> ThreadTranscriptEntry {
    let skill = &load.skill;
    ThreadTranscriptEntry::SkillLoad {
        entry_id: format!(
            "skill-load:{turn_id}:{}:{}:{}",
            skill.id.source,
            skill.id.name,
            skill.content_digest.as_str()
        ),
        turn_id: turn_id.clone(),
        skill: skill.clone(),
    }
}

pub(crate) fn item_entry_id(item_id: &str) -> String {
    format!("item:{item_id}")
}

pub(crate) fn turn_plan_entry_id(turn_id: &str) -> String {
    format!("turn-plan:{turn_id}")
}

pub(crate) fn turn_error_entry_id(turn_id: &str) -> String {
    format!("turn-error:{turn_id}")
}

pub(crate) fn tool_output_entry_id(
    turn_id: &str,
    tool_call_id: &ToolCallId,
    stream: ToolOutputStream,
) -> String {
    let stream = match stream {
        ToolOutputStream::Stdout => "stdout",
        ToolOutputStream::Stderr => "stderr",
    };
    format!("tool-output:{turn_id}:{tool_call_id}:{stream}")
}
