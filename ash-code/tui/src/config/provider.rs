use super::ConfigChoices;
use super::ConfigEditorOutcome;
use super::ConfigSelectionAction;
use super::ProviderApiKeyEdit;
use crate::client::new_command_id;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::text_field;
use crate::widgets::text_field::TextField;
use crate::widgets::text_field::TextFieldOutcome;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::CustomProviderConfigDto;
use ash_app_server_protocol::protocol::config::CustomProviderProtocolDto;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::Instant;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Settings {
    pub(crate) revision: u64,
    pub(crate) config: ProviderConfigDto,
    pub(crate) key_saved: bool,
    pub(crate) inherited_model: Option<String>,
}

impl Settings {
    pub(crate) fn new(config: &ConfigReadResult, providers: &ProviderListResult, id: &str) -> Self {
        let saved = config
            .providers
            .get(id)
            .cloned()
            .unwrap_or_else(|| ProviderConfigDto {
                provider: new_command_id("custom").to_string(),
                custom: None,
                base_url: None,
                max_output_tokens: None,
                model_context: BTreeMap::new(),
            });
        Self {
            inherited_model: config.model.as_ref().map(|model| model.model.clone()),
            revision: config.revision,
            key_saved: providers
                .providers
                .iter()
                .any(|entry| entry.provider == saved.provider && entry.api_key_configured),
            config: saved,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    Save,
    Test,
    Remove,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub(crate) id: ash_protocol::CommandId,
    pub(crate) revision: u64,
    pub(crate) config: ProviderConfigDto,
    pub(crate) key: Option<ProviderApiKeyEdit>,
    pub(crate) operation: Operation,
    pub(crate) model: Option<String>,
}

pub(crate) struct Reply {
    pub(crate) id: ash_protocol::CommandId,
    pub(crate) result: Result<(ConfigChoices, Option<Result<Vec<String>, String>>), String>,
}

#[derive(Debug)]
enum TestStatus {
    Untested,
    Running(Instant),
    Passed,
    Failed,
}

#[derive(Debug)]
pub(crate) struct Panel {
    settings: Settings,
    name: TextField,
    url: TextField,
    key: TextField,
    model: TextField,
    protocol: CustomProviderProtocolDto,
    context: u32,
    focus: usize,
    message: String,
    status: TestStatus,
    pending: Option<Request>,
}

fn field(value: &str, placeholder: &str) -> TextField {
    TextField::new(value, SearchBoxModel::new(placeholder))
}

const FIELD_HEIGHTS: [u16; 7] = [4, 4, 4, 4, 1, 1, 1];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Target(usize);

impl Panel {
    pub(crate) fn new(settings: Settings) -> Self {
        let model = settings
            .config
            .custom
            .as_ref()
            .and_then(|custom| custom.model.as_ref());

        Self {
            name: field(
                settings
                    .config
                    .custom
                    .as_ref()
                    .map_or("", |custom| custom.name.as_str()),
                "Provider name",
            ),
            url: field(
                settings.config.base_url.as_deref().unwrap_or_default(),
                "https://example.com/v1",
            ),
            key: TextField::new(
                "",
                SearchBoxModel::new(if settings.key_saved {
                    "Key saved · Enter to replace"
                } else {
                    "API key (optional)"
                })
                .masked(),
            ),
            model: field(
                model.map_or("", |model| model.as_str()),
                "Leave empty to use the selected built-in model",
            ),
            protocol: settings
                .config
                .custom
                .as_ref()
                .map_or(CustomProviderProtocolDto::Responses, |custom| {
                    custom.protocol
                }),
            context: settings
                .config
                .custom
                .as_ref()
                .map_or(272_000, |custom| custom.context_window),
            settings,
            focus: 0,
            message: String::new(),
            status: TestStatus::Untested,
            pending: None,
        }
    }

    pub(crate) fn is_saving_pending(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|request| request.operation == Operation::Save)
    }

    fn rows(&self, area: Rect) -> Vec<(usize, Rect)> {
        let available = area
            .height
            .saturating_sub(u16::from(!self.message.is_empty()));
        let mut start = 0;
        while start < self.focus
            && FIELD_HEIGHTS[start..=self.focus].iter().sum::<u16>() > available
        {
            start += 1;
        }
        let mut y = area.y;
        let mut rows = Vec::new();
        for (index, &height) in FIELD_HEIGHTS.iter().enumerate().skip(start) {
            if y + height > area.y + available {
                break;
            }
            rows.push((index, Rect::new(area.x, y, area.width, height)));
            y += height;
        }
        rows
    }

    pub(crate) fn target_at(
        &self,
        area: Rect,
        position: ratatui::layout::Position,
    ) -> Option<Target> {
        if self.pending.is_some() {
            return None;
        }
        self.rows(area)
            .into_iter()
            .find(|(_, row)| row.contains(position))
            .map(|(index, _)| Target(index))
    }

    pub(crate) fn activate(&mut self, target: Target) -> ConfigEditorOutcome {
        if self.pending.is_some() {
            return ConfigEditorOutcome::Consumed;
        }
        if self.focus != target.0 {
            if let Some(field) = self.field_mut() {
                field.blur();
            }
            self.focus = target.0;
        }
        if self.field_mut().is_some_and(|field| field.is_editing()) {
            return ConfigEditorOutcome::Consumed;
        }
        self.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    }

    pub(crate) fn draw_with_pointer(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<Target>,
        pressed: Option<Target>,
        context: RenderContext<'_>,
    ) {
        self.draw_body_at_with_pointer(frame, area, context, Instant::now(), hovered, pressed);
    }

    pub(crate) fn provider_id(&self) -> &str {
        &self.settings.config.provider
    }
    pub(crate) fn accepts(&self, id: &ash_protocol::CommandId) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|request| &request.id == id)
    }
    pub(crate) fn is_saving(&self, id: &ash_protocol::CommandId) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|request| &request.id == id && request.operation == Operation::Save)
    }
    pub(crate) fn replace(&mut self, settings: Settings) {
        if settings.revision != self.settings.revision {
            self.status = TestStatus::Untested;
            self.message =
                "Configuration changed elsewhere · Reopen this form before saving".into();
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        static SAVING: LazyLock<KeyHints> = LazyLock::new(|| KeyHints::new().with_note("Saving…"));
        static WORKING: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::new()
                .with_note("Working…")
                .with_action("Esc", "return")
        });
        static EDIT: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::new()
                .with_action("Enter", "edit")
                .with_action("Tab/Shift+Tab", "move")
                .with_action("Esc", "return")
        });
        static CHANGE: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::new()
                .with_action("←/→", "change")
                .with_action("Tab/Shift+Tab", "move")
                .with_action("Esc", "return")
        });
        static TEST: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::new()
                .with_action("Enter", "test")
                .with_action("Tab/Shift+Tab", "move")
                .with_action("Esc", "return")
        });
        if let Some(pending) = &self.pending {
            return if pending.operation == Operation::Save {
                &SAVING
            } else {
                &WORKING
            };
        }
        match self.focus {
            0 | 1 | 2 | 3 => {
                let field = match self.focus {
                    0 => &self.name,
                    1 => &self.url,
                    2 => &self.key,
                    _ => &self.model,
                };
                if field.is_editing() {
                    field.key_hints()
                } else {
                    &EDIT
                }
            }
            4 | 5 => &CHANGE,
            _ => &TEST,
        }
    }

    fn field_mut(&mut self) -> Option<&mut TextField> {
        match self.focus {
            0 => Some(&mut self.name),
            1 => Some(&mut self.url),
            2 => Some(&mut self.key),
            3 => Some(&mut self.model),
            _ => None,
        }
    }

    fn invalidate(&mut self) {
        self.status = TestStatus::Untested;
        self.message.clear();
    }

    pub(crate) fn is_testing(&self) -> bool {
        matches!(self.status, TestStatus::Running(_))
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ConfigEditorOutcome {
        if key.kind != KeyEventKind::Press {
            return ConfigEditorOutcome::Consumed;
        }
        if let Some(pending) = &self.pending {
            return if key.code == KeyCode::Esc && pending.operation != Operation::Save {
                ConfigEditorOutcome::Dismiss
            } else {
                ConfigEditorOutcome::Consumed
            };
        }
        if let Some(field) = self.field_mut() {
            let before = field.query().to_owned();
            let outcome = field.handle_key(key);
            if matches!(outcome, TextFieldOutcome::Submit) {
                field.accept(field.query().to_owned());
            }
            let changed = before != field.query();
            if changed {
                self.invalidate();
            }
            if matches!(outcome, TextFieldOutcome::Submit) {
                return self.save();
            }
            if !matches!(outcome, TextFieldOutcome::Unhandled) {
                return ConfigEditorOutcome::Consumed;
            }
        }
        match key.code {
            KeyCode::Esc => return ConfigEditorOutcome::Dismiss,
            KeyCode::Tab | KeyCode::Down | KeyCode::BackTab | KeyCode::Up => {
                if let Some(field) = self.field_mut() {
                    field.blur();
                }
                let backwards = matches!(key.code, KeyCode::BackTab | KeyCode::Up)
                    || key.modifiers.contains(KeyModifiers::SHIFT);
                self.focus = if backwards {
                    self.focus.saturating_sub(1)
                } else {
                    (self.focus + 1).min(6)
                };
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Enter if self.focus == 4 => {
                let protocols = [
                    CustomProviderProtocolDto::Responses,
                    CustomProviderProtocolDto::ChatCompletions,
                    CustomProviderProtocolDto::AnthropicMessages,
                ];
                let index = protocols
                    .iter()
                    .position(|protocol| *protocol == self.protocol)
                    .expect("known protocol");
                self.protocol =
                    protocols[(index + if key.code == KeyCode::Left { 2 } else { 1 }) % 3];
                self.invalidate();
                return self.save();
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Enter if self.focus == 5 => {
                self.context = if self.context == 1_000_000 {
                    272_000
                } else {
                    1_000_000
                };
                self.invalidate();
                return self.save();
            }
            KeyCode::Enter if self.focus == 6 => return self.start(Operation::Test),
            _ => {}
        }
        ConfigEditorOutcome::Consumed
    }

    pub(crate) fn handle_paste(&mut self, value: String) {
        if self.pending.is_some() {
            return;
        }
        if let Some(field) = self.field_mut() {
            field.handle_paste(value);
            self.invalidate();
        }
    }

    fn config(&self) -> Result<ProviderConfigDto, String> {
        let name = self.name.query().trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("Provider name must contain 1 to 80 characters".into());
        }
        let url = normalize_url(self.url.query(), self.protocol)?;
        let model = self.model.query().trim();
        let mut config = self.settings.config.clone();
        config.custom = Some(CustomProviderConfigDto {
            context_window: self.context,
            model: (!model.is_empty()).then(|| model.to_owned()),
            name: name.into(),
            protocol: self.protocol,
            order: config.custom.as_ref().map_or(0, |custom| custom.order),
        });
        config.base_url = Some(url);
        config.max_output_tokens = None;
        config.model_context.clear();
        if !model.is_empty() {
            ash_protocol::ModelId::new(model).map_err(|_| "Enter a valid model ID")?;
        }
        Ok(config)
    }

    fn save(&mut self) -> ConfigEditorOutcome {
        if self.settings.config.custom.is_none()
            && (self.name.query().trim().is_empty() || self.url.query().trim().is_empty())
        {
            self.message = "Complete provider name and Base URL to save".into();
            return ConfigEditorOutcome::Consumed;
        }
        self.start(Operation::Save)
    }

    fn start(&mut self, operation: Operation) -> ConfigEditorOutcome {
        let config = match self.config() {
            Ok(config) => config,
            Err(message) => {
                self.message = message;
                if operation == Operation::Test {
                    self.status = TestStatus::Failed;
                }
                return ConfigEditorOutcome::Consumed;
            }
        };
        if operation == Operation::Test {
            if config
                .custom
                .as_ref()
                .and_then(|custom| custom.model.as_ref())
                .or(self.settings.inherited_model.as_ref())
                .is_none()
            {
                self.message = "Select a model or enter a model ID before testing".into();
                self.status = TestStatus::Failed;
                return ConfigEditorOutcome::Consumed;
            }
            self.status = TestStatus::Running(Instant::now());
        }
        self.url
            .accept(config.base_url.clone().expect("custom URL"));
        self.message = match operation {
            Operation::Test => "Testing…",
            _ => "Saving…",
        }
        .into();
        let request = Request {
            id: new_command_id("provider"),
            revision: self.settings.revision,
            key: (!self.key.query().is_empty())
                .then(|| ProviderApiKeyEdit::new(config.provider.clone(), self.key.query().into())),
            model: config
                .custom
                .as_ref()
                .and_then(|custom| custom.model.clone())
                .or_else(|| self.settings.inherited_model.clone()),
            config,
            operation,
        };
        self.pending = Some(request.clone());
        ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(request))
    }

    pub(crate) fn complete(&mut self, reply: Reply) {
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.id != reply.id)
        {
            return;
        }
        let request = self.pending.take().expect("matched request");
        match reply.result {
            Err(message) => {
                self.message = message;
                if request.operation == Operation::Test {
                    self.status = TestStatus::Failed;
                }
            }
            Ok((choices, result)) => {
                let saved_settings = choices.actions.values().find_map(|action| match action {
                    ConfigSelectionAction::OpenProvider(settings)
                        if settings.config.provider == request.config.provider =>
                    {
                        Some(settings.clone())
                    }
                    _ => None,
                });
                match request.operation {
                    Operation::Save => {
                        if let Some(settings) = saved_settings {
                            self.settings = settings;
                            self.key.accept(String::new());
                            if request.key.is_some() {
                                self.key = TextField::new(
                                    "",
                                    SearchBoxModel::new("Key saved · Enter to replace").masked(),
                                );
                            }
                            self.message = "Saved".into();
                        }
                    }
                    Operation::Test => match result {
                        Some(Err(message)) => {
                            self.message = message;
                            self.status = TestStatus::Failed;
                        }
                        Some(Ok(_)) => {
                            self.message = "Passed".into();
                            self.status = TestStatus::Passed;
                        }
                        None => {
                            self.message = "No test result received".into();
                            self.status = TestStatus::Failed;
                        }
                    },
                    Operation::Remove => {}
                }
            }
        }
    }

    pub(crate) fn body_rows(&self) -> u16 {
        FIELD_HEIGHTS.iter().sum::<u16>() + u16::from(!self.message.is_empty())
    }
    pub(crate) fn draw_body(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        self.draw_body_at(frame, area, context, Instant::now());
    }

    fn draw_body_at(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        context: RenderContext<'_>,
        now: Instant,
    ) {
        self.draw_body_at_with_pointer(frame, area, context, now, None, None);
    }

    fn draw_body_at_with_pointer(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        context: RenderContext<'_>,
        now: Instant,
        hovered: Option<Target>,
        pressed: Option<Target>,
    ) {
        let mut y = area.y;
        for (index, row) in self.rows(area) {
            y = row.y;
            let height = row.height;
            let label = context.localize(
                [
                    "Provider name",
                    "Base URL",
                    "API key",
                    "Model ID",
                    "API type",
                    "Model context window",
                    "Test",
                ][index],
            );
            let focused = self.focus == index;
            let style = Style::default().fg(if focused {
                context.focus()
            } else {
                context.foreground()
            });
            let style = style.patch(crate::render::interaction_style(
                context,
                crate::render::InteractionState {
                    selected: false,
                    hovered: hovered == Some(Target(index)),
                    pressed: pressed == Some(Target(index)),
                    ..Default::default()
                },
            ));
            let mut spans = Vec::new();
            if index == 6 {
                let color = match self.status {
                    TestStatus::Passed => context.success(),
                    TestStatus::Failed => context.warning(),
                    TestStatus::Running(start) => {
                        let level = 0.35
                            + 0.3
                                * (1.0
                                    - (now.saturating_duration_since(start).as_secs_f32()
                                        * std::f32::consts::TAU
                                        / 1.6)
                                        .cos())
                                / 2.0;
                        match context.muted() {
                            ratatui::style::Color::Rgb(r, g, b) => ratatui::style::Color::Rgb(
                                (r as f32 * level) as u8,
                                (g as f32 * level) as u8,
                                (b as f32 * level) as u8,
                            ),
                            color => color,
                        }
                    }
                    TestStatus::Untested => context.muted(),
                };
                let modifier = if matches!(self.status, TestStatus::Untested) {
                    Modifier::DIM
                } else {
                    Modifier::empty()
                };
                spans.push(Span::styled(
                    "● ",
                    Style::default().fg(color).add_modifier(modifier),
                ));
            } else {
                spans.push(Span::styled(
                    crate::render::selection_marker(focused),
                    style,
                ));
            }
            spans.push(Span::styled(label.clone(), style));
            if matches!(index, 4 | 5) {
                let value = if index == 4 {
                    match self.protocol {
                        CustomProviderProtocolDto::Responses => "OpenAI Responses",
                        CustomProviderProtocolDto::ChatCompletions => "OpenAI Chat Completions",
                        CustomProviderProtocolDto::AnthropicMessages => "Anthropic Messages",
                    }
                } else if self.context == 1_000_000 {
                    "1m"
                } else {
                    "272k"
                };
                spans.push(Span::raw(" ".repeat(
                    usize::from(area.width).saturating_sub(label.width() + value.width()),
                )));
                spans.push(Span::styled(value, style));
            }
            frame.render_widget(
                Paragraph::new(Line::from(spans)),
                Rect::new(area.x.saturating_sub(2), y, area.width + 2, 1),
            );
            let field_area = Rect::new(area.x, y + 1, area.width, height.saturating_sub(1));
            match index {
                0 | 1 | 2 | 3 => text_field::draw(
                    frame,
                    field_area,
                    match index {
                        0 => &self.name,
                        1 => &self.url,
                        2 => &self.key,
                        _ => &self.model,
                    },
                    focused,
                    context,
                ),
                _ => {}
            }
            y += height;
        }
        if y < area.bottom() {
            frame.render_widget(
                Paragraph::new(context.localize(&self.message))
                    .style(Style::default().fg(context.muted())),
                Rect::new(area.x, y, area.width, 1),
            );
        }
    }
}

fn normalize_url(value: &str, protocol: CustomProviderProtocolDto) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|_| "Enter a valid HTTP or HTTPS base URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Use an HTTP or HTTPS URL without credentials, query or fragment".into());
    }
    let suffix = match protocol {
        CustomProviderProtocolDto::Responses => "/responses",
        CustomProviderProtocolDto::ChatCompletions => "/chat/completions",
        CustomProviderProtocolDto::AnthropicMessages => "/messages",
    };
    for operation in ["/responses", "/chat/completions", "/messages"] {
        if parsed.path().ends_with(operation) {
            if operation != suffix {
                return Err("The endpoint path does not match the selected API type".into());
            }
            return Ok(value[..value.len() - operation.len()].to_owned());
        }
    }
    Ok(value.into())
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
