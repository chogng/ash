use crate::nls::Language;
use crate::thread::composer::ChatInputMode;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use serde::Deserialize;
use serde::Serialize;

/// The TUI applies a complete candidate only after every feature owner has validated it.
/// Persistence remains opaque, so editing one field still preserves unrelated stored values.
pub(crate) struct TuiSettings {
    pub(crate) terminal: TerminalSettings,
    pub(crate) session_grouping: crate::sessions::SessionGrouping,
    pub(crate) status_line: crate::status::StatusLineSettings,
    pub(crate) keymap: crate::keymap_setup::KeymapSettings,
    pub(crate) dictation: super::DictationShortcutSettings,
    pub(crate) punctuation: PunctuationSettings,
}

impl TuiSettings {
    pub(crate) fn from_tui(section: &FrontendConfigDto) -> Result<Self, String> {
        let terminal = TerminalSettings::from_tui(section)?;
        let unknown = section.0.keys().find(|key| {
            !TerminalSettings::KEYS.contains(&key.as_str())
                && !matches!(
                    key.as_str(),
                    "theme"
                        | "sessionGrouping"
                        | "pinnedModels"
                        | "keybindings"
                        | "statusLine"
                        | "statusLineStyle"
                        | "showGitChangesAsDiff"
                        | "englishPunctuation"
                        | "dictationShortcutEnabled"
                        | "dictationShortcut"
                )
        });
        if let Some(key) = unknown {
            let mut message = crate::nls::Text::template(
                "Unknown [tui] configuration key: {0}.",
                vec![crate::nls::Text::literal(key)],
            );
            message.localize(terminal.language());
            return Err(message.to_string());
        }
        let status_line = crate::status::StatusLineSettings::from_tui(section)?;
        let keymap = crate::keymap_setup::settings_from_tui(section)?;
        let dictation = super::DictationShortcutSettings::from_tui(&section.0)?;
        let punctuation = PunctuationSettings::from_tui(section)?;
        crate::models::pinned_models(section)?;
        crate::theme::preference_from_tui(section)
            .map_err(|message| crate::nls::localize(terminal.language(), &message).into_owned())?;
        let session_grouping = crate::sessions::SessionGrouping::from_tui(section)
            .map_err(|message| crate::nls::localize(terminal.language(), &message).into_owned())?;
        Ok(Self {
            session_grouping,
            terminal,
            status_line,
            keymap,
            dictation,
            punctuation,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeyHintStyle {
    Contrast,
    Muted,
}

impl KeyHintStyle {
    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Contrast => Self::Muted,
            Self::Muted => Self::Contrast,
        }
    }
}

impl Default for KeyHintStyle {
    fn default() -> Self {
        Self::Contrast
    }
}

/// Selects the branch marker that the host terminal font can render.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GlyphSet {
    Powerline,
    Plain,
}

impl GlyphSet {
    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Powerline => Self::Plain,
            Self::Plain => Self::Powerline,
        }
    }

    pub(crate) const fn branch_marker(self) -> &'static str {
        match self {
            Self::Powerline => "\u{e0a0}",
            Self::Plain => "git",
        }
    }
}

