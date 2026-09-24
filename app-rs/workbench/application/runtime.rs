use super::*;

const DEFAULT_GUI_THEME: &str = "system";
const DEFAULT_INTERFACE_FONT_FAMILY: &str = "sans-serif";
const DEFAULT_INTERFACE_FONT_SIZE: u16 = 13;
const DEFAULT_EDITOR_FONT_FAMILY: &str = "monospace";
const DEFAULT_EDITOR_FONT_SIZE: u16 = 13;
const DEFAULT_EDITOR_LINE_HEIGHT: u16 = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct GuiConfig {
    pub(super) theme: String,
    pub(super) interface_font_family: String,
    pub(super) interface_font_size: u16,
    pub(super) editor_font_family: String,
    pub(super) editor_font_size: u16,
    pub(super) editor_line_height: u16,
}

impl Default for GuiConfig {
    fn default() -> Self {
        Self {
            theme: DEFAULT_GUI_THEME.into(),
            interface_font_family: DEFAULT_INTERFACE_FONT_FAMILY.into(),
            interface_font_size: DEFAULT_INTERFACE_FONT_SIZE,
            editor_font_family: DEFAULT_EDITOR_FONT_FAMILY.into(),
            editor_font_size: DEFAULT_EDITOR_FONT_SIZE,
            editor_line_height: DEFAULT_EDITOR_LINE_HEIGHT,
        }
    }
}

impl GuiConfig {
    pub(super) fn from_section(section: &FrontendConfigDto) -> Result<Self, String> {
        let mut config = Self::default();
        if let Some(value) = section.0.get("theme") {
            config.theme = string_value("gui.theme", value)?;
        }
        if let Some(value) = section.0.get("interfaceFontFamily") {
            config.interface_font_family = string_value("gui.interfaceFontFamily", value)?;
        }
        if let Some(value) = section.0.get("interfaceFontSize") {
            config.interface_font_size = integer_value("gui.interfaceFontSize", value, 6, 96)?;
        }
        if let Some(value) = section.0.get("editorFontFamily") {
            config.editor_font_family = string_value("gui.editorFontFamily", value)?;
        }
        if let Some(value) = section.0.get("editorFontSize") {
            config.editor_font_size = integer_value("gui.editorFontSize", value, 6, 96)?;
        }
        if let Some(value) = section.0.get("editorLineHeight") {
            config.editor_line_height = integer_value("gui.editorLineHeight", value, 6, 192)?;
        }
        if config.editor_line_height < config.editor_font_size {
            return Err("gui.editorLineHeight must be at least gui.editorFontSize".into());
        }
        Ok(config)
    }
}

fn string_value(label: &str, value: &serde_json::Value) -> Result<String, String> {
    let value = value
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 128)
        .ok_or_else(|| format!("{label} must be a non-empty string of at most 128 bytes"))?;
    Ok(value.into())
}

fn integer_value(
    label: &str,
    value: &serde_json::Value,
    minimum: u16,
    maximum: u16,
) -> Result<u16, String> {
    let value = value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| (minimum..=maximum).contains(value))
        .ok_or_else(|| format!("{label} must be an integer from {minimum} through {maximum}"))?;
    Ok(value)
}

impl WorkbenchApplication {
    pub(super) fn reload_theme(&mut self, system_scheme: ColorScheme) {
        let Ok(loader) = ThemeLoader::embedded() else {
            return;
        };
        let device_root = match default_device_root() {
            Ok(root) => root,
            Err(error) => {
                eprintln!("theme: {error}");
                return;
            }
        };
        self.system_theme_scheme = system_scheme;
        let options = ThemeLoadOptions::new(&device_root, system_scheme)
            .with_default_entry(DEFAULT_THEME_ENTRY);
        let loaded = match loader.preview(options, &self.gui.theme) {
            Ok(loaded) => loaded,
            Err(error) => {
                eprintln!("theme: {error}");
                return;
            }
        };
        for diagnostic in &loaded.diagnostics {
            eprintln!("theme: {}", diagnostic.message);
        }
        let Ok(palette) = UiTheme::from_snapshot(&loaded.snapshot) else {
            return;
        };
        let typography = gui_interface_typography(&self.gui, palette);
        let text_style = gui_editor_text_style(&self.gui, palette.editor_foreground);
        let Ok(editor_style) =
            CodeEditorStyle::from_theme_and_text_style(palette, text_style, &mut self.text_layout)
        else {
            return;
        };
        self.palette = palette;
        self.typography = typography;
        self.theme_scheme = loaded.snapshot.color_scheme();
        self.theme_follows_system = loaded.follows_system;
        self.session_pane.set_composer_style(editor_style.clone());
        self.code_editor_style = editor_style.clone();
        self.scm
            .editor_mut()
            .set_style(ash_editor::MultiDiffEditorStyle::from_theme(
                palette,
                editor_style,
            ));
    }

