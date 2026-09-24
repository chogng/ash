use std::sync::OnceLock;

use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_keybinding::BindingPriority;
use ash_keybinding::BindingSet;
use ash_keybinding::BindingSource;
use ash_keybinding::Chord;
use ash_keybinding::ContextExpression;
use ash_keybinding::ContextValue;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::ShortcutModifiers;
use ash_keybindings_host::KeybindingCatalog;
use ash_keybindings_host::KeybindingResolution;
use ash_keybindings_host::Keybindings;
use ash_keybindings_host::UserBinding;
#[cfg(test)]
use ash_keybindings_host::UserBindingTarget;
use serde_json::Value;

use ash_commands::AppCommandId;

pub(crate) type WorkbenchKeybindings = Keybindings<WorkbenchKeybindingCatalog>;
pub(crate) type WorkbenchKeybindingResolution = KeybindingResolution<AppCommandId>;
pub(crate) type WorkbenchUserBinding = UserBinding<WorkbenchKeybindingCatalog>;
#[cfg(test)]
pub(crate) type WorkbenchUserBindingTarget = UserBindingTarget<AppCommandId>;

/// Application context facts projected into the generic keybinding catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorkbenchKeybindingContext {
    facts: WorkbenchKeybindingFacts,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorkbenchKeybindingFacts {
    pub(crate) direct_terminal: bool,
    pub(crate) terminal_surface_visible: bool,
    pub(crate) tab_container_visible: bool,
    pub(crate) inspector_visible: bool,
    pub(crate) file_search_visible: bool,
    pub(crate) composer_route: &'static str,
}

impl WorkbenchKeybindingContext {
    #[cfg(test)]
    pub(crate) const fn text_input() -> Self {
        Self {
            facts: WorkbenchKeybindingFacts {
                direct_terminal: false,
                terminal_surface_visible: false,
                tab_container_visible: false,
                inspector_visible: false,
                file_search_visible: false,
                composer_route: "agent",
            },
        }
    }

    #[cfg(test)]
    pub(crate) const fn direct_terminal() -> Self {
        Self {
            facts: WorkbenchKeybindingFacts {
                direct_terminal: true,
                terminal_surface_visible: true,
                tab_container_visible: false,
                inspector_visible: false,
                file_search_visible: false,
                composer_route: "agent",
            },
        }
    }

    pub(crate) const fn from_facts(facts: WorkbenchKeybindingFacts) -> Self {
        Self { facts }
    }

    pub(super) fn supports_key(key: &str) -> bool {
        matches!(
            key,
            "textInputFocus"
                | "terminalFocus"
                | "agentSurfaceVisible"
                | "terminalSurfaceVisible"
                | "tabContainerVisible"
                | "inspectorVisible"
                | "fileSearchVisible"
                | "composerRoute"
        )
    }

