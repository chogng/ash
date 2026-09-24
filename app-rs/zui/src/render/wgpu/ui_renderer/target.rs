/// Physical render-target extent paired with the logical-to-physical UI scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UiViewport {
    width: u32,
    height: u32,
    scale_factor: f32,
}

impl UiViewport {
    pub const fn new(width: u32, height: u32, scale_factor: f32) -> Self {
        Self {
            width,
            height,
            scale_factor,
        }
    }

    pub const fn width(self) -> u32 {
        self.width
    }

    pub const fn height(self) -> u32 {
        self.height
    }

    pub const fn scale_factor(self) -> f32 {
        self.scale_factor
    }
}
