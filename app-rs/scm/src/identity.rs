use zui::ui::ElementId;

/// Identity space of one mounted Changes view. The host allocates owners for the lifetime of
/// a view, never from its position in the split tree. All descendants and animation keys share it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ScmPaneIdentity(u32);

impl ScmPaneIdentity {
    /// Reserves the high scope bit for SCM, keeping mounted views distinct from shell IDs
    /// and editor identities allocated by other domains.
    pub fn new(owner: u32) -> Self {
        assert!(owner < (1 << 25), "Changes view identity space exhausted");
        Self((1 << 25) | owner)
    }

    pub const fn owner(self) -> u32 {
        self.0
    }

    pub const fn element(self, local: ElementId) -> ElementId {
        let raw = local.into_raw();
        ElementId::scoped((self.0 << 6) | (raw >> 32) as u32, raw as u32)
    }

    pub fn local(self, id: ElementId) -> Option<ElementId> {
        let raw = id.into_raw();
        let scope = (raw >> 32) as u32;
        (scope >> 6 == self.0).then(|| ElementId::scoped(scope & 63, raw as u32))
    }
}
