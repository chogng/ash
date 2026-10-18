use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use ash_debug_contract::DebugConsoleEntry;
use ash_debug_contract::DebugConsoleEntryKind;
use ash_debug_contract::DebugConsoleSnapshot;
use ash_debug_contract::DebugSessionAdmission;
use ash_debug_contract::DebugSessionRelation;
use serde_json::Value;

use crate::DebugClientError;
use crate::DebugManager;
use crate::DebugManagerError;
use crate::DebugSessionId;

#[derive(Default)]
pub struct DebugSessions(Mutex<State>);

#[derive(Default)]
struct State {
    nodes: HashMap<(u64, String), Node>,
    consoles: HashMap<(u64, String), Console>,
    next_order: u64,
}

struct Node {
    admission: DebugSessionAdmission,
    console_id: String,
    no_debug: Option<bool>,
    ended: bool,
    order: u64,
    resource: Option<(Weak<DebugManager>, DebugSessionId)>,
}

#[derive(Default)]
struct Console {
    revision: u64,
    next_id: u64,
    bytes: usize,
    entries: VecDeque<(DebugConsoleEntry, usize)>,
    groups: HashMap<String, Vec<u64>>,
}

impl DebugSessions {
    pub fn reserve(
        &self,
        owner: u64,
        options: DebugSessionAdmission,
    ) -> Result<DebugSessionRelation, DebugManagerError> {
        if [&options.id, &options.workspace_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 2048 || id.contains('\0'))
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        if options.id.len() > 256
            || options
                .parent_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        state.trim(owner);
        let key = (owner, options.id.clone());
        if state
            .nodes
            .keys()
            .filter(|(connection, _)| *connection == owner)
            .count()
            >= 512
            || state.nodes.contains_key(&key)
            || state
                .nodes
                .iter()
                .filter(|((connection, _), node)| *connection == owner && !node.ended)
                .count()
                >= 128
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let parent = options
            .parent_id
            .as_ref()
            .map(|id| {
                state
                    .nodes
                    .get(&(owner, id.clone()))
                    .ok_or(DebugManagerError::NotFound)
            })
            .transpose()?;
        if parent
            .is_some_and(|node| node.ended || node.admission.workspace_id != options.workspace_id)
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let console_id = parent
            .filter(|_| options.merge_console)
            .map_or_else(|| options.id.clone(), |node| node.console_id.clone());
        let no_debug = options
            .no_debug
            .or_else(|| parent.and_then(|node| node.no_debug));
        state.next_order += 1;
        let order = state.next_order;
        state.nodes.insert(
            key,
            Node {
                admission: options.clone(),
                console_id: console_id.clone(),
                no_debug,
                ended: false,
                order,
                resource: None,
            },
        );
        state.consoles.entry((owner, console_id)).or_default();
        state.trim(owner);
        state.relation(owner, &options.id)
    }

    /// Commit resolved launch facts before exposing the preparing session to
    /// descriptor callbacks, which may immediately start an inheriting child.
    pub fn prepare(
        &self,
        owner: u64,
        id: &str,
        no_debug: Option<bool>,
    ) -> Result<DebugSessionRelation, DebugManagerError> {
        let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let node = state
            .nodes
            .get_mut(&(owner, id.to_owned()))
            .ok_or(DebugManagerError::NotFound)?;
        if node.ended || node.resource.is_some() {
            return Err(DebugClientError::Closed.into());
        }
        node.no_debug = no_debug;
        state.relation(owner, id)
    }

    pub fn read(&self, owner: u64, id: &str) -> Result<DebugSessionRelation, DebugManagerError> {
        self.0
            .lock()
            .map_err(|_| DebugManagerError::Busy)?
            .relation(owner, id)
    }

