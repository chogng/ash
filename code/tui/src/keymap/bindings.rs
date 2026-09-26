use super::AppKeymap;
use super::AppUserBinding;
use super::chords::validate_specs;
use super::chords::validate_user_bindings;
use super::input::normalized_key;
use crate::widgets::key_hint::KeyHints;
use ash_keybinding::BindingPriority;
use ash_keybinding::BindingSet;
use ash_keybinding::BindingSource;
use ash_keybinding::ContextExpression;
use ash_keybinding::ContextValue;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::KeybindingResolver;
use ash_keybinding::ResolveResult;
use ash_keybinding::UserBindingTarget;
use ash_keybinding::compile_user_bindings;
use ash_keybinding::parse_key_sequence;
use ash_keybinding::serialize_key_sequence;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::sync::LazyLock;

/// Cross-component actions owned by the Ash Code TUI application.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppKeymapAction {
    CycleApprovalMode,
    ScreenEscape,
    OpenRewind,
    ReadClipboardImage,
    InterruptOrQuit,
    CopyLastResponse,
    Suspend,
}

impl AppKeymapAction {
    pub(crate) const fn command_id(self) -> Option<&'static str> {
        match self {
            Self::CycleApprovalMode => Some("ashCode.action.cycleApprovalMode"),
            Self::ScreenEscape => None,
            Self::OpenRewind => Some("ashCode.action.openRewind"),
            Self::ReadClipboardImage => Some("ashCode.action.attachClipboardImage"),
            Self::InterruptOrQuit => Some("ashCode.action.interruptOrQuit"),
            Self::CopyLastResponse => Some("ashCode.action.copyLastResponse"),
            Self::Suspend => Some("ashCode.action.suspend"),
        }
    }

    fn from_command_id(id: &str) -> Option<Self> {
        Self::USER_BINDABLE
            .into_iter()
            .find(|action| action.command_id() == Some(id))
    }

    const USER_BINDABLE: [Self; 6] = [
        Self::CycleApprovalMode,
        Self::OpenRewind,
        Self::ReadClipboardImage,
        Self::InterruptOrQuit,
        Self::CopyLastResponse,
        Self::Suspend,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::CycleApprovalMode => "Cycle approval mode",
            Self::ScreenEscape => "Rewind escape gesture",
            Self::OpenRewind => "Open rewind checkpoints",
            Self::ReadClipboardImage => "Attach clipboard image",
            Self::InterruptOrQuit => "Interrupt or quit",
            Self::CopyLastResponse => "Copy last response",
            Self::Suspend => "Suspend Ash",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeymapUserBindingSnapshot {
    pub(crate) key: String,
    pub(crate) when: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeymapActionSnapshot {
    pub(crate) command_id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) default_bindings: Vec<String>,
    pub(crate) user_bindings: Vec<KeymapUserBindingSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AppKeymapCondition {
    Always,
    AcceptsInput,
    EmptyChatInput,
    PressWithEmptyInput,
    PressWithInputWithoutSelection,
    Expression(ContextExpression),
}

/// State needed to decide an application binding without exposing component internals.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AppKeymapContext {
    pub(crate) accepts_input: bool,
    pub(crate) has_selection: bool,
    pub(crate) chat_input_empty: bool,
    pub(crate) is_press: bool,
}

impl AppKeymapContext {
    fn supports_key(key: &str) -> bool {
        matches!(
            key,
            "inputFocus" | "chatInputEmpty" | "selectionVisible" | "keyEventPress"
        )
    }

    fn value(self, key: &str) -> Option<ContextValue> {
        match key {
            "inputFocus" => Some(ContextValue::Boolean(self.accepts_input)),
            "chatInputEmpty" => Some(ContextValue::Boolean(self.chat_input_empty)),
            "selectionVisible" => Some(ContextValue::Boolean(self.has_selection)),
            "keyEventPress" => Some(ContextValue::Boolean(self.is_press)),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AppKeybindingSpec {
    pub(super) keybinding: &'static str,
    pub(super) action: AppKeymapAction,
    pub(super) condition: AppKeymapCondition,
}

const APP_KEYBINDINGS: &[AppKeybindingSpec] = &[
    AppKeybindingSpec {
        keybinding: "shift+tab",
        action: AppKeymapAction::CycleApprovalMode,
        condition: AppKeymapCondition::PressWithInputWithoutSelection,
    },
    AppKeybindingSpec {
        keybinding: "escape",
        action: AppKeymapAction::ScreenEscape,
        condition: AppKeymapCondition::PressWithEmptyInput,
    },
    AppKeybindingSpec {
        keybinding: "ctrl+v",
        action: AppKeymapAction::ReadClipboardImage,
        condition: AppKeymapCondition::AcceptsInput,
    },
    AppKeybindingSpec {
        keybinding: "ctrl+c",
        action: AppKeymapAction::InterruptOrQuit,
        condition: AppKeymapCondition::Always,
    },
    AppKeybindingSpec {
        keybinding: "ctrl+d",
        action: AppKeymapAction::InterruptOrQuit,
        condition: AppKeymapCondition::EmptyChatInput,
    },
    AppKeybindingSpec {
        keybinding: "ctrl+o",
        action: AppKeymapAction::CopyLastResponse,
        condition: AppKeymapCondition::Always,
    },
    AppKeybindingSpec {
        keybinding: "ctrl+z",
        action: AppKeymapAction::Suspend,
        condition: AppKeymapCondition::Always,
    },
];

impl Default for AppKeymap {
    fn default() -> Self {
        Self::from_specs(APP_KEYBINDINGS)
    }
}

impl AppKeymap {
    pub(super) fn from_specs(specs: &[AppKeybindingSpec]) -> Self {
        let parsed = specs
            .iter()
            .map(|binding| {
                (
                    binding.clone(),
                    parse_key_sequence(binding.keybinding)
                        .expect("fixed TUI binding must use portable keybinding syntax"),
                )
            })
            .collect::<Vec<_>>();
        validate_specs(&parsed);
        let mut single_bindings = BindingSet::default();
        let mut chord_bindings = BindingSet::default();
        for (binding, keybinding) in parsed {
            register_command(
                &mut single_bindings,
                &mut chord_bindings,
                keybinding,
                binding.action,
                binding.condition,
                BindingSource::Builtin,
            );
        }
        Self {
            single_bindings,
            chord_bindings,
            platform: HostPlatform::current(),
            pending: None,
            user_bindings: Vec::new(),
        }
    }

    pub(crate) fn replace_user_bindings(
        &mut self,
        rules: Vec<AppUserBinding>,
    ) -> Result<(), String> {
        let parsed_builtins = APP_KEYBINDINGS
            .iter()
            .map(|binding| {
                parse_key_sequence(binding.keybinding)
                    .map(|keybinding| (binding.clone(), keybinding))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_user_bindings(&rules, &parsed_builtins)?;

        let mut single_bindings = BindingSet::default();
        let mut chord_bindings = BindingSet::default();
        for (binding, keybinding) in parsed_builtins {
            register_command(
                &mut single_bindings,
                &mut chord_bindings,
                keybinding,
                binding.action,
                binding.condition,
                BindingSource::Builtin,
            );
        }
        for rule in &rules {
            let bindings =
                bindings_for_sequence(&mut single_bindings, &mut chord_bindings, &rule.keybinding);
            match rule.target {
                UserBindingTarget::Command(action) => bindings.register_command(
                    rule.keybinding.clone(),
                    action,
                    rule.when.clone(),
                    BindingSource::User,
                    BindingPriority::NORMAL,
                ),
                UserBindingTarget::Block => bindings.register_blocker(
                    rule.keybinding.clone(),
                    rule.when.clone(),
                    BindingSource::User,
                    BindingPriority::NORMAL,
                ),
            }
        }
        self.single_bindings = single_bindings;
        self.chord_bindings = chord_bindings;
        self.user_bindings = rules;
        self.cancel_chord();
        Ok(())
    }

    pub(crate) fn setup_actions(&self) -> Vec<KeymapActionSnapshot> {
        AppKeymapAction::USER_BINDABLE
            .into_iter()
            .map(|action| KeymapActionSnapshot {
                command_id: action
                    .command_id()
                    .expect("a user-bindable TUI action has a command ID"),
                label: action.label(),
                default_bindings: APP_KEYBINDINGS
                    .iter()
                    .filter(|binding| binding.action == action)
                    .map(|binding| {
                        parse_key_sequence(binding.keybinding)
                            .map(|key| serialize_key_sequence(&key))
                            .expect("fixed TUI binding must use portable keybinding syntax")
                    })
                    .collect(),
                user_bindings: self
                    .user_bindings
                    .iter()
                    .filter_map(|binding| match binding.target {
                        UserBindingTarget::Command(candidate) if candidate == action => {
                            Some(KeymapUserBindingSnapshot {
                                key: serialize_key_sequence(&binding.keybinding),
                                when: binding.when_source.clone(),
                            })
                        }
                        UserBindingTarget::Command(_) | UserBindingTarget::Block => None,
                    })
                    .collect(),
            })
            .collect()
    }

    pub(crate) fn action_hint(
        &self,
        action: AppKeymapAction,
        context: AppKeymapContext,
    ) -> Option<String> {
        let defaults = APP_KEYBINDINGS
            .iter()
            .filter(|spec| spec.action == action)
            .map(|spec| parse_key_sequence(spec.keybinding).expect("valid built-in shortcut"));
        let users = self
            .user_bindings
            .iter()
            .rev()
            .filter(|rule| rule.target == UserBindingTarget::Command(action))
            .map(|rule| rule.keybinding.clone());
        users.chain(defaults).find_map(|sequence| {
            let events = sequence
                .chords()
                .iter()
                .map(|chord| {
                    let ash_keybinding::KeyIdentity::Logical(key) = chord.key() else {
                        return None;
                    };
                    let modifiers = chord.modifiers();
                    let mut actual = ash_keybinding::Modifiers::none();
                    if modifiers.uses_control() {
                        actual = actual.with_control();
                    }
                    if modifiers.uses_shift() {
                        actual = actual.with_shift();
                    }
                    if modifiers.uses_alt() {
                        actual = actual.with_alt();
                    }
                    if modifiers.uses_meta() {
                        actual = actual.with_meta();
                    }
                    if modifiers.uses_primary() {
                        actual = if self.platform == HostPlatform::MacOs {
                            actual.with_meta()
                        } else {
                            actual.with_control()
                        };
                    }
                    Some(ash_keybinding::KeyStroke::new(key.clone(), None, actual))
                })
                .collect::<Option<Vec<_>>>()?;
            let bindings = if events.len() == 1 {
                &self.single_bindings
            } else {
                &self.chord_bindings
            };
            let resolver = KeybindingResolver::new(bindings, self.platform);
            if events.len() > 1 {
                for end in 1..events.len() {
                    if !matches!(
                        resolver.resolve(&context, &events[..end], condition_matches),
                        ResolveResult::PendingChord { .. }
                    ) {
                        return None;
                    }
                }
            }
            match resolver.resolve(&context, &events, condition_matches) {
                ResolveResult::Command { command, .. } if command == action => {
                    Some(serialize_key_sequence(&sequence))
                }
                _ => None,
            }
        })
    }

    pub(crate) fn resolve_single(
        &self,
        key: &KeyEvent,
        context: AppKeymapContext,
    ) -> Option<AppKeymapAction> {
        let event = normalized_key(key)?.stroke;
        let resolver = KeybindingResolver::new(&self.single_bindings, self.platform);
        match resolver.resolve(&context, &[event], condition_matches) {
            ResolveResult::Command { command, .. } => Some(command),
            ResolveResult::NoMatch
            | ResolveResult::PendingChord { .. }
            | ResolveResult::Blocked { .. } => None,
        }
    }
}

pub(crate) fn compile_app_user_bindings(
    value: &serde_json::Value,
    platform: HostPlatform,
) -> Result<Vec<AppUserBinding>, String> {
    compile_user_bindings(
        value,
        platform,
        AppKeymapAction::from_command_id,
        parse_user_condition,
    )
    .map_err(|error| error.to_string())
}

fn parse_user_condition(source: Option<&str>) -> Result<AppKeymapCondition, String> {
    let Some(source) = source else {
        return Ok(AppKeymapCondition::Always);
    };
    let expression = ContextExpression::parse(source).map_err(|error| error.to_string())?;
    if let Some(key) = expression
        .referenced_keys()
        .into_iter()
        .find(|key| !AppKeymapContext::supports_key(key))
    {
        return Err(format!("unknown context key `{key}`"));
    }
    Ok(AppKeymapCondition::Expression(expression))
}

fn register_command(
    single_bindings: &mut BindingSet<AppKeymapCondition, AppKeymapAction>,
    chord_bindings: &mut BindingSet<AppKeymapCondition, AppKeymapAction>,
    keybinding: KeySequence,
    action: AppKeymapAction,
    condition: AppKeymapCondition,
    source: BindingSource,
) {
    let bindings = bindings_for_sequence(single_bindings, chord_bindings, &keybinding);
    bindings.register_command(
        keybinding,
        action,
        condition,
        source,
        BindingPriority::NORMAL,
    );
}

fn bindings_for_sequence<'a>(
    single_bindings: &'a mut BindingSet<AppKeymapCondition, AppKeymapAction>,
    chord_bindings: &'a mut BindingSet<AppKeymapCondition, AppKeymapAction>,
    keybinding: &KeySequence,
) -> &'a mut BindingSet<AppKeymapCondition, AppKeymapAction> {
    if keybinding.chords().len() == 1 {
        single_bindings
    } else {
        chord_bindings
    }
}

pub(super) fn condition_matches(
    condition: &AppKeymapCondition,
    context: &AppKeymapContext,
) -> bool {
    match condition {
        AppKeymapCondition::Always => true,
        AppKeymapCondition::AcceptsInput => context.accepts_input,
        AppKeymapCondition::EmptyChatInput => context.chat_input_empty,
        AppKeymapCondition::PressWithEmptyInput => {
            context.is_press && context.accepts_input && context.chat_input_empty
        }
        AppKeymapCondition::PressWithInputWithoutSelection => {
            context.is_press && context.accepts_input && !context.has_selection
        }
        AppKeymapCondition::Expression(expression) => expression.evaluate(|key| context.value(key)),
    }
}

/// One focused action, including aliases and the text used by its hint.
/// Callers own focus and press/repeat policy; matching never consumes an event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Keybinding {
    bindings: &'static [(KeyModifiers, KeyCode)],
    shown: usize,
    action: &'static str,
}

impl Keybinding {
    const fn new(bindings: &'static [(KeyModifiers, KeyCode)], action: &'static str) -> Self {
        assert!(
            !bindings.is_empty(),
            "a keybinding requires at least one key"
        );
        Self {
            bindings,
            shown: bindings.len(),
            action,
        }
    }

    const fn primary(mut self) -> Self {
        self.shown = 1;
        self
    }

    pub(crate) fn matches(self, key: KeyEvent) -> bool {
        let (modifiers, code) = if key.code == KeyCode::BackTab {
            (key.modifiers | KeyModifiers::SHIFT, KeyCode::Tab)
        } else {
            (key.modifiers, key.code)
        };
        self.bindings.contains(&(modifiers, code))
    }

    pub(crate) fn keys(self) -> String {
        let bindings = &self.bindings[..self.shown];
        let shared_modifiers = bindings
            .iter()
            .all(|(modifiers, _)| *modifiers == bindings[0].0);
        let keys = bindings
            .iter()
            .map(|(modifiers, code)| {
                let code = match code {
                    KeyCode::Char(c) if !modifiers.is_empty() => {
                        KeyCode::Char(c.to_ascii_uppercase())
                    }
                    other => *other,
                };
                if shared_modifiers {
                    key_name(code)
                } else {
                    format!("{}{}", modifier_name(*modifiers), key_name(code))
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        if shared_modifiers {
            format!("{}{keys}", modifier_name(bindings[0].0))
        } else {
            keys
        }
    }

    pub(crate) const fn action(self) -> &'static str {
        self.action
    }
}

fn modifier_name(modifiers: KeyModifiers) -> String {
    let mut text = String::new();
    for (modifier, label) in [
        (KeyModifiers::CONTROL, "Ctrl+"),
        (KeyModifiers::ALT, "Alt+"),
        (KeyModifiers::SHIFT, "Shift+"),
        (KeyModifiers::SUPER, "Super+"),
        (KeyModifiers::META, "Meta+"),
        (KeyModifiers::HYPER, "Hyper+"),
    ] {
        if modifiers.contains(modifier) {
            text.push_str(label);
        }
    }
    text
}

fn key_name(code: KeyCode) -> String {
    match code {
        KeyCode::Enter => "Enter".into(),
        KeyCode::Esc => "Esc".into(),
        KeyCode::Tab => "Tab".into(),
        KeyCode::BackTab => "Shift+Tab".into(),
        KeyCode::Char(' ') => "Space".into(),
        KeyCode::Char(character) => character.to_string(),
        KeyCode::Up => "↑".into(),
        KeyCode::Down => "↓".into(),
        KeyCode::Left => "←".into(),
        KeyCode::Right => "→".into(),
        KeyCode::Home => "Home".into(),
        KeyCode::End => "End".into(),
        KeyCode::PageUp => "PageUp".into(),
        KeyCode::PageDown => "PageDown".into(),
        KeyCode::Backspace => "Backspace".into(),
        KeyCode::Delete => "Delete".into(),
        KeyCode::Insert => "Insert".into(),
        KeyCode::F(number) => format!("F{number}"),
        _ => unreachable!("panel bindings must use displayable terminal keys"),
    }
}

const NONE: KeyModifiers = KeyModifiers::NONE;
const CTRL: KeyModifiers = KeyModifiers::CONTROL;
const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
const ENTER: &[(KeyModifiers, KeyCode)] = &[(NONE, KeyCode::Enter)];
const SPACE: &[(KeyModifiers, KeyCode)] = &[(NONE, KeyCode::Char(' '))];
const ENTER_SPACE: &[(KeyModifiers, KeyCode)] =
    &[(NONE, KeyCode::Enter), (NONE, KeyCode::Char(' '))];
const ESC: &[(KeyModifiers, KeyCode)] = &[(NONE, KeyCode::Esc)];
const DISMISS: &[(KeyModifiers, KeyCode)] = &[(NONE, KeyCode::Esc), (CTRL, KeyCode::Char('c'))];

// Shared focus and navigation. Navigation remains available without a HitBar entry.
pub(crate) const ACCEPT: Keybinding = Keybinding::new(ENTER, "confirm");
pub(crate) const CLOSE: Keybinding = Keybinding::new(ESC, "close");
pub(crate) const DISMISS_LIST: Keybinding = Keybinding::new(DISMISS, "close").primary();
pub(crate) const RETURN_LIST: Keybinding = Keybinding::new(DISMISS, "return").primary();
pub(crate) const CANCEL: Keybinding = Keybinding::new(
    &[
        (NONE, KeyCode::Esc),
        (CTRL, KeyCode::Char('c')),
        (CTRL, KeyCode::Char('C')),
    ],
    "cancel",
)
.primary();
pub(crate) const CANCEL_ANSWER: Keybinding = Keybinding::new(ESC, "cancel");
pub(crate) const RETURN_INPUT: Keybinding = Keybinding::new(ESC, "return to input");
pub(crate) const ESC_RETURN: Keybinding = Keybinding::new(ESC, "return");
pub(crate) const SEARCH: Keybinding = Keybinding::new(&[(NONE, KeyCode::Char('/'))], "search");
pub(crate) const SEARCH_RETURN: Keybinding = Keybinding::new(
    &[
        (NONE, KeyCode::Enter),
        (NONE, KeyCode::Esc),
        (CTRL, KeyCode::Char('c')),
    ],
    "return",
);
pub(crate) const ENTER_LIST: Keybinding = Keybinding::new(ENTER, "return");
pub(crate) const TAB_NEXT: Keybinding = Keybinding::new(&[(NONE, KeyCode::Tab)], "switch");
pub(crate) const TAB_PREVIOUS: Keybinding = Keybinding::new(&[(SHIFT, KeyCode::Tab)], "switch");
const TAB_KEYS: &[(KeyModifiers, KeyCode)] = &[TAB_NEXT.bindings[0], TAB_PREVIOUS.bindings[0]];
pub(crate) const TABS: Keybinding = Keybinding::new(TAB_KEYS, "switch");
pub(crate) const LEFT: Keybinding = Keybinding::new(&[(NONE, KeyCode::Left)], "previous");
pub(crate) const RIGHT: Keybinding = Keybinding::new(&[(NONE, KeyCode::Right)], "next");
pub(crate) const PREVIOUS: Keybinding = Keybinding::new(
    &[(NONE, KeyCode::Up), (NONE, KeyCode::Char('k'))],
    "move up",
);
pub(crate) const NEXT: Keybinding = Keybinding::new(
    &[(NONE, KeyCode::Down), (NONE, KeyCode::Char('j'))],
    "move down",
);
pub(crate) const PAGE_PREVIOUS: Keybinding = Keybinding::new(&[(NONE, KeyCode::PageUp)], "page up");
pub(crate) const PAGE_NEXT: Keybinding = Keybinding::new(&[(NONE, KeyCode::PageDown)], "page down");
pub(crate) const FIRST: Keybinding = Keybinding::new(
    &[(NONE, KeyCode::Home), (CTRL, KeyCode::Home)],
    "jump to start",
);
pub(crate) const LAST: Keybinding =
    Keybinding::new(&[(NONE, KeyCode::End), (CTRL, KeyCode::End)], "jump to end");

// Each list panel declares its activation here, so changing one panel is local.
pub(crate) const CONFIG_CHANGE: Keybinding = Keybinding::new(ENTER_SPACE, "change");
pub(crate) const EDIT_FIELD: Keybinding = Keybinding::new(ENTER, "edit");
pub(crate) const DIR_ADD: Keybinding = Keybinding::new(ENTER, "add");
pub(crate) const DIR_INPUT: Keybinding =
    Keybinding::new(&[(NONE, KeyCode::Char('/'))], "add directory");
pub(crate) static DIR_INPUT_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[DIR_ADD, RETURN_LIST]));
pub(crate) static DIR_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[DIR_CHANGE, DIR_INPUT, CLOSE]));
pub(crate) const DIR_CHANGE: Keybinding = Keybinding::new(ENTER, "change");
pub(crate) const THEME_APPLY: Keybinding = Keybinding::new(ENTER, "apply");
pub(crate) const MODEL_APPLY: Keybinding = Keybinding::new(ENTER, "apply");
pub(crate) const SESSION_RESUME: Keybinding = Keybinding::new(ENTER, "resume");
pub(crate) const SKILL_TOGGLE: Keybinding = Keybinding::new(ENTER_SPACE, "toggle");
pub(crate) const MCP_TOGGLE: Keybinding = Keybinding::new(ENTER_SPACE, "toggle");
pub(crate) const STATUS_TOGGLE: Keybinding = Keybinding::new(ENTER_SPACE, "toggle");
pub(crate) const CONNECTOR_TOGGLE: Keybinding = Keybinding::new(ENTER, "connect/disconnect");
pub(crate) const SUBSCRIPTION_SIGN_OUT: Keybinding =
    Keybinding::new(&[(NONE, KeyCode::Char('l'))], "sign out");
pub(crate) const KEYMAP_EDIT: Keybinding = Keybinding::new(ENTER, "edit");
pub(crate) const KEYMAP_CHOOSE: Keybinding = Keybinding::new(ENTER, "choose");
pub(crate) const REWIND: Keybinding = Keybinding::new(ENTER, "rewind");
pub(crate) const SAVE: Keybinding = Keybinding::new(ENTER, "save");

// Actions on focused product surfaces.
pub(crate) const APPROVE: Keybinding = Keybinding::new(ENTER, "confirm");
pub(crate) const ANSWER: Keybinding = Keybinding::new(ENTER, "answer");
pub(crate) const SESSION_OPEN: Keybinding = Keybinding::new(ENTER, "open");
pub(crate) const SESSION_RESTORE: Keybinding = Keybinding::new(ENTER, "restore");
pub(crate) const SESSION_PREVIEW: Keybinding = Keybinding::new(SPACE, "preview");
pub(crate) const SESSION_ARCHIVE: Keybinding =
    Keybinding::new(&[(CTRL, KeyCode::Char('x'))], "archive");
pub(crate) const SESSION_DELETE: Keybinding =
    Keybinding::new(&[(CTRL, KeyCode::Char('x'))], "delete");
pub(crate) const SESSION_DETAILS: Keybinding =
    Keybinding::new(&[(NONE, KeyCode::Char('i'))], "details");
pub(crate) const SESSION_PIN: Keybinding = Keybinding::new(&[(NONE, KeyCode::Char('p'))], "pin");
pub(crate) const GROUP_EXPAND: Keybinding = Keybinding::new(ENTER, "expand");
pub(crate) const GROUP_COLLAPSE: Keybinding = Keybinding::new(ENTER, "collapse");
pub(crate) const THREAD_SWITCH: Keybinding = Keybinding::new(ENTER, "switch");
pub(crate) const TRANSCRIPT_EXPAND: Keybinding = Keybinding::new(SPACE, "expand");
pub(crate) const TRANSCRIPT_DETAILS: Keybinding = Keybinding::new(ENTER, "view details");
pub(crate) const QUEUE_EDIT: Keybinding = Keybinding::new(ENTER, "edit");
pub(crate) const QUEUE_SEND: Keybinding = Keybinding::new(&[(CTRL, KeyCode::Enter)], "send now");
pub(crate) const QUEUE_UP: Keybinding = Keybinding::new(&[(CTRL, KeyCode::Up)], "move");
pub(crate) const QUEUE_DOWN: Keybinding = Keybinding::new(&[(CTRL, KeyCode::Down)], "move");
pub(crate) const QUEUE_REMOVE: Keybinding = Keybinding::new(&[(NONE, KeyCode::Delete)], "remove");
pub(crate) const INTERRUPT: Keybinding =
    Keybinding::new(&[(CTRL, KeyCode::Char('c'))], "interrupt");

fn hints(actions: &[Keybinding]) -> KeyHints {
    actions.iter().fold(KeyHints::compact(), |hints, shortcut| {
        hints.with_binding(*shortcut)
    })
}

// HitBar composition lives here; callers only select the recipe for their state.
pub(crate) static CLOSE_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[CLOSE]));
pub(crate) static STATUS_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[TAB_NEXT, CLOSE]));
pub(crate) static TAB_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[TABS, ENTER_LIST, CLOSE]));
pub(crate) static APPROVAL_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[APPROVE]));
pub(crate) static ANSWER_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[ANSWER]));
pub(crate) static CUSTOM_ANSWER_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[ANSWER, CANCEL_ANSWER]));
pub(crate) static TRANSCRIPT_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[TRANSCRIPT_EXPAND, TRANSCRIPT_DETAILS, RETURN_INPUT]));
pub(crate) static THREAD_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[THREAD_SWITCH, RETURN_INPUT]));
pub(crate) static CANCEL_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[CANCEL]));
pub(crate) static RETURN_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[ESC_RETURN]));
pub(crate) static INPUT_HINTS: LazyLock<KeyHints> = LazyLock::new(|| hints(&[ESC_RETURN]));
pub(crate) static EXPAND_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[GROUP_EXPAND, ESC_RETURN]));
pub(crate) static COLLAPSE_HINTS: LazyLock<KeyHints> =
    LazyLock::new(|| hints(&[GROUP_COLLAPSE, ESC_RETURN]));
