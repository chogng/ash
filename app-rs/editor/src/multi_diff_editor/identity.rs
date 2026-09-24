use zui::ui::AnimationKey;
use zui::ui::AnimationProperty;
use zui::ui::ElementId;

const FOLD_SCOPE: u32 = 4;
const SECTION_SCOPE: u32 = 10;
const HEADER_SCOPE: u32 = 11;
const DIFF_SCOPE: u32 = 12;
const HEADER_ACTION_SCOPE: u32 = 13;

/// Stable identity for one changed-file section in a [`MultiDiffEditor`].
///
/// The product host allocates a slot from the lifetime of the represented file, not from its
/// current position in a snapshot. The same identity derives the section, header, diff body,
/// fold controls, and height-animation track, so reordering files does not move retained state to
/// another file. Slots must be non-zero and remain stable while the file is retained by the host.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct MultiDiffEditorItemIdentity {
    slot: u32,
}

impl MultiDiffEditorItemIdentity {
    /// Creates an identity from a host-owned non-zero slot.
    ///
    /// A slot is intentionally opaque to the editor presentation. Hosts should allocate it from
    /// a stable file key and must not derive it from the file's current array index.
    pub fn from_slot(slot: u32) -> Self {
        assert!(slot != 0, "multi-diff item identity slots must be non-zero");
        Self { slot }
    }

    /// Returns the host-owned slot for diagnostics and deterministic tests.
    pub const fn slot(self) -> u32 {
        self.slot
    }

    /// Returns the identity of the file card that contains the diff.
    pub const fn section_id(self) -> ElementId {
        ElementId::scoped(SECTION_SCOPE, self.slot)
    }

    /// Returns the identity of the file header inside the card.
    pub const fn header_id(self) -> ElementId {
        ElementId::scoped(HEADER_SCOPE, self.slot)
    }

    /// Decodes a file identity from a header interaction target.
    pub fn from_header_id(id: ElementId) -> Option<Self> {
        let (scope, local) = split_element_id(id);
        (scope == HEADER_SCOPE && local != 0).then(|| Self::from_slot(local))
    }

    /// Returns the identity of the file's nested diff body.
    pub const fn diff_id(self) -> ElementId {
        ElementId::scoped(DIFF_SCOPE, self.slot)
    }

    /// Returns one stable identity for a host-owned action in the file header.
    pub fn header_action_id(self, action: usize) -> Option<ElementId> {
        let slot = u16::try_from(self.slot).ok()?;
        let action = u16::try_from(action).ok()?;
        let local = ((u32::from(slot) << 16) | u32::from(action)).checked_add(1)?;
        Some(ElementId::scoped(HEADER_ACTION_SCOPE, local))
    }

    /// Decodes the file identity and action index from a header action target.
    pub fn from_header_action_id(id: ElementId) -> Option<(Self, usize)> {
        let (scope, local) = split_element_id(id);
        if scope != HEADER_ACTION_SCOPE {
            return None;
        }
        let packed = local.checked_sub(1)?;
        let slot = packed >> 16;
        (slot != 0).then(|| (Self::from_slot(slot), packed as u16 as usize))
    }

    /// Returns the identity of an unchanged-region fold control.
    ///
    /// The legacy fold encoding reserves 16 bits for the item slot and region index. Keeping that
    /// encoding lets product input routing migrate without making existing IDs ambiguous.
    pub fn fold_id(self, region_index: usize) -> Option<ElementId> {
        let slot = u16::try_from(self.slot).ok()?;
        let region_index = u16::try_from(region_index).ok()?;
        let local = ((u32::from(slot) << 16) | u32::from(region_index)).checked_add(1)?;
        Some(ElementId::scoped(FOLD_SCOPE, local))
    }

    /// Decodes the file identity and unchanged-region index from a fold target.
    pub fn from_fold_id(id: ElementId) -> Option<(Self, usize)> {
        let (scope, local) = split_element_id(id);
        if scope != FOLD_SCOPE {
            return None;
        }
        let packed = local.checked_sub(1)?;
        let slot = packed >> 16;
        (slot != 0).then(|| (Self::from_slot(slot), packed as u16 as usize))
    }

    /// Returns the stable animation key for this file card's fold-driven height.
    pub const fn fold_animation_key(self) -> AnimationKey {
        AnimationKey::new(self.section_id(), AnimationProperty::Height)
    }
}

fn split_element_id(id: ElementId) -> (u32, u32) {
    let raw = id.into_raw();
    ((raw >> 32) as u32, raw as u32)
}