    pub(crate) fn bind(
        &self,
        owner: u64,
        id: &str,
        manager: &Arc<DebugManager>,
        session: DebugSessionId,
        no_debug: Option<bool>,
    ) -> Result<(), DebugManagerError> {
        let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let node = state
            .nodes
            .get_mut(&(owner, id.to_owned()))
            .ok_or(DebugManagerError::NotFound)?;
        if node.ended || node.resource.is_some() {
            return Err(DebugClientError::Closed.into());
        }
        if node.no_debug != no_debug {
            return Err(DebugClientError::InvalidMessage.into());
        }
        node.resource = Some((Arc::downgrade(manager), session));
        Ok(())
    }

    /// Compute revocation under the graph lock, then release runtime resources
    /// outside it. No directory manager or extension callback owns the graph.
    pub fn end(&self, owner: u64, id: &str) -> Result<DebugSessionRelation, DebugManagerError> {
        self.revoke(owner, id, true)
    }

    pub(crate) fn end_observed(
        &self,
        owner: u64,
        id: &str,
    ) -> Result<DebugSessionRelation, DebugManagerError> {
        self.revoke(owner, id, false)
    }

    fn revoke(
        &self,
        owner: u64,
        id: &str,
        include_root: bool,
    ) -> Result<DebugSessionRelation, DebugManagerError> {
        let (relation, resources) = {
            let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
            let relation = state.relation(owner, id)?;
            let mut resources = Vec::new();
            for child in relation
                .descendants
                .iter()
                .chain(std::iter::once(&relation.id))
            {
                if let Some(node) = state.nodes.get_mut(&(owner, child.clone())) {
                    let console_id = node.console_id.clone();
                    if !node.ended {
                        node.ended = true;
                        if child != id || include_root {
                            if let Some(resource) = node.resource.take() {
                                resources.push(resource);
                            }
                        }
                    }
                    // A retained shared console must not keep every ended child's group stack.
                    if let Some(console) = state.consoles.get_mut(&(owner, console_id)) {
                        console.groups.remove(child);
                    }
                }
            }
            (state.relation(owner, id)?, resources)
        };
        for (manager, session) in resources {
            if let Some(manager) = manager.upgrade() {
                manager.end_from_parent(&session);
            }
        }
        Ok(relation)
    }

    pub fn close_owner(&self, owner: u64) {
        if let Ok(mut state) = self.0.lock() {
            state
                .nodes
                .retain(|(connection, _), _| *connection != owner);
            state
                .consoles
                .retain(|(connection, _), _| *connection != owner);
        }
    }

    pub fn revision(&self, owner: u64, id: &str) -> Result<u64, DebugManagerError> {
        let state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let key = state.console_key(owner, id)?;
        Ok(state
            .consoles
            .get(&key)
            .ok_or(DebugManagerError::NotFound)?
            .revision)
    }

    pub fn console(&self, owner: u64, id: &str) -> Result<DebugConsoleSnapshot, DebugManagerError> {
        let state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let node = state
            .nodes
            .get(&(owner, id.to_owned()))
            .ok_or(DebugManagerError::NotFound)?;
        let console = state
            .consoles
            .get(&(owner, node.console_id.clone()))
            .ok_or(DebugManagerError::NotFound)?;
        let mut entries: Vec<_> = console
            .entries
            .iter()
            .map(|(entry, _)| entry.clone())
            .collect();
        let ids: std::collections::HashSet<_> = entries.iter().map(|entry| entry.id).collect();
        for entry in &mut entries {
            if entry.parent_id.is_some_and(|id| !ids.contains(&id)) {
                entry.parent_id = None;
            }
        }
        Ok(DebugConsoleSnapshot {
            revision: console.revision,
            entries,
        })
    }

    pub fn clear_console(&self, owner: u64, id: &str) -> Result<(), DebugManagerError> {
        let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let key = state.console_key(owner, id)?;
        let console = state
            .consoles
            .get_mut(&key)
            .ok_or(DebugManagerError::NotFound)?;
        console.entries.clear();
        console.groups.clear();
        console.bytes = 0;
        console.revision += 1;
        Ok(())
    }

    pub fn append(
        &self,
        owner: u64,
        id: &str,
        kind: DebugConsoleEntryKind,
        body: &Value,
    ) -> Result<(), DebugManagerError> {
        self.append_entry(owner, id, kind, body, None)
    }

