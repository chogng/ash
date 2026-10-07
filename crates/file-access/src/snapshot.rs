use crate::Authorization;

/// Monotonic identity of one effective directory access scope.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Revision(u64);

impl Revision {
    pub(crate) fn advance(&mut self) {
        self.0 = self
            .0
            .checked_add(1)
            .expect("directory access revision space is not exhausted");
    }

    /// Returns the monotonic numeric value used for equality and diagnostics.
    pub fn get(self) -> u64 {
        self.0
    }
}

/// Observable result of an idempotent directory-access mutation.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Mutation {
    AddedDir,
    AddedSource,
    AlreadyPresent,
    RemovedSource,
    RemovedDir,
    UpdatedPermissions,
    NotPresent,
}

impl Mutation {
    pub(crate) fn changes_scope(self) -> bool {
        matches!(
            self,
            Self::AddedDir
                | Self::AddedSource
                | Self::RemovedSource
                | Self::RemovedDir
                | Self::UpdatedPermissions
        )
    }
}

/// Immutable permission-bound directory authorizations for one model or tool operation.
#[derive(Clone, Debug)]
pub struct Snapshot {
    revision: Revision,
    authorizations: Vec<Authorization>,
}

impl Snapshot {
    pub(crate) fn new(revision: Revision, authorizations: Vec<Authorization>) -> Self {
        Self {
            revision,
            authorizations,
        }
    }

    /// Returns the authority revision frozen by this snapshot.
    pub fn revision(&self) -> Revision {
        self.revision
    }

    /// Returns sorted authorizations bound to the permission requested by the consumer.
    pub fn authorizations(&self) -> &[Authorization] {
        &self.authorizations
    }
}
