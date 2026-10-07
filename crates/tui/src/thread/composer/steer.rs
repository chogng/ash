#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct SteerId(u64);

impl SteerId {
    fn new(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingSteer {
    id: SteerId,
    text: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Steer {
    next_id: u64,
    pending: Vec<PendingSteer>,
}

impl Steer {
    pub(crate) fn push(&mut self, text: String) -> SteerId {
        let id = SteerId::new(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.pending.push(PendingSteer { id, text });
        id
    }

    pub(crate) fn remove(&mut self, id: SteerId) -> bool {
        let previous_len = self.pending.len();
        self.pending.retain(|pending| pending.id != id);
        self.pending.len() != previous_len
    }

    pub(crate) fn clear(&mut self) {
        self.pending.clear();
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
#[path = "steer_tests.rs"]
mod tests;
