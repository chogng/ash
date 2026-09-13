use crate::Dir;

/// Host source retaining access to one directory.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DirSource {
    LaunchArgument,
    SessionRequest,
    PersistentConfiguration,
}

/// One canonical directory and every source currently retaining it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirEntry {
    dir: Dir,
    sources: Vec<DirSource>,
}

impl DirEntry {
    pub(crate) fn new(dir: Dir, source: DirSource) -> Self {
        Self {
            dir,
            sources: vec![source],
        }
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn sources(&self) -> &[DirSource] {
        &self.sources
    }

    pub(crate) fn add_source(&mut self, source: DirSource) -> bool {
        if self.sources.contains(&source) {
            return false;
        }
        self.sources.push(source);
        self.sources.sort_unstable();
        true
    }

    pub(crate) fn remove_source(&mut self, source: DirSource) -> bool {
        let Some(index) = self
            .sources
            .iter()
            .position(|candidate| *candidate == source)
        else {
            return false;
        };
        self.sources.remove(index);
        true
    }

    pub(crate) fn has_no_sources(&self) -> bool {
        self.sources.is_empty()
    }
}
