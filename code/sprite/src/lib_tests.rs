use super::PackError;
use super::Rgb;
use super::octant_mask;
use super::pack_half_blocks_rgba;
use super::pack_octants_rgba;
use super::pack_quadrants_rgba;
use super::quadrant_symbol;

const BLUE: [u8; 4] = [0x40, 0x85, 0xac, 0xff];
const BLACK: [u8; 4] = [0, 0, 0, 0xff];
const CLEAR: [u8; 4] = [0, 0, 0, 0];

#[test]
fn transparent_half_blocks_preserve_the_silhouette() {
    let sprite = pack_half_blocks_rgba(1, 2, &[BLUE, CLEAR], 128).unwrap();
    let cell = sprite.as_sprite().cells()[0];

    assert_eq!(cell.symbol(), '▀');
    assert_eq!(cell.foreground(), Some(Rgb::new(0x40, 0x85, 0xac)));
    assert_eq!(cell.background(), None);
}

#[test]
fn two_opaque_colors_use_foreground_and_background() {
    let sprite = pack_half_blocks_rgba(1, 2, &[BLUE, BLACK], 128).unwrap();
    let cell = sprite.as_sprite().cells()[0];

    assert_eq!(cell.symbol(), '▀');
    assert_eq!(cell.foreground(), Some(Rgb::new(0x40, 0x85, 0xac)));
    assert_eq!(cell.background(), Some(Rgb::new(0, 0, 0)));
}

#[test]
fn odd_source_dimensions_pad_with_transparency() {
    let sprite = pack_half_blocks_rgba(1, 1, &[BLUE], 128).unwrap();

    assert_eq!(sprite.as_sprite().width(), 1);
    assert_eq!(sprite.as_sprite().height(), 1);
    assert_eq!(sprite.as_sprite().cells()[0].symbol(), '▀');
}

#[test]
fn horizontal_pixels_keep_their_original_columns() {
    let sprite = pack_half_blocks_rgba(2, 2, &[BLUE, CLEAR, BLUE, CLEAR], 128).unwrap();

    assert_eq!(sprite.as_sprite().width(), 2);
    assert_eq!(sprite.as_sprite().height(), 1);
    assert_eq!(sprite.as_sprite().cells()[0].symbol(), '█');
    assert_eq!(sprite.as_sprite().cells()[1].symbol(), ' ');
}

#[test]
fn half_block_cells_round_trip_every_source_pixel() {
    let source = [BLUE, BLACK, CLEAR, BLACK, BLUE, BLUE, CLEAR, BLACK, BLUE];
    let sprite = pack_half_blocks_rgba(3, 3, &source, 128).unwrap();
    let decoded = sprite
        .as_sprite()
        .cells()
        .iter()
        .flat_map(|cell| match cell.symbol() {
            ' ' => [cell.background(), cell.background()],
            '▀' => [cell.foreground(), cell.background()],
            '▄' => [cell.background(), cell.foreground()],
            '█' => [cell.foreground(), cell.foreground()],
            symbol => panic!("unexpected half-block symbol {symbol}"),
        })
        .collect::<Vec<_>>();
    let decoded = (0..3)
        .flat_map(|source_y| {
            let cell_y = source_y / 2;
            (0..3).map({
                let decoded = &decoded;
                move |x| decoded[(cell_y * 3 + x) * 2 + source_y % 2]
            })
        })
        .collect::<Vec<_>>();
    let expected = source
        .into_iter()
        .map(|pixel| (pixel[3] >= 128).then(|| Rgb::new(pixel[0], pixel[1], pixel[2])))
        .collect::<Vec<_>>();

    assert_eq!(decoded, expected);
}

#[test]
fn pixel_count_must_match_the_source_dimensions() {
    let error = pack_half_blocks_rgba(2, 2, &[BLUE], 128).unwrap_err();

    assert_eq!(
        error,
        PackError::PixelCount {
            expected: 4,
            actual: 1,
        }
    );
}

#[test]
fn quadrant_cells_preserve_diagonal_logical_pixels() {
    let sprite = pack_quadrants_rgba(2, 2, &[BLUE, CLEAR, CLEAR, BLUE], 128).unwrap();
    let cell = sprite.as_sprite().cells()[0];

    assert_eq!(sprite.as_sprite().width(), 1);
    assert_eq!(sprite.as_sprite().height(), 1);
    assert_eq!(cell.symbol(), '▚');
    assert_eq!(cell.foreground(), Some(Rgb::new(0x40, 0x85, 0xac)));
    assert_eq!(cell.background(), None);
}

#[test]
fn quadrant_cells_use_background_for_a_second_opaque_color() {
    let sprite = pack_quadrants_rgba(2, 2, &[BLACK, BLUE, BLUE, BLACK], 128).unwrap();
    let cell = sprite.as_sprite().cells()[0];

    assert_eq!(cell.symbol(), '▚');
    assert_eq!(cell.foreground(), Some(Rgb::new(0, 0, 0)));
    assert_eq!(cell.background(), Some(Rgb::new(0x40, 0x85, 0xac)));
}

#[test]
fn quadrant_cells_reject_two_opaque_colors_mixed_with_transparency() {
    let error = pack_quadrants_rgba(2, 2, &[BLACK, BLUE, CLEAR, CLEAR], 128).unwrap_err();

    assert_eq!(
        error,
        PackError::CellPalette {
            x: 0,
            y: 0,
            colors: 2,
        }
    );
}

#[test]
fn quadrant_masks_cover_every_unicode_block_combination() {
    assert_eq!(
        (0..16).map(quadrant_symbol).collect::<String>(),
        " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"
    );
}

#[test]
fn octant_cells_keep_a_16_by_16_source_at_8_by_4_terminal_cells() {
    let sprite = pack_octants_rgba(16, 16, &vec![BLUE; 16 * 16], 128).unwrap();

    assert_eq!(sprite.as_sprite().width(), 8);
    assert_eq!(sprite.as_sprite().height(), 4);
}

#[test]
fn octant_cells_round_trip_every_2_by_4_mask() {
    for mask in 0..=u8::MAX {
        let mut source = [CLEAR; 8];
        for (index, pixel) in source.iter_mut().enumerate() {
            if mask & (1 << index) != 0 {
                *pixel = BLUE;
            }
        }
        let sprite = pack_octants_rgba(2, 4, &source, 128).unwrap();
        let cell = sprite.as_sprite().cells()[0];

        assert_eq!(octant_mask(cell.symbol()), Some(mask), "mask {mask:#010b}");
    }
}

#[test]
fn octant_cells_use_foreground_and_background_for_two_opaque_colors() {
    let source = [BLACK, BLUE, BLUE, BLACK, BLACK, BLUE, BLUE, BLACK];
    let sprite = pack_octants_rgba(2, 4, &source, 128).unwrap();
    let cell = sprite.as_sprite().cells()[0];

    assert_eq!(octant_mask(cell.symbol()), Some(0b10011001));
    assert_eq!(cell.foreground(), Some(Rgb::new(0, 0, 0)));
    assert_eq!(cell.background(), Some(Rgb::new(0x40, 0x85, 0xac)));
}

#[test]
fn octant_cells_reject_two_opaque_colors_mixed_with_transparency() {
    let error = pack_octants_rgba(
        2,
        4,
        &[BLACK, BLUE, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR],
        128,
    )
    .unwrap_err();

    assert_eq!(
        error,
        PackError::CellPalette {
            x: 0,
            y: 0,
            colors: 2,
        }
    );
}
