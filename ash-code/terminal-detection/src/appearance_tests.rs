use super::BackgroundAppearance;
use super::BackgroundDetection;
use super::BackgroundSource;
use super::ColorLevel;
use super::EnvironmentValues;
use super::TerminalRgb;
use super::detect_color_level;
use super::resolve_background_with_colorfgbg;
use std::collections::HashMap;

#[derive(Default)]
struct FakeEnvironment {
    values: HashMap<String, String>,
}

impl FakeEnvironment {
    fn with(mut self, name: &str, value: &str) -> Self {
        self.values.insert(name.into(), value.into());
        self
    }
}

impl EnvironmentValues for FakeEnvironment {
    fn value(&self, name: &str) -> Option<String> {
        self.values.get(name).cloned()
    }
}

#[test]
fn explicit_color_suppression_wins_over_terminal_capabilities() {
    let environment = FakeEnvironment::default()
        .with("NO_COLOR", "1")
        .with("COLORTERM", "truecolor")
        .with("TERM", "xterm-256color");
    assert_eq!(detect_color_level(&environment), ColorLevel::Monochrome);
}

#[test]
fn color_level_uses_colorterm_then_term() {
    assert_eq!(
        detect_color_level(&FakeEnvironment::default().with("COLORTERM", "24bit")),
        ColorLevel::TrueColor
    );
    assert_eq!(
        detect_color_level(&FakeEnvironment::default().with("TERM", "screen-256color")),
        ColorLevel::Ansi256
    );
    assert_eq!(
        detect_color_level(&FakeEnvironment::default().with("TERM", "xterm")),
        ColorLevel::Ansi16
    );
}

#[test]
fn osc_background_has_priority_over_colorfgbg() {
    assert_eq!(
        resolve_background_with_colorfgbg(Some(TerminalRgb::new(245, 245, 245)), Some("15;0")),
        BackgroundDetection {
            appearance: BackgroundAppearance::Light,
            source: BackgroundSource::Osc11,
        }
    );
}

#[test]
fn environment_and_dark_fallback_are_explicit() {
    assert_eq!(
        resolve_background_with_colorfgbg(None, Some("0;15")),
        BackgroundDetection {
            appearance: BackgroundAppearance::Light,
            source: BackgroundSource::ColorFgBg,
        }
    );
    assert_eq!(
        resolve_background_with_colorfgbg(None, Some("invalid")),
        BackgroundDetection {
            appearance: BackgroundAppearance::Dark,
            source: BackgroundSource::ConservativeFallback,
        }
    );
}