pub(crate) static SESSION_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    hints(&[
        SESSION_OPEN,
        SESSION_PREVIEW,
        SESSION_ARCHIVE,
        SESSION_DETAILS,
        ESC_RETURN,
    ])
});
pub(crate) static ARCHIVED_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    hints(&[
        SESSION_RESTORE,
        SESSION_PREVIEW,
        SESSION_DELETE,
        SESSION_DETAILS,
        ESC_RETURN,
    ])
});
pub(crate) static QUEUE_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    const MOVE_KEYS: &[(KeyModifiers, KeyCode)] = &[QUEUE_UP.bindings[0], QUEUE_DOWN.bindings[0]];
    let move_keys = Keybinding::new(MOVE_KEYS, "move");
    hints(&[
        QUEUE_EDIT,
        QUEUE_SEND,
        move_keys,
        QUEUE_REMOVE,
        RETURN_INPUT,
    ])
});

#[cfg(test)]
#[path = "bindings_tests.rs"]
mod tests;

fn app_keys(action: AppKeymapAction) -> &'static str {
    APP_KEYBINDINGS
        .iter()
        .find(|binding| binding.action == action)
        .expect("an application hint requires a default binding")
        .keybinding
}

pub(crate) static POLICY_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    KeyHints::compact().with_action(app_keys(AppKeymapAction::CycleApprovalMode), "cycle policy")
});
pub(crate) static CLIPBOARD_HINTS: LazyLock<KeyHints> = LazyLock::new(|| {
    KeyHints::compact()
        .with_note("image in clipboard")
        .with_action(app_keys(AppKeymapAction::ReadClipboardImage), "paste")
});