    pub(crate) fn append_output(
        &self,
        owner: u64,
        id: &str,
        kind: DebugConsoleEntryKind,
        body: &Value,
        epoch: u64,
    ) -> Result<(), DebugManagerError> {
        self.append_entry(owner, id, kind, body, Some(epoch))
    }

    fn append_entry(
        &self,
        owner: u64,
        id: &str,
        kind: DebugConsoleEntryKind,
        body: &Value,
        inspection_revision: Option<u64>,
    ) -> Result<(), DebugManagerError> {
        let mut state = self.0.lock().map_err(|_| DebugManagerError::Busy)?;
        let key = state.console_key(owner, id)?;
        let console = state
            .consoles
            .get_mut(&key)
            .ok_or(DebugManagerError::NotFound)?;
        let groups = console.groups.entry(id.to_owned()).or_default();
        let group = body.get("group").and_then(Value::as_str);
        if group == Some("end") {
            groups.pop();
            return Ok(());
        }
        let group_start = matches!(group, Some("start" | "startCollapsed"));
        let output = tail(
            body.get("output")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            64 * 1024,
        );
        let variables_reference = body
            .get("variablesReference")
            .and_then(Value::as_u64)
            .filter(|id| (1..=9_007_199_254_740_991).contains(id));
        let data = body
            .get("data")
            .filter(|data| data.to_string().len() <= 32 * 1024)
            .cloned();
        if output.is_empty() && variables_reference.is_none() && data.is_none() && !group_start {
            return Ok(());
        }
        console.next_id += 1;
        let source = body
            .get("source")
            .and_then(Value::as_object)
            .and_then(|source| {
                let mut value = serde_json::Map::new();
                for (key, limit) in [("name", 4096), ("path", 32768)] {
                    if let Some(text) = source.get(key).and_then(Value::as_str).filter(|text| {
                        !text.is_empty() && text.len() <= limit && !text.contains('\0')
                    }) {
                        value.insert(key.to_owned(), Value::String(text.to_owned()));
                    }
                }
                if let Some(reference) = source
                    .get("sourceReference")
                    .and_then(Value::as_u64)
                    .filter(|id| *id <= 9_007_199_254_740_991)
                {
                    value.insert("sourceReference".to_owned(), reference.into());
                }
                (value.contains_key("path")
                    || value
                        .get("sourceReference")
                        .and_then(Value::as_u64)
                        .is_some_and(|reference| reference > 0))
                .then_some(Value::Object(value))
            });
        let mut entry = DebugConsoleEntry {
            id: console.next_id,
            session_id: id.to_owned(),
            kind: if group_start {
                DebugConsoleEntryKind::Group
            } else {
                kind
            },
            output,
            category: bounded(
                body.get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("console"),
                256,
            ),
            parent_id: groups.last().copied(),
            collapsed: group == Some("startCollapsed"),
            variables_reference,
            inspection_revision: variables_reference.and(inspection_revision),
            source,
            line: body
                .get("line")
                .and_then(Value::as_u64)
                .and_then(|line| u32::try_from(line).ok())
                .filter(|line| *line > 0),
            column: body
                .get("column")
                .and_then(Value::as_u64)
                .and_then(|column| u32::try_from(column).ok())
                .filter(|column| *column > 0),
            data,
        };
        if group_start && groups.len() < 64 {
            groups.push(entry.id);
        }
        let size = |entry: &DebugConsoleEntry| {
            serde_json::to_vec(entry)
                .map(|value| value.len())
                .map_err(|_| DebugClientError::InvalidMessage)
        };
        let mut bytes = size(&entry)?;
        // Prefer the output tail to optional metadata. The budget includes JSON
        // escaping, not just UTF-8 text (a control character can occupy six bytes).
        if bytes > 128_000 {
            entry.data = None;
            bytes = size(&entry)?;
        }
        if bytes > 128_000 {
            entry.source = None;
            bytes = size(&entry)?;
        }
        while bytes > 128_000 && !entry.output.is_empty() {
            entry.output = tail(&entry.output, entry.output.len() / 2);
            bytes = size(&entry)?;
        }
        console.entries.push_back((entry, bytes));
        console.bytes += bytes;
        console.revision += 1;
        while console.entries.len() > 512 || console.bytes > 128_000 {
            if let Some((_, bytes)) = console.entries.pop_front() {
                console.bytes -= bytes;
            }
        }
        Ok(())
    }
}

