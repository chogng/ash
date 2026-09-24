use crate::ui::foundation::Color;
use crate::ui::presentation::UiScene;

use super::{RenderOutcome, RenderTargetSize, Renderer, RendererError};

#[derive(Default)]
struct RecordingRenderer {
    size: Option<RenderTargetSize>,
    scale_factor: Option<f64>,
    scene_count: usize,
}

impl Renderer for RecordingRenderer {
    fn resize(&mut self, size: RenderTargetSize) {
        self.size = Some(size);
    }

    fn set_scale_factor(&mut self, scale_factor: f64) {
        self.scale_factor = Some(scale_factor);
    }

    fn render(&mut self) -> Result<RenderOutcome, RendererError> {
        Ok(RenderOutcome::Presented)
    }

    fn render_scene(&mut self, _scene: &UiScene) -> Result<RenderOutcome, RendererError> {
        self.scene_count += 1;
        Ok(RenderOutcome::Presented)
    }
}

#[test]
fn backend_can_be_replaced_without_changing_scene_production() {
    let mut renderer: Box<dyn Renderer> = Box::<RecordingRenderer>::default();
    renderer.resize(RenderTargetSize::new(1280, 720));
    renderer.set_scale_factor(2.0);

    assert!(matches!(
        renderer.render_scene(&UiScene::new(Color::TRANSPARENT)),
        Ok(RenderOutcome::Presented)
    ));
}