    pub(super) fn apply_gui_config(&mut self, section: FrontendConfigDto) {
        self.apply_gui_keybindings(&section);

        let gui = match GuiConfig::from_section(&section) {
            Ok(gui) => gui,
            Err(error) => {
                eprintln!("could not apply [gui] configuration: {error}");
                return;
            }
        };
        if self.gui == gui {
            return;
        }
        self.gui = gui;
        self.reload_theme(self.system_theme_scheme);
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if let Err(error) = window.set_theme((!self.theme_follows_system).then_some(
            match self.theme_scheme {
                ColorScheme::Dark | ColorScheme::HighContrastDark => Theme::Dark,
                ColorScheme::Light | ColorScheme::HighContrastLight => Theme::Light,
            },
        )) {
            eprintln!("could not apply configured GUI theme: {error}");
        }
    }

    fn apply_gui_keybindings(&mut self, section: &FrontendConfigDto) {
        let platform = ash_keybinding::HostPlatform::current();
        let rules = match keybindings::compile_user_bindings(section.0.get("keybindings"), platform)
        {
            Ok(rules) => rules,
            Err(error) => {
                let diagnostic = format!("invalid [gui].keybindings: {error}");
                eprintln!("{diagnostic}");
                self.keybinding_diagnostics = vec![diagnostic];
                return;
            }
        };
        self.keybinding_diagnostics = keybindings::binding_diagnostics(&rules, platform);
        self.keybindings.replace_user_bindings(rules);
    }

    pub(super) fn show_files_pane(&mut self) {
        if self.active_main_pane_kind() == Some(PaneInputKind::Diff) {
            let Some(tab_key) = self.active_session_tab_key() else {
                return;
            };
            let Some(pane) = self
                .workbench
                .workbench()
                .pane_part(&tab_key)
                .map(|pane_part| pane_part.active_group())
            else {
                return;
            };
            if self
                .workbench
                .ensure_input_with(
                    &tab_key,
                    pane,
                    PaneInput::files(self.env.working_directory().to_path_buf()),
                    PaneBinding::new,
                )
                .is_none()
            {
                return;
            }
            self.files_pane_expanded = true;
            self.main_surface.show_agent();
            self.workbench.collapse_inspector();
            let _ = self.activate_pane_context(tab_key, pane);
            return;
        }
        self.open_main_input(PaneInput::files(self.env.working_directory().to_path_buf()));
    }

    pub(super) fn show_changes_pane(&mut self) {
        self.open_main_input(PaneInput::diff(self.env.working_directory().to_path_buf()));
    }

    /// Mounts one application capability as the active input of the current PaneGroup.
    fn open_main_input(&mut self, input: PaneInput) {
        let Some(tab_key) = self.active_session_tab_key() else {
            return;
        };
        let Some(pane) = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .map(|pane_part| pane_part.active_group())
        else {
            return;
        };
        if self
            .workbench
            .open_or_activate_input_with(&tab_key, pane, input, PaneBinding::new)
            .is_none()
        {
            return;
        }
        self.main_surface.show_agent();
        self.workbench.collapse_inspector();
        let _ = self.activate_pane_context(tab_key, pane);
    }

    /// Restores the active Session's Agent pane after a file feature pane is dismissed.
    pub(super) fn show_agent_pane(&mut self) {
        self.files_pane_expanded = false;
        let _ = self.bind_agent_pane();
        self.main_surface.show_agent();
    }

    /// Binds the active Session's Agent descriptor without changing the visible surface.
    ///
    /// File-editor and terminal transitions use this form when the `MainSurface` has already
    /// selected the surface that should remain visible.
    pub(super) fn bind_agent_pane(&mut self) -> bool {
        let Some(tab_key) = self.active_session_tab_key() else {
            return false;
        };
        let Some(thread_id) = self
            .session_pane
            .thread()
            .map(|thread| thread.thread_id.clone())
        else {
            return false;
        };
        let Some(session_id) = tab_key.session_id().cloned() else {
            return false;
        };
        let Some(pane) = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .map(|pane_part| pane_part.root_pane())
        else {
            return false;
        };
        if self
            .workbench
            .open_or_activate_input_with(
                &tab_key,
                pane,
                PaneInput::agent(session_id, thread_id),
                PaneBinding::new,
            )
            .is_none()
        {
            return false;
        }
        self.activate_pane_context(tab_key, pane)
    }

