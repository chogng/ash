use super::top_line;
use crate::render::RenderContext;
use crate::render::RenderTheme;
use crate::render::ThemePalette;
use crate::render::ThemeRgb;
use crate::status::model::StatusLineSegment;
use ash_terminal_detection::ColorLevel;
use ratatui::style::Color;

#[test]
fn git_diff_statistics_use_the_theme_marker_colors() {
    let mut palette = ThemePalette::dark();
    palette.inserted_marker = ThemeRgb::from_hex("#010203");
    palette.removed_marker = ThemeRgb::from_hex("#040506");
    let theme = RenderTheme::from_palette(palette, ColorLevel::TrueColor);
    let context = RenderContext::new(&theme, 1);
    let line = top_line(
        vec![
            StatusLineSegment::inserted("+14"),
            StatusLineSegment::chrome(" "),
            StatusLineSegment::removed("-3"),
        ],
        context,
    );

    assert_eq!(line.spans[0].content, "+14");
    assert_eq!(line.spans[0].style.fg, Some(context.inserted_marker()));
    assert_eq!(line.spans[1].content, " ");
    assert_eq!(line.spans[1].style.fg, Some(context.chat_input_chrome()));
    assert_eq!(line.spans[2].content, "-3");
    assert_eq!(line.spans[2].style.fg, Some(context.removed_marker()));
    assert_eq!(context.inserted_marker(), Color::Rgb(1, 2, 3));
    assert_eq!(context.removed_marker(), Color::Rgb(4, 5, 6));
}

#[test]
fn expressive_status_line_renders_emoji_bars_and_permission_text() {
    use crate::status::StatusLineItem;
    use crate::status::StatusLineModel;
    use crate::status::StatusLineRuntime;
    use crate::status::StatusLineSettings;
    use crate::status::StatusLineStyle;
    let mut settings = StatusLineSettings::default();
    for item in StatusLineItem::ALL {
        settings.set(
            item,
            matches!(item, StatusLineItem::Permissions | StatusLineItem::Model),
        );
    }
    settings.set_style(StatusLineStyle::Rich);
    let mut model = StatusLineModel::new();
    model.apply_settings(settings);
    model.apply_model_label("model");
    let runtime = StatusLineRuntime {
        plan: Some((1, 3)),
        ..Default::default()
    };
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(48, 2)).unwrap();
    terminal
        .draw(|frame| {
            super::draw(
                frame,
                frame.area(),
                &model,
                ash_protocol::ApprovalMode::AskPermissions.into(),
                runtime,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rows: Vec<String> = (0..2)
        .map(|y| {
            (0..48)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect();
    crate::tui_assert_snapshot!("expressive_status_line", rows.join("\n"));
    let progress = model.top_segments_for_width(48, runtime);
    let rendered = top_line(progress, crate::render::test_context());
    assert!(rendered.spans.iter().any(|span| span.content == "███"
        && span.style.fg == Some(crate::render::test_context().accent())));
}
