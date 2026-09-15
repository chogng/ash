use std::fmt;

/// Unit carried by a scalar value in the Rust GUI catalog.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ThemeSizeUnit {
    Pixels,
    Unitless,
    Milliseconds,
}

impl fmt::Display for ThemeSizeUnit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Pixels => "px",
            Self::Unitless => "unitless",
            Self::Milliseconds => "ms",
        };
        formatter.write_str(name)
    }
}

/// A validated scalar size from the Rust GUI catalog.
///
/// The manifest currently uses logical pixels, unitless values, and milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThemeSize {
    value: f32,
    unit: ThemeSizeUnit,
}

impl ThemeSize {
    pub const fn value(self) -> f32 {
        self.value
    }

    pub const fn unit(self) -> ThemeSizeUnit {
        self.unit
    }

    pub const fn as_pixels(self) -> Option<f32> {
        match self.unit {
            ThemeSizeUnit::Pixels => Some(self.value),
            ThemeSizeUnit::Unitless | ThemeSizeUnit::Milliseconds => None,
        }
    }

    pub const fn as_unitless(self) -> Option<f32> {
        match self.unit {
            ThemeSizeUnit::Unitless => Some(self.value),
            ThemeSizeUnit::Pixels | ThemeSizeUnit::Milliseconds => None,
        }
    }

    pub const fn as_milliseconds(self) -> Option<f32> {
        match self.unit {
            ThemeSizeUnit::Milliseconds => Some(self.value),
            ThemeSizeUnit::Pixels | ThemeSizeUnit::Unitless => None,
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        let (number, unit) = if let Some(number) = raw.strip_suffix("px") {
            (number, ThemeSizeUnit::Pixels)
        } else if let Some(number) = raw.strip_suffix("ms") {
            (number, ThemeSizeUnit::Milliseconds)
        } else {
            (raw, ThemeSizeUnit::Unitless)
        };
        let value = number.trim().parse::<f32>().ok()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        Some(Self { value, unit })
    }
}

#[cfg(test)]
mod tests {
    use super::ThemeSize;

    #[test]
    fn parser_preserves_supported_units() {
        assert_eq!(ThemeSize::parse("13px").unwrap().as_pixels(), Some(13.0));
        assert_eq!(ThemeSize::parse("600").unwrap().as_unitless(), Some(600.0));
        assert_eq!(
            ThemeSize::parse("120ms").unwrap().as_milliseconds(),
            Some(120.0)
        );
    }

    #[test]
    fn parser_rejects_negative_and_unknown_values() {
        assert!(ThemeSize::parse("-1px").is_none());
        assert!(ThemeSize::parse("1s").is_none());
        assert!(ThemeSize::parse("not-a-size").is_none());
    }
}
