use std::fmt;

use crate::catalog::ThemeError;

/// One resolved sRGB color with straight alpha.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Rgba {
    red: u8,
    green: u8,
    blue: u8,
    alpha: u8,
}

impl Rgba {
    pub const fn new(red: u8, green: u8, blue: u8, alpha: u8) -> Self {
        Self {
            red,
            green,
            blue,
            alpha,
        }
    }

    pub const fn rgb(red: u8, green: u8, blue: u8) -> Self {
        Self::new(red, green, blue, 255)
    }

    pub const fn components(self) -> [u8; 4] {
        [self.red, self.green, self.blue, self.alpha]
    }
}

impl fmt::Display for Rgba {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.alpha == 255 {
            write!(
                formatter,
                "#{:02x}{:02x}{:02x}",
                self.red, self.green, self.blue
            )
        } else {
            write!(
                formatter,
                "#{:02x}{:02x}{:02x}{:02x}",
                self.red, self.green, self.blue, self.alpha
            )
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FloatColor {
    red: f64,
    green: f64,
    blue: f64,
    alpha: f64,
}

impl FloatColor {
    pub(crate) fn parse(value: &str) -> Result<Self, ThemeError> {
        let hex = value
            .strip_prefix('#')
            .ok_or_else(|| ThemeError::InvalidColor {
                value: value.to_owned(),
            })?;
        if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ThemeError::InvalidColor {
                value: value.to_owned(),
            });
        }
        let expanded = if hex.len() <= 4 {
            hex.chars()
                .flat_map(|character| [character, character])
                .collect()
        } else {
            hex.to_owned()
        };
        let component = |start| {
            u8::from_str_radix(&expanded[start..start + 2], 16)
                .map(|value| f64::from(value) / 255.0)
                .map_err(|_| ThemeError::InvalidColor {
                    value: value.to_owned(),
                })
        };
        Ok(Self {
            red: component(0)?,
            green: component(2)?,
            blue: component(4)?,
            alpha: if expanded.len() == 8 {
                component(6)?
            } else {
                1.0
            },
        })
    }

    pub(crate) fn transparent(self, factor: f64) -> Self {
        Self {
            alpha: self.alpha * factor.clamp(0.0, 1.0),
            ..self
        }
    }

    pub(crate) fn lighten(self, factor: f64) -> Self {
        self.mix(Self::opaque(1.0), factor)
    }

    pub(crate) fn darken(self, factor: f64) -> Self {
        self.mix(Self::opaque(0.0), factor)
    }

    pub(crate) fn mix(self, other: Self, factor: f64) -> Self {
        let amount = factor.clamp(0.0, 1.0);
        Self {
            red: self.red + (other.red - self.red) * amount,
            green: self.green + (other.green - self.green) * amount,
            blue: self.blue + (other.blue - self.blue) * amount,
            alpha: self.alpha + (other.alpha - self.alpha) * amount,
        }
    }

    pub(crate) fn make_opaque(self, background: Self) -> Self {
        if self.alpha == 1.0 {
            return self;
        }
        Self {
            red: self.red * self.alpha + background.red * (1.0 - self.alpha),
            green: self.green * self.alpha + background.green * (1.0 - self.alpha),
            blue: self.blue * self.alpha + background.blue * (1.0 - self.alpha),
            alpha: 1.0,
        }
    }

    pub(crate) fn is_opaque(self) -> bool {
        self.alpha == 1.0
    }

    pub(crate) fn quantized(self) -> Rgba {
        let byte = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        Rgba::new(
            byte(self.red),
            byte(self.green),
            byte(self.blue),
            byte(self.alpha),
        )
    }

    const fn opaque(value: f64) -> Self {
        Self {
            red: value,
            green: value,
            blue: value,
            alpha: 1.0,
        }
    }
}