impl State {
    fn console_key(&self, owner: u64, id: &str) -> Result<(u64, String), DebugManagerError> {
        self.nodes
            .get(&(owner, id.to_owned()))
            .map(|node| (owner, node.console_id.clone()))
            .ok_or(DebugManagerError::NotFound)
    }

    fn relation(&self, owner: u64, id: &str) -> Result<DebugSessionRelation, DebugManagerError> {
        let node = self
            .nodes
            .get(&(owner, id.to_owned()))
            .ok_or(DebugManagerError::NotFound)?;
        let mut target = node;
        for _ in 0..128 {
            if !target.admission.lifecycle_managed_by_parent {
                break;
            }
            let Some(parent) = &target.admission.parent_id else {
                break;
            };
            target = self
                .nodes
                .get(&(owner, parent.clone()))
                .ok_or(DebugManagerError::NotFound)?;
        }
        let mut descendants = Vec::new();
        let mut frontier = vec![id.to_owned()];
        while let Some(parent) = frontier.pop() {
            for ((connection, child), candidate) in &self.nodes {
                if *connection == owner && candidate.admission.parent_id.as_deref() == Some(&parent)
                {
                    descendants.push(child.clone());
                    frontier.push(child.clone());
                }
            }
        }
        descendants.reverse();
        Ok(DebugSessionRelation {
            id: id.to_owned(),
            parent_id: node.admission.parent_id.clone(),
            console_catalog_revision: self.next_order,
            console_id: node.console_id.clone(),
            console_ids: self
                .consoles
                .keys()
                .filter(|(connection, _)| *connection == owner)
                .map(|(_, id)| id.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect(),
            lifecycle_target_id: target.admission.id.clone(),
            no_debug: node.no_debug,
            ended: node.ended,
            descendants,
        })
    }

    fn trim(&mut self, owner: u64) {
        while self
            .nodes
            .keys()
            .filter(|(connection, _)| *connection == owner)
            .count()
            >= 512
        {
            let candidate = self
                .nodes
                .iter()
                .filter(|((connection, id), node)| {
                    *connection == owner
                        && node.ended
                        && node.console_id != *id
                        && !self.nodes.iter().any(|((connection, _), child)| {
                            *connection == owner && child.admission.parent_id.as_deref() == Some(id)
                        })
                })
                .min_by_key(|(_, node)| node.order)
                .map(|(key, _)| key.clone());
            let Some(key) = candidate else {
                break;
            };
            if let Some(node) = self.nodes.remove(&key) {
                if let Some(console) = self.consoles.get_mut(&(owner, node.console_id)) {
                    console.groups.remove(&key.1);
                }
            }
        }

        let mut ended: Vec<_> = self
            .consoles
            .keys()
            .filter(|(connection, console)| {
                *connection == owner
                    && self
                        .nodes
                        .iter()
                        .filter(|((connection, _), node)| {
                            *connection == owner && node.console_id == *console
                        })
                        .all(|(_, node)| node.ended)
            })
            .cloned()
            .collect();
        ended.sort_by_key(|key| self.nodes.get(key).map_or(0, |node| node.order));
        let excess = ended.len().saturating_sub(20);
        for key in ended.into_iter().take(excess) {
            self.consoles.remove(&key);
            self.nodes
                .retain(|(connection, _), node| *connection != owner || node.console_id != key.1);
        }
    }
}

fn tail(value: &str, maximum: usize) -> String {
    let mut start = value.len().saturating_sub(maximum);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn bounded(value: &str, maximum: usize) -> String {
    let mut end = value.len().min(maximum);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
