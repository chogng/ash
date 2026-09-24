use std::ops::BitOr;
use std::ops::BitOrAssign;

use super::Display;
use super::DisplayId;
use super::DisplaySnapshot;

/// Display properties that changed while a connected display retained its identity.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DisplayMetricChanges(u16);

impl DisplayMetricChanges {
    /// The global physical bounds changed.
    pub const BOUNDS: Self = Self(1 << 0);
    /// The usable work area changed.
    pub const WORK_AREA: Self = Self(1 << 1);
    /// The logical-to-physical pixel scale changed.
    pub const SCALE_FACTOR: Self = Self(1 << 2);
    /// The active refresh rate changed.
    pub const REFRESH_RATE: Self = Self(1 << 3);
    /// The advertised fullscreen mode set changed.
    pub const VIDEO_MODES: Self = Self(1 << 4);
    /// The user-facing display name changed.
    pub const NAME: Self = Self(1 << 5);
    /// The primary-display designation changed.
    pub const PRIMARY: Self = Self(1 << 6);
    /// The clockwise display orientation changed.
    pub const ROTATION: Self = Self(1 << 7);
    /// The platform's built-in/external classification changed.
    pub const INTERNAL: Self = Self(1 << 8);

    /// Returns the stable bit representation for persistence or adapter boundaries.
    pub const fn bits(self) -> u16 {
        self.0
    }

    /// Returns whether no display property changed.
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Returns whether all flags in `other` are present.
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl BitOr for DisplayMetricChanges {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for DisplayMetricChanges {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

/// One deterministic difference between two connected-display snapshots.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum DisplayEvent {
    /// A display identity appeared in the current topology.
    Added(Display),
    /// A display identity disappeared from the current topology.
    Removed(Display),
    /// Properties changed while a display retained its identity.
    MetricsChanged {
        display: Display,
        changed: DisplayMetricChanges,
    },
}

impl DisplayEvent {
    /// Returns the current display for additions/changes or the last snapshot for removals.
    pub const fn display(&self) -> &Display {
        match self {
            Self::Added(display) | Self::Removed(display) => display,
            Self::MetricsChanged { display, .. } => display,
        }
    }

    /// Returns changed property flags for a metrics event.
    pub const fn changed(&self) -> Option<DisplayMetricChanges> {
        match self {
            Self::MetricsChanged { changed, .. } => Some(*changed),
            Self::Added(_) | Self::Removed(_) => None,
        }
    }
}

impl DisplaySnapshot {
    /// Computes identity and property changes from `previous` to this snapshot.
    ///
    /// Events are ordered as removals, additions, then retained-display changes; identities are
    /// lexicographically ordered within each group so custom and native sources are deterministic.
    pub fn changes_since(&self, previous: &Self) -> Vec<DisplayEvent> {
        let removed = sorted_unique_ids(previous)
            .into_iter()
            .filter(|id| self.display(id).is_none())
            .filter_map(|id| previous.display(&id).cloned().map(DisplayEvent::Removed));
        let added = sorted_unique_ids(self)
            .into_iter()
            .filter(|id| previous.display(id).is_none())
            .filter_map(|id| self.display(&id).cloned().map(DisplayEvent::Added));
        let changed = sorted_unique_ids(self).into_iter().filter_map(|id| {
            let current = self.display(&id)?;
            let old = previous.display(&id)?;
            let changes =
                metric_changes(current, old) | primary_change(self, previous, current.id());
            (!changes.is_empty()).then(|| DisplayEvent::MetricsChanged {
                display: current.clone(),
                changed: changes,
            })
        });
        removed.chain(added).chain(changed).collect()
    }
}

fn sorted_unique_ids(snapshot: &DisplaySnapshot) -> Vec<DisplayId> {
    let mut ids = snapshot
        .displays
        .iter()
        .map(|display| display.id().clone())
        .collect::<Vec<_>>();
    ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    ids.dedup();
    ids
}

fn metric_changes(current: &Display, previous: &Display) -> DisplayMetricChanges {
    let mut changes = DisplayMetricChanges::default();
    if current.bounds != previous.bounds {
        changes |= DisplayMetricChanges::BOUNDS;
    }
    if current.work_area != previous.work_area {
        changes |= DisplayMetricChanges::WORK_AREA;
    }
    if current.rotation != previous.rotation {
        changes |= DisplayMetricChanges::ROTATION;
    }
    if current.internal != previous.internal {
        changes |= DisplayMetricChanges::INTERNAL;
    }
    if current.scale_factor != previous.scale_factor {
        changes |= DisplayMetricChanges::SCALE_FACTOR;
    }
    if current.refresh_rate_millihertz != previous.refresh_rate_millihertz {
        changes |= DisplayMetricChanges::REFRESH_RATE;
    }
    if current.video_modes != previous.video_modes {
        changes |= DisplayMetricChanges::VIDEO_MODES;
    }
    if current.name != previous.name {
        changes |= DisplayMetricChanges::NAME;
    }
    changes
}

fn primary_change(
    current: &DisplaySnapshot,
    previous: &DisplaySnapshot,
    display: &DisplayId,
) -> DisplayMetricChanges {
    let is_primary = current.primary.as_ref() == Some(display);
    let was_primary = previous.primary.as_ref() == Some(display);
    if is_primary != was_primary {
        DisplayMetricChanges::PRIMARY
    } else {
        DisplayMetricChanges::default()
    }
}
