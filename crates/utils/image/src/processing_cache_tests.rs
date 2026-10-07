use std::num::NonZeroUsize;

use super::EncodedImage;
use super::ImageCache;
use super::ImageCacheKey;
use super::PromptImageMode;
use super::PromptImagePolicy;
use super::cache_image;

#[tokio::test(flavor = "multi_thread")]
async fn bounds_the_image_cache_by_encoded_byte_size() {
    let cache = ImageCache::new(NonZeroUsize::new(4).expect("non-zero cache capacity"));
    let key = |digest_byte| ImageCacheKey {
        digest: [digest_byte; 32],
        policy: PromptImagePolicy::for_mode(PromptImageMode::Original),
    };
    let image = |size| EncodedImage {
        bytes: vec![0; size].into(),
        mime: "image/png",
        source_width: 1,
        source_height: 1,
        source_frames: 1,
        width: 1,
        height: 1,
    };

    cache_image(&cache, key(1), image(3), 5);
    cache_image(&cache, key(2), image(3), 5);
    cache_image(&cache, key(3), image(6), 5);

    assert!(cache.get(&key(1)).is_none());
    assert!(cache.get(&key(2)).is_some());
    assert!(cache.get(&key(3)).is_none());
}