    pub(super) fn active_main_pane_kind(&self) -> Option<PaneInputKind> {
        let tab_key = self.active_session_tab_key()?;
        let pane = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .map(|pane_part| pane_part.active_pane())?;
        self.workbench
            .workbench()
            .pane_part(&tab_key)
            .and_then(|pane_part| pane_part.pane_input(pane))
            .map(PaneInput::kind)
    }

    /// Restores the input selected before the Terminal surface was opened.
    pub(super) fn restore_main_pane_after_terminal(&mut self) {
        let Some(tab_key) = self.active_session_tab_key() else {
            self.show_agent_pane();
            return;
        };
        if !self.main_surface.is_editor() {
            let _ = self.bind_agent_pane();
            return;
        }
        let Some(pane) = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .map(|pane_part| pane_part.root_pane())
        else {
            return;
        };
        let input = self
            .workbench
            .workbench()
            .pane_part(&tab_key)
            .and_then(|part| part.group(pane))
            .and_then(|group| {
                group.inputs().find(|input| {
                    matches!(input.kind(), PaneInputKind::Files | PaneInputKind::Diff)
                })
            })
            .cloned();
        let Some(input) = input else {
            let _ = self.bind_agent_pane();
            return;
        };
        if self
            .workbench
            .open_or_activate_input_with(&tab_key, pane, input, PaneBinding::new)
            .is_none()
        {
            return;
        }
        let _ = self.activate_pane_context(tab_key, pane);
    }

    pub(super) fn fail(&mut self, message: impl std::fmt::Display) {
        eprintln!("{APP_DISPLAY_NAME} failed: {message}");
        self.failed = true;
    }

    pub(super) fn redraw_frame(&mut self, context: &mut WindowContext<'_, WorkbenchEvent>) {
        let now = Instant::now();
        let retained_report = self.retained_runtime.advance(now);
        let _ = retained_report
            .animation()
            .schedule(&mut self.frame_scheduler);
        match self.frame_scheduler.take() {
            Some(FrameInvalidation::Fragment) => match self.frame_scheduler.take_fragment_ids() {
                Some(_) => self.rebuild_presentation(),
                None => self.rebuild_overlay_presentation(),
            },
            Some(FrameInvalidation::Rebuild) => self.rebuild_presentation(),
            Some(FrameInvalidation::Render) | None => {}
        }
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        if let Err(error) = context.present_frame(presentation.frame(), &self.ui_dispatch) {
            self.fail(&error);
            context.exit_with_error(ApplicationError::host("app frame rendering", error));
        }
    }

    pub(super) fn window_viewport(&self) -> LogicalViewport {
        LogicalViewport::from_physical(
            self.physical_extent.width,
            self.physical_extent.height,
            self.scale_factor,
        )
    }

    pub(super) fn logical_viewport(&self) -> LogicalViewport {
        self.window_viewport()
    }

    pub(super) fn active_screen(&self) -> ScreenBuffer {
        if self.main_surface.is_terminal() {
            ScreenBuffer::Alternate
        } else {
            ScreenBuffer::Primary
        }
    }

    pub(super) fn terminal_size(&self) -> GridSize {
        terminal_grid_size_for_viewport(
            self.logical_viewport(),
            self.active_screen(),
            self.workbench.tab_container_state(),
            self.workbench.inspector_state(),
        )
    }
}

fn gui_font_family(family: &str) -> FontFamily {
    match family {
        "monospace" => FontFamily::Monospace,
        "sans-serif" => FontFamily::SansSerif,
        "serif" => FontFamily::Serif,
        family => FontFamily::Named(family.to_owned()),
    }
}

pub(super) fn gui_editor_text_style(gui: &GuiConfig, color: Color) -> TextStyle {
    TextStyle::new(f32::from(gui.editor_font_size), color)
        .with_family(gui_font_family(&gui.editor_font_family))
        .with_line_height(f32::from(gui.editor_line_height))
}

pub(super) fn gui_interface_typography(gui: &GuiConfig, theme: UiTheme) -> UiTypography {
    UiTypography::from_theme(
        theme,
        gui_font_family(&gui.interface_font_family),
        f32::from(gui.interface_font_size),
    )
}
