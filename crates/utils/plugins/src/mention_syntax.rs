//! Plaintext sigils shared by plugin and Skill consumers.

/// Tool and Skill references use `$`.
pub const TOOL_MENTION_SIGIL: char = '$';
/// Plugin references share the `@` completion trigger with workspace-file references.
pub const PLUGIN_TEXT_MENTION_SIGIL: char = '@';
