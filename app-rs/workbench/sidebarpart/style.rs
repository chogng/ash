use crate::Color;
use crate::Icon;
use crate::ScrollViewStyle;
use crate::SearchBoxStyle;
use crate::TabStatusKind;
use ash_icons::icons;
use ash_ui_theme::UiTheme;
use ash_ui_theme::UiTypography;
use zui::ui::TextStyle;

/// Semantic colors consumed by Workbench chrome components.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkbenchColors {
    pub content_background: Color,
    pub side_bar_background: Color,
    pub border: Color,
    pub foreground: Color,
    pub muted_foreground: Color,
    pub control_hover_background: Color,
    pub hover_foreground: Color,
    pub hover_background: Color,
    pub hover_border: Color,
    pub hover_shadow: Color,
    pub menu_background: Color,
    pub menu_hover_background: Color,
    pub tab_hover_background: Color,
    pub tab_active_background: Color,
    pub action_bar_background: Color,
    pub title_bar_background: Color,
    pub title_bar_action_foreground: Color,
    pub title_bar_hover_background: Color,
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
}

/// Host-resolved colors, icons, and input styling for Workbench chrome.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkbenchUiStyle {
    pub(crate) colors: WorkbenchColors,
    pub(crate) search: SearchBoxStyle,
    pub(crate) scroll_view: ScrollViewStyle,
    pub(crate) body_text: TextStyle,
    pub(crate) control_text: TextStyle,
    pub(crate) label_text: TextStyle,
    pub(crate) metadata_text: TextStyle,
    pub(crate) settings_icon: Icon,
    pub(crate) add_icon: Icon,
    pub(crate) close_icon: Icon,
    pub(crate) pinned_icon: Icon,
    pub(crate) tabs_expanded_icon: Icon,
    pub(crate) tabs_collapsed_icon: Icon,
    pub(crate) changes_icon: Icon,
}

impl WorkbenchUiStyle {
    pub(super) const fn session_status_color(&self, kind: TabStatusKind) -> Color {
        match kind {
            TabStatusKind::Idle => self.colors.muted_foreground,
            TabStatusKind::NeedsInput | TabStatusKind::Stopped => self.colors.warning,
            TabStatusKind::Working => self.colors.accent,
            TabStatusKind::ReadyForReview | TabStatusKind::Completed => self.colors.success,
            TabStatusKind::Failed => self.colors.error,
        }
    }

    pub fn from_theme(theme: UiTheme, typography: &UiTypography) -> Self {
        Self::new(
            WorkbenchColors {
                content_background: theme.content_background,
                side_bar_background: theme.side_bar_background,
                border: theme.border,
                foreground: theme.foreground,
                muted_foreground: theme.muted_foreground,
                control_hover_background: theme.list_hover_background,
                hover_foreground: theme.hover_foreground,
                hover_background: theme.hover_background,
                hover_border: theme.hover_border,
                hover_shadow: theme.hover_shadow,
                menu_background: theme.menu_background,
                menu_hover_background: theme.menu_hover_background,
                tab_hover_background: theme.tab_hover_background,
                tab_active_background: theme.tab_active_background,
                action_bar_background: theme.action_bar_background,
                title_bar_background: theme.title_bar_background,
                title_bar_action_foreground: theme.title_bar_action_foreground,
                title_bar_hover_background: theme.title_bar_hover_background,
                accent: theme.accent,
                success: theme.success,
                warning: theme.warning,
                error: theme.error,
            },
            theme.search_box_style_with_typography(typography),
            theme.tab_container_scroll_view_style(),
            typography.body_text(theme.foreground),
            typography.control_text(theme.foreground),
            typography.label_text(theme.foreground),
            typography.metadata_text(theme.muted_foreground),
            icons::GEAR,
            icons::ADD,
            icons::CLOSE,
            icons::PINNED,
            icons::LAYOUT_SIDEBAR_LEFT,
            icons::LAYOUT_SIDEBAR_LEFT_OFF_EMPTY,
            icons::DIFF,
        )
    }

    pub fn new(
        colors: WorkbenchColors,
        search: SearchBoxStyle,
        scroll_view: ScrollViewStyle,
        body_text: TextStyle,
        control_text: TextStyle,
        label_text: TextStyle,
        metadata_text: TextStyle,
        settings_icon: Icon,
        add_icon: Icon,
        close_icon: Icon,
        pinned_icon: Icon,
        tabs_expanded_icon: Icon,
        tabs_collapsed_icon: Icon,
        changes_icon: Icon,
    ) -> Self {
        Self {
            colors,
            search,
            scroll_view,
            body_text,
            control_text,
            label_text,
            metadata_text,
            settings_icon,
            add_icon,
            close_icon,
            pinned_icon,
            tabs_expanded_icon,
            tabs_collapsed_icon,
            changes_icon,
        }
    }
}
