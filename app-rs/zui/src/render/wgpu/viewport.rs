#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SurfaceExtent {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Viewport {
    width: u32,
    height: u32,
    scale_factor: f64,
}

impl Viewport {
    pub(crate) fn new(width: u32, height: u32, scale_factor: f64) -> Self {
        Self {
            width,
            height,
            scale_factor,
        }
    }

    pub(crate) fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
    }

    pub(crate) fn set_scale_factor(&mut self, scale_factor: f64) {
        self.scale_factor = scale_factor;
    }

    pub(crate) fn surface_extent(self) -> Option<SurfaceExtent> {
        (self.width > 0 && self.height > 0).then_some(SurfaceExtent {
            width: self.width,
            height: self.height,
        })
    }

    pub(crate) fn scale_factor(self) -> f64 {
        self.scale_factor
    }
}

#[cfg(test)]
#[path = "viewport_tests.rs"]
mod tests;