    fn value(self, key: &str) -> Option<ContextValue> {
        match key {
            "textInputFocus" => Some(ContextValue::Boolean(!self.facts.direct_terminal)),
            "terminalFocus" => Some(ContextValue::Boolean(self.facts.direct_terminal)),
            "agentSurfaceVisible" => {
                Some(ContextValue::Boolean(!self.facts.terminal_surface_visible))
            }
            "terminalSurfaceVisible" => {
                Some(ContextValue::Boolean(self.facts.terminal_surface_visible))
            }
            "tabContainerVisible" => Some(ContextValue::Boolean(self.facts.tab_container_visible)),
            "inspectorVisible" => Some(ContextValue::Boolean(self.facts.inspector_visible)),
            "fileSearchVisible" => Some(ContextValue::Boolean(self.facts.file_search_visible)),
            "composerRoute" => Some(ContextValue::String(self.facts.composer_route.to_owned())),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkbenchBindingCondition {
    Always,
    TextInput,
    DirectTerminal,
    Expression(ContextExpression),
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct WorkbenchKeybindingCatalog;

impl KeybindingCatalog for WorkbenchKeybindingCatalog {
    type Command = AppCommandId;
    type Condition = WorkbenchBindingCondition;
    type Context = WorkbenchKeybindingContext;

    fn builtin_bindings(platform: HostPlatform) -> BindingSet<Self::Condition, Self::Command> {
        builtin_bindings(platform)
    }

    fn default_keybinding(command: Self::Command) -> Option<&'static KeySequence> {
        default_keybinding(command)
    }

    fn command_id(command: Self::Command) -> &'static str {
        command.id()
    }

    fn command_from_id(id: &str) -> Option<Self::Command> {
        AppCommandId::bindable_from_id(id)
    }

    fn parse_condition(source: Option<&str>) -> Result<Self::Condition, String> {
        let Some(source) = source else {
            return Ok(WorkbenchBindingCondition::Always);
        };
        let expression = ContextExpression::parse(source).map_err(|error| error.to_string())?;
        if let Some(key) = expression
            .referenced_keys()
            .into_iter()
            .find(|key| !WorkbenchKeybindingContext::supports_key(key))
        {
            return Err(format!("unknown context key `{key}`"));
        }
        Ok(WorkbenchBindingCondition::Expression(expression))
    }

    fn condition_matches(condition: &Self::Condition, context: &Self::Context) -> bool {
        condition_matches(condition, context)
    }
}

fn condition_matches(
    condition: &WorkbenchBindingCondition,
    context: &WorkbenchKeybindingContext,
) -> bool {
    match condition {
        WorkbenchBindingCondition::Always => true,
        WorkbenchBindingCondition::TextInput => !context.facts.direct_terminal,
        WorkbenchBindingCondition::DirectTerminal => context.facts.direct_terminal,
        WorkbenchBindingCondition::Expression(expression) => {
            expression.evaluate(|key| context.value(key))
        }
    }
}

fn default_keybinding(command: AppCommandId) -> Option<&'static KeySequence> {
    static TOGGLE_TERMINAL: OnceLock<KeySequence> = OnceLock::new();
    static COPY: OnceLock<KeySequence> = OnceLock::new();
    static PASTE: OnceLock<KeySequence> = OnceLock::new();
    static SAVE: OnceLock<KeySequence> = OnceLock::new();
    static SPLIT_HORIZONTAL: OnceLock<KeySequence> = OnceLock::new();
    static SPLIT_VERTICAL: OnceLock<KeySequence> = OnceLock::new();
    match command {
        AppCommandId::ToggleTerminalSurface => Some(TOGGLE_TERMINAL.get_or_init(|| {
            KeySequence::single(
                Chord::logical("j", ShortcutModifiers::primary()).expect("builtin key"),
            )
        })),
        AppCommandId::OpenKeyboardShortcuts => Some(static_keyboard_shortcuts_binding()),
        AppCommandId::Copy => Some(COPY.get_or_init(|| {
            KeySequence::single(
                Chord::logical("c", ShortcutModifiers::primary()).expect("builtin key"),
            )
        })),
        AppCommandId::Paste => Some(PASTE.get_or_init(|| {
            KeySequence::single(
                Chord::logical("v", ShortcutModifiers::primary()).expect("builtin key"),
            )
        })),
        AppCommandId::Save => Some(SAVE.get_or_init(|| {
            KeySequence::single(
                Chord::logical("s", ShortcutModifiers::primary()).expect("builtin key"),
            )
        })),
        AppCommandId::SplitTerminalHorizontal => Some(SPLIT_HORIZONTAL.get_or_init(|| {
            KeySequence::single(
                Chord::logical("\\", ShortcutModifiers::primary()).expect("builtin key"),
            )
        })),
        AppCommandId::SplitTerminalVertical => Some(SPLIT_VERTICAL.get_or_init(|| {
            KeySequence::single(
                Chord::logical("\\", ShortcutModifiers::primary().with_shift())
                    .expect("builtin key"),
            )
        })),
        AppCommandId::StartMemoryDiagnostics
        | AppCommandId::ReadMemoryDiagnostics
        | AppCommandId::StopMemoryDiagnostics
        | AppCommandId::ExportMemoryDiagnostics
        | AppCommandId::ManageRemoteTunnels
        | AppCommandId::ToggleTabContainer
        | AppCommandId::ToggleFilesPane
        | AppCommandId::AddSession
        | AppCommandId::ShowAgentChanges
        | AppCommandId::ShowAgentFiles
        | AppCommandId::RefreshAgentFiles
        | AppCommandId::ToggleAgentFileSearch
        | AppCommandId::PinSession
        | AppCommandId::CloseSession
        | AppCommandId::RenameSession
        | AppCommandId::GroupSession
        | AppCommandId::ForkSession
        | AppCommandId::PickExecutionLocation
        | AppCommandId::PickWorkingDirectory
        | AppCommandId::PickGitBranch
        | AppCommandId::ShowGitDiff
        | AppCommandId::FocusNextPane
        | AppCommandId::FocusPreviousPane
        | AppCommandId::ManageMemories
        | AppCommandId::ClosePane => None,
    }
}

fn static_keyboard_shortcuts_binding() -> &'static KeySequence {
    static KEYBOARD_SHORTCUTS: OnceLock<KeySequence> = OnceLock::new();
    KEYBOARD_SHORTCUTS.get_or_init(|| {
        KeySequence::single(Chord::logical(",", ShortcutModifiers::primary()).expect("builtin key"))
    })
}

