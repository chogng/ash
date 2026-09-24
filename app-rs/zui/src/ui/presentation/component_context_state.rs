use super::ComponentContext;
use super::ComponentRuntimeError;
use super::ComponentSlot;
use super::ViewState;

impl ComponentContext<'_, '_> {
    /// Returns view-local state retained under the current stable component identity.
    pub fn local_state<T>(
        &mut self,
        slot: ComponentSlot,
        initialize: impl FnOnce() -> T,
    ) -> Result<ViewState<T>, ComponentRuntimeError>
    where
        T: Send + Sync + 'static,
    {
        let component = self
            .component_identity
            .ok_or(ComponentRuntimeError::MissingIdentity)?;
        let runtime = self
            .component_runtime
            .as_deref_mut()
            .ok_or(ComponentRuntimeError::RuntimeUnavailable)?;
        runtime.local_state(component, slot, initialize)
    }

    /// Invalidates the current component whenever an external view-state cell changes.
    pub fn observe_state<T>(
        &mut self,
        slot: ComponentSlot,
        state: &ViewState<T>,
    ) -> Result<(), ComponentRuntimeError>
    where
        T: Send + Sync + 'static,
    {
        let component = self
            .component_identity
            .ok_or(ComponentRuntimeError::MissingIdentity)?;
        let runtime = self
            .component_runtime
            .as_deref_mut()
            .ok_or(ComponentRuntimeError::RuntimeUnavailable)?;
        runtime.observe_state(component, slot, state);
        Ok(())
    }

    /// Creates one RAII resource on mount and retains it until this component unmounts.
    ///
    /// Returns `true` when `create` ran in this frame and `false` when the typed resource already
    /// existed in the selected slot.
    pub fn retain_resource<R>(
        &mut self,
        slot: ComponentSlot,
        create: impl FnOnce() -> R,
    ) -> Result<bool, ComponentRuntimeError>
    where
        R: 'static,
    {
        let component = self
            .component_identity
            .ok_or(ComponentRuntimeError::MissingIdentity)?;
        let runtime = self
            .component_runtime
            .as_deref_mut()
            .ok_or(ComponentRuntimeError::RuntimeUnavailable)?;
        runtime.retain_resource(component, slot, create)
    }
}
