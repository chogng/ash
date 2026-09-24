use cosmic_text::Weight;

use super::shaping_weight;
use crate::ui::text::FontWeight;

#[test]
fn semantic_font_weights_map_to_distinct_shaping_weights() {
    assert_eq!(shaping_weight(FontWeight::Normal), Weight::NORMAL);
    assert_eq!(shaping_weight(FontWeight::Medium), Weight::MEDIUM);
    assert_eq!(shaping_weight(FontWeight::SemiBold), Weight::SEMIBOLD);
    assert_eq!(shaping_weight(FontWeight::Bold), Weight::BOLD);
}
