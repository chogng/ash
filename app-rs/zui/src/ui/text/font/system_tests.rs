#![cfg(target_os = "macos")]

use cosmic_text::{Attrs, Buffer, Family, Metrics, Shaping, SwashCache};

use super::new_font_system;

#[test]
fn excludes_the_macos_bitmap_face_that_swash_cannot_rasterize() {
    let font_system = new_font_system();

    assert!(
        font_system
            .db()
            .faces()
            .all(|face| face.post_script_name != "GB18030Bitmap")
    );
}

#[test]
fn uses_macos_system_font_families() {
    let font_system = new_font_system();

    assert_eq!(font_system.db().family_name(&Family::SansSerif), ".SF NS");
    assert_eq!(
        font_system.db().family_name(&Family::Monospace),
        ".SF NS Mono"
    );
}

#[test]
fn shapes_and_rasterizes_multilingual_fallback_glyphs() {
    let mut font_system = new_font_system();
    let mut swash_cache = SwashCache::new();
    let attrs = Attrs::new().family(Family::Monospace);
    for (name, text) in [
        ("simplified Chinese", "中文"),
        ("Japanese", "日本語"),
        ("Korean", "한국어"),
        ("combining mark", "e\u{301}"),
        ("Arabic", "مرحبا"),
        ("emoji", "🙂"),
    ] {
        let mut buffer = Buffer::new(&mut font_system, Metrics::new(26.0, 32.0));
        buffer.set_size(Some(500.0), Some(64.0));
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut font_system, false);
        let glyphs = buffer
            .layout_runs()
            .flat_map(|run| run.glyphs.iter().cloned())
            .collect::<Vec<_>>();

        assert!(!glyphs.is_empty(), "{name} produced no layout glyphs");
        for glyph in glyphs {
            assert_ne!(glyph.glyph_id, 0, "{name} retained a missing glyph");
            let physical = glyph.physical((0.0, 0.0), 1.0);
            let face_name = font_system
                .db()
                .face(glyph.font_id)
                .map(|face| face.post_script_name.clone())
                .unwrap_or_else(|| String::from("<missing face>"));
            let image = swash_cache
                .get_image_uncached(&mut font_system, physical.cache_key)
                .unwrap_or_else(|| {
                    panic!(
                        "{name} glyph {} in font {face_name} did not rasterize",
                        glyph.glyph_id
                    )
                });
            assert!(
                image.placement.width > 0 && image.placement.height > 0,
                "{name} glyph rasterized to an empty image"
            );
        }
    }
}
