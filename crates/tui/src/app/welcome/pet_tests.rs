use ash_sprite::Rgb;
use ash_sprite::SpriteCell;
use ash_sprite::TerminalSprite;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::widgets::Widget;

#[test]
fn generated_pet_cells_preserve_the_authored_terminal_instructions() {
    crate::tui_assert_snapshot!("welcome_pet_terminal_cells", pet_cell_map(super::sprite()));
}

#[test]
fn background_colored_spaces_are_rendered() {
    let cells = [SpriteCell::new(' ', None, Some(Rgb::new(0x40, 0x85, 0xac)))];
    let sprite = TerminalSprite::new(1, 1, &cells);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 1, 1));

    super::PetWidget::new(sprite).render(buffer.area, &mut buffer);

    assert_eq!(buffer[(0, 0)].symbol(), " ");
    assert_eq!(buffer[(0, 0)].bg, Color::Rgb(0x40, 0x85, 0xac));
}

#[test]
fn generated_pet_frames_and_click_timing_match_the_design() {
    let sheet = super::sheet();
    let frames = sheet
        .frames()
        .iter()
        .map(|frame| format!("{}\n{}", frame.name(), pet_cell_map(frame.sprite())))
        .collect::<Vec<_>>()
        .join("\n\n");
    let click = sheet
        .actions()
        .iter()
        .find(|action| action.name() == "click")
        .unwrap();
    let timing = click
        .steps()
        .iter()
        .map(|step| {
            format!(
                "{} {}ms",
                sheet.frames()[usize::from(step.frame_index())].name(),
                step.duration_ms()
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(timing, ["press 75ms", "rise 100ms", "land 100ms"]);
    crate::tui_assert_snapshot!("welcome_pet_animation_frames", frames);
}

fn pet_cell_map(sprite: TerminalSprite<'_>) -> String {
    let symbols = cell_rows(sprite, |cell| match cell.symbol() {
        ' ' => '.',
        symbol => symbol,
    });
    let foreground = cell_rows(sprite, |cell| color_symbol(cell.foreground()));
    let background = cell_rows(sprite, |cell| color_symbol(cell.background()));
    format!("symbols\n{symbols}\nforeground\n{foreground}\nbackground\n{background}")
}

fn cell_rows(sprite: TerminalSprite<'_>, value: impl Fn(SpriteCell) -> char) -> String {
    sprite
        .cells()
        .chunks_exact(usize::from(sprite.width()))
        .map(|row| row.iter().copied().map(&value).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn color_symbol(color: Option<Rgb>) -> char {
    match color {
        None => '.',
        Some(color) if color.components() == [0x40, 0x85, 0xac] => 'B',
        Some(color) if color.components() == [0, 0, 0] => 'K',
        Some(color) => panic!("unexpected pet color {color:?}"),
    }
}
