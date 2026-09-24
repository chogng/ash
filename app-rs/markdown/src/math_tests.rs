use zui::ui::Color;

use super::{MarkdownMathError, MarkdownMathMode, render_markdown_math};

#[test]
fn typesets_latex_fraction_into_non_empty_rgba_pixels() {
    let image = render_markdown_math(
        r"\frac{1}{x^2}",
        MarkdownMathMode::Display,
        Color::rgb(30, 40, 50),
        20.0,
    )
    .unwrap();

    assert!(image.width() > 1);
    assert!(image.height() > 1);
    assert!(image.rgba8().chunks_exact(4).any(|pixel| pixel[3] > 0));
}

#[test]
fn rejects_invalid_latex_without_panicking() {
    assert!(matches!(
        render_markdown_math(
            r"\frac{",
            MarkdownMathMode::Inline,
            Color::rgb(0, 0, 0),
            16.0
        ),
        Err(MarkdownMathError::Parse(_))
    ));
}
