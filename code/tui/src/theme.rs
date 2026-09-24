mod model;
mod picker;
mod request;
mod resource;
mod settings;

/// A completed theme operation delivered to the TUI state owner.
pub(crate) enum Event {
    PickerOpened(ThemeChoices),
    RenderChanged(crate::render::RenderTheme),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPicker,
    OpenCustomPicker,
    SetCustom { preference: String },
    Set { preference: String },
}

pub(crate) use model::ThemePickerCatalog;
pub(crate) use model::ThemePickerChoice;
pub(crate) use model::ThemePickerTarget;
pub(crate) use model::ThemePreviewPalette;
pub(crate) use picker::ThemeChoices;
pub(crate) use picker::ThemePicker;
pub(crate) use picker::ThemePickerOutcome;
pub(crate) use picker::custom_theme_choices;
pub(crate) use picker::theme_choices;
pub(crate) use request::CommandCompletion;
pub(crate) use request::execute;
pub(crate) use resource::ThemeResource;
pub(crate) use settings::preference;
pub(crate) use settings::set_preference;