pub(crate) fn fixed_bindings() -> impl Iterator<Item = (&'static str, &'static str)> {
    static ENTRIES: LazyLock<Vec<(String, &'static str)>> = LazyLock::new(|| {
        vec![
            (
                "ctrl+r".into(),
                "search input history; Enter edits the match, Esc restores the draft",
            ),
            (
                format!("{0} {0}", CLOSE.keys()),
                "open rewind checkpoints when the input is empty",
            ),
            (
                format!("{} · {}", PREVIOUS.keys(), NEXT.keys()),
                "navigate focused lists or read-only content; letters remain text in editors",
            ),
            (
                format!(
                    "{}/{} · {}/{}",
                    FIRST.primary().keys(),
                    LAST.primary().keys(),
                    PAGE_PREVIOUS.keys(),
                    PAGE_NEXT.keys()
                ),
                "jump or page within the focused list or reading view",
            ),
            (
                SEARCH.keys(),
                "focus search in a searchable panel; Enter or Esc returns to its list",
            ),
            (TABS.keys(), "switch panel tabs from tabs, lists or search"),
            (
                CLOSE.keys(),
                "return one interaction level; pending approval/query requires an explicit answer",
            ),
        ]
    });
    ENTRIES
        .iter()
        .map(|(key, description)| (key.as_str(), *description))
}
