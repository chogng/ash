use crate::ui::foundation::ElementId;

use super::SceneCheckpoint;
use super::UiScene;

/// Failure while replacing a retained scene fragment by its stable element identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneFragmentError {
    /// The requested fragment is not mounted in this scene.
    Missing(ElementId),
    /// A later scene segment was appended after the fragment, so replacing it would invalidate
    /// paint order or retained primitive indices.
    NotTerminal(ElementId),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct SceneFragment {
    pub(super) id: ElementId,
    pub(super) start: SceneCheckpoint,
    pub(super) end: SceneCheckpoint,
}

impl UiScene {
    /// Appends a top-level retained fragment identified by a stable element ID.
    ///
    /// A fragment is a terminal scene segment: callers should append it after the stable scene
    /// and must not append later scene work before calling [`UiScene::replace_fragment`]. Keeping
    /// the fragment terminal lets replacement preserve every preceding primitive and its paint
    /// order without rebuilding unrelated components.
    pub fn with_fragment<R>(&mut self, id: ElementId, draw: impl FnOnce(&mut Self) -> R) -> R {
        assert!(
            self.fragments.iter().all(|fragment| fragment.id != id),
            "a scene fragment ID may only be mounted once"
        );
        let start = self.checkpoint();
        let result = self.with_overlay(draw);
        let mut end = self.checkpoint();
        end.fragment_count = self.fragments.len() + 1;
        self.fragments.push(SceneFragment { id, start, end });
        result
    }

    /// Replaces one terminal retained fragment while keeping the stable scene prefix intact.
    ///
    /// The closure is run against the same top-level layer that held the old fragment. A missing
    /// fragment or a fragment followed by later scene work returns an error so the host can fall
    /// back to a normal presentation rebuild.
    pub fn replace_fragment(
        &mut self,
        id: ElementId,
        draw: impl FnOnce(&mut Self),
    ) -> Result<(), SceneFragmentError> {
        let Some(index) = self.fragments.iter().position(|fragment| fragment.id == id) else {
            return Err(SceneFragmentError::Missing(id));
        };
        let fragment = &self.fragments[index];
        if index + 1 != self.fragments.len() || self.checkpoint() != fragment.end {
            return Err(SceneFragmentError::NotTerminal(id));
        }
        let start = fragment.start.clone();
        self.fragments.truncate(index);
        self.restore(&start);
        self.with_fragment(id, draw);
        Ok(())
    }

    /// Removes one terminal retained fragment and restores the scene prefix that preceded it.
    ///
    /// Removing a fragment also removes its paint primitives and inspection nodes. The operation
    /// is intentionally restricted to the terminal fragment so it cannot silently change paint
    /// order or invalidate later retained scene boundaries.
    pub fn remove_fragment(&mut self, id: ElementId) -> Result<(), SceneFragmentError> {
        let Some(index) = self.fragments.iter().position(|fragment| fragment.id == id) else {
            return Err(SceneFragmentError::Missing(id));
        };
        let fragment = &self.fragments[index];
        if index + 1 != self.fragments.len() || self.checkpoint() != fragment.end {
            return Err(SceneFragmentError::NotTerminal(id));
        }
        let start = fragment.start.clone();
        self.restore(&start);
        Ok(())
    }
}