impl Default for GlyphSet {
    fn default() -> Self {
        Self::Powerline
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalSettings {
    screen_mode: crate::terminal::ScreenMode,
    input_mode: ChatInputMode,
    key_hint_style: KeyHintStyle,
    glyph_set: GlyphSet,
    memory_diagnostics: bool,
    show_tips: bool,
    auto_update: crate::UpdatePolicy,
    language: Language,
}

impl TerminalSettings {
    const KEYS: [&'static str; 8] = [
        "screenMode",
        "inputMode",
        "keyHintStyle",
        "glyphSet",
        "memoryDiagnostics",
        "showTips",
        "autoUpdate",
        "language",
    ];

    pub(crate) fn from_tui(section: &FrontendConfigDto) -> Result<Self, String> {
        let defaults = serde_json::to_value(Self::default())
            .map_err(|error| format!("could not build TUI defaults: {error}"))?;
        let mut values = defaults
            .as_object()
            .cloned()
            .ok_or_else(|| "TUI defaults must serialize as an object".to_owned())?;
        for key in Self::KEYS {
            if let Some(value) = section.0.get(key) {
                values.insert(key.into(), value.clone());
            }
        }
        serde_json::from_value::<Self>(values.into())
            .map_err(|error| format!("invalid [tui] configuration: {error}"))
    }

    pub(crate) fn write_to_tui(
        self,
        section: &FrontendConfigDto,
    ) -> Result<FrontendConfigDto, String> {
        let encoded = serde_json::to_value(self)
            .map_err(|error| format!("could not encode [tui] configuration: {error}"))?;
        let fields = encoded
            .as_object()
            .ok_or_else(|| "TUI configuration must serialize as an object".to_owned())?;
        let mut values = section.0.clone();
        values.remove("dirPermissions");
        values.remove("followUpMode");
        values.remove("mouseInteractions");
        values.remove("copyOnSelect");
        for key in Self::KEYS {
            let value = fields
                .get(key)
                .ok_or_else(|| format!("TUI configuration did not encode {key}"))?;
            values.insert(key.into(), value.clone());
        }
        Ok(FrontendConfigDto(values))
    }

    pub(crate) const fn screen_mode(self) -> crate::terminal::ScreenMode {
        self.screen_mode
    }

    pub(crate) fn set_screen_mode(&mut self, mode: crate::terminal::ScreenMode) {
        self.screen_mode = mode;
    }

    pub(crate) const fn input_mode(self) -> ChatInputMode {
        self.input_mode
    }

    pub(crate) fn set_input_mode(&mut self, mode: ChatInputMode) {
        self.input_mode = mode;
    }

    pub(crate) const fn key_hint_style(self) -> KeyHintStyle {
        self.key_hint_style
    }

    pub(crate) fn set_key_hint_style(&mut self, style: KeyHintStyle) {
        self.key_hint_style = style;
    }

    pub(crate) const fn glyph_set(self) -> GlyphSet {
        self.glyph_set
    }

    pub(crate) fn set_glyph_set(&mut self, glyph_set: GlyphSet) {
        self.glyph_set = glyph_set;
    }

    pub(crate) const fn memory_diagnostics(self) -> bool {
        self.memory_diagnostics
    }

    pub(crate) fn set_memory_diagnostics(&mut self, enabled: bool) {
        self.memory_diagnostics = enabled;
    }

    pub(crate) const fn show_tips(self) -> bool {
        self.show_tips
    }

    pub(crate) fn set_show_tips(&mut self, enabled: bool) {
        self.show_tips = enabled;
    }

    pub(crate) const fn auto_update(self) -> crate::UpdatePolicy {
        self.auto_update
    }

    pub(crate) fn set_auto_update(&mut self, policy: crate::UpdatePolicy) {
        self.auto_update = policy;
    }

    pub(crate) const fn language(self) -> Language {
        self.language
    }

    pub(crate) fn set_language(&mut self, language: Language) {
        self.language = language;
    }
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            screen_mode: crate::terminal::ScreenMode::Fullscreen,
            input_mode: ChatInputMode::Standard,
            key_hint_style: KeyHintStyle::Contrast,
            glyph_set: GlyphSet::Powerline,
            memory_diagnostics: false,
            show_tips: true,
            auto_update: crate::UpdatePolicy::Latest,
            language: Language::English,
        }
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;

/// Profile-local input preference; its revision never comes from the connected server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PunctuationSettings {
    pub(crate) enabled: bool,
    pub(crate) revision: ash_config::ConfigRevision,
}

impl PunctuationSettings {
    fn from_tui(section: &FrontendConfigDto) -> Result<Self, String> {
        let enabled = match section.0.get("englishPunctuation") {
            None => false,
            Some(serde_json::Value::Bool(enabled)) => *enabled,
            Some(_) => {
                return Err(crate::nls::localize(
                    TerminalSettings::from_tui(section)?.language(),
                    "Invalid [tui].englishPunctuation: expected boolean.",
                )
                .into_owned());
            }
        };
        Ok(Self {
            enabled,
            ..Self::default()
        })
    }
}

impl Default for PunctuationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            revision: ash_config::ConfigRevision::INITIAL,
        }
    }
}