fn builtin_bindings(platform: HostPlatform) -> BindingSet<WorkbenchBindingCondition, AppCommandId> {
    let mut bindings = BindingSet::default();
    register(
        &mut bindings,
        "j",
        ShortcutModifiers::primary(),
        AppCommandId::ToggleTerminalSurface,
        WorkbenchBindingCondition::Always,
    );
    register(
        &mut bindings,
        ",",
        ShortcutModifiers::primary(),
        AppCommandId::OpenKeyboardShortcuts,
        WorkbenchBindingCondition::Always,
    );
    register_text_input_clipboard(&mut bindings);
    register(
        &mut bindings,
        "s",
        ShortcutModifiers::primary(),
        AppCommandId::Save,
        WorkbenchBindingCondition::Always,
    );
    register(
        &mut bindings,
        "\\",
        ShortcutModifiers::primary(),
        AppCommandId::SplitTerminalHorizontal,
        WorkbenchBindingCondition::Always,
    );
    register(
        &mut bindings,
        "\\",
        ShortcutModifiers::primary().with_shift(),
        AppCommandId::SplitTerminalVertical,
        WorkbenchBindingCondition::Always,
    );
    register_direct_terminal_clipboard(&mut bindings, platform);
    bindings
}

fn register_text_input_clipboard(
    bindings: &mut BindingSet<WorkbenchBindingCondition, AppCommandId>,
) {
    register(
        bindings,
        "c",
        ShortcutModifiers::primary(),
        AppCommandId::Copy,
        WorkbenchBindingCondition::TextInput,
    );
    register(
        bindings,
        "v",
        ShortcutModifiers::primary(),
        AppCommandId::Paste,
        WorkbenchBindingCondition::TextInput,
    );
    register(
        bindings,
        "c",
        ShortcutModifiers::primary().with_shift(),
        AppCommandId::Copy,
        WorkbenchBindingCondition::TextInput,
    );
    register(
        bindings,
        "v",
        ShortcutModifiers::primary().with_shift(),
        AppCommandId::Paste,
        WorkbenchBindingCondition::TextInput,
    );
}

fn register_direct_terminal_clipboard(
    bindings: &mut BindingSet<WorkbenchBindingCondition, AppCommandId>,
    platform: HostPlatform,
) {
    let modifiers = if platform == HostPlatform::MacOs {
        ShortcutModifiers::primary()
    } else {
        ShortcutModifiers::control().with_shift()
    };
    register(
        bindings,
        "c",
        modifiers,
        AppCommandId::Copy,
        WorkbenchBindingCondition::DirectTerminal,
    );
    register(
        bindings,
        "v",
        modifiers,
        AppCommandId::Paste,
        WorkbenchBindingCondition::DirectTerminal,
    );
}

fn register(
    bindings: &mut BindingSet<WorkbenchBindingCondition, AppCommandId>,
    key: &str,
    modifiers: ShortcutModifiers,
    command: AppCommandId,
    condition: WorkbenchBindingCondition,
) {
    let chord = Chord::logical(key, modifiers).expect("builtin shortcut key must be valid");
    bindings.register_command(
        KeySequence::single(chord),
        command,
        condition,
        BindingSource::Builtin,
        BindingPriority::NORMAL,
    );
}

pub(crate) fn compile_user_bindings(
    value: Option<&Value>,
    platform: HostPlatform,
) -> Result<Vec<WorkbenchUserBinding>, ash_keybindings_host::KeybindingsConfigError> {
    ash_keybindings_host::compile_user_bindings::<WorkbenchKeybindingCatalog>(value, platform)
}

pub(crate) fn binding_diagnostics(
    rules: &[WorkbenchUserBinding],
    platform: HostPlatform,
) -> Vec<String> {
    ash_keybindings_host::binding_diagnostics::<WorkbenchKeybindingCatalog>(rules, platform)
}

pub(crate) fn edited_gui_config(
    mut section: FrontendConfigDto,
    command: AppCommandId,
    keybinding: &KeySequence,
    platform: HostPlatform,
) -> Result<FrontendConfigDto, String> {
    let bindings = ash_keybindings_host::edited_user_bindings::<WorkbenchKeybindingCatalog>(
        section.0.get("keybindings"),
        command,
        keybinding,
        platform,
    )?;
    section.0.insert("keybindings".into(), bindings);
    Ok(section)
}

#[cfg(test)]
#[path = "keybindings_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "keybindings_config_tests.rs"]
mod config_tests;
