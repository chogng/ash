use ash_keybinding::BindingSet;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;

/// Supplies host commands, builtin rules, conditions, and context matching.
///
/// Implementations keep command vocabulary in the host while allowing the keybinding engine and
/// user-config compiler to remain independent of Workbench state and transports.
pub trait KeybindingCatalog {
    type Command: Copy + Eq;
    type Condition: Clone + Eq;
    type Context;

    fn builtin_bindings(platform: HostPlatform) -> BindingSet<Self::Condition, Self::Command>;

    fn default_keybinding(command: Self::Command) -> Option<&'static KeySequence>;

    fn command_id(command: Self::Command) -> &'static str;

    fn command_from_id(id: &str) -> Option<Self::Command>;

    fn parse_condition(source: Option<&str>) -> Result<Self::Condition, String>;

    fn condition_matches(condition: &Self::Condition, context: &Self::Context) -> bool;
}
