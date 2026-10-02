use super::*;
use assets::Assets;
use assets::ImportRequest;
use std::sync::Arc;

const ASSET: &str = "11111111-1111-4111-8111-111111111111";
const FIRST: &str = "22222222-2222-4222-8222-222222222222";
const SECOND: &str = "33333333-3333-4333-8333-333333333333";
const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 244, 34, 127, 138, 0, 0, 0, 14, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 4,
    1, 16, 248, 3, 253, 78, 149, 193, 111, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn request(version: &str) -> ImportRequest {
    ImportRequest {
        asset_id: ASSET.into(),
        version_id: version.into(),
        name: "product.png".into(),
        source: "file:///product.png".into(),
        size: PNG.len(),
    }
}

fn publish(assets: &Assets, owner: u64, version: &str) -> AssetVersion {
    assets.start(owner, request(version)).unwrap();
    assets.write(owner, version, 0, PNG).unwrap();
    assets.finish(owner, version).unwrap()
}

#[test]
fn original_content_and_exact_versions_survive_restart_and_are_shared_across_connections() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let assets = Assets::new(Arc::new(SqliteAssetStore::open(&path).unwrap()));
    let first = publish(&assets, 1, FIRST);
    assert_eq!(
        (first.width, first.height, first.media_type),
        (2, 1, assets::ImageType::Png)
    );
    assert_eq!(publish(&assets, 2, FIRST), first);
    let second = publish(&assets, 2, SECOND);
    assert_eq!(second.asset_id, first.asset_id);
    assets.close_owner(1);
    drop(assets);
    let assets = Assets::new(Arc::new(SqliteAssetStore::open(&path).unwrap()));
    assert_eq!(assets.get(ASSET, FIRST).unwrap(), first);
    assert_eq!(assets.get(ASSET, SECOND).unwrap(), second);
    assert_eq!(assets.read(ASSET, FIRST, 0, 13).unwrap(), PNG[..13]);
    assert_eq!(assets.read(ASSET, FIRST, 13, PNG.len()).unwrap(), PNG[13..]);
    assert!(assets.read(ASSET, FIRST, PNG.len(), 10).unwrap().is_empty());
    assert!(matches!(
        assets.read(ASSET, FIRST, PNG.len() + 1, 10),
        Err(AssetError::Invalid)
    ));
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM asset_contents", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM asset_versions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn uploads_enforce_owner_order_capacity_and_cancel_without_publishing() {
    let temp = tempfile::tempdir().unwrap();
    let assets = Assets::new(Arc::new(
        SqliteAssetStore::open(&temp.path().join("state.sqlite")).unwrap(),
    ));
    assets.start(1, request(FIRST)).unwrap();
    assert!(matches!(
        assets.start(1, request(FIRST)),
        Err(AssetError::Conflict)
    ));
    assert!(matches!(
        assets.write(2, FIRST, 0, PNG),
        Err(AssetError::NotFound)
    ));
    assert!(matches!(assets.cancel(2, FIRST), Err(AssetError::NotFound)));
    assert!(matches!(
        assets.write(1, FIRST, 1, PNG),
        Err(AssetError::Invalid)
    ));
    assert!(matches!(assets.finish(1, FIRST), Err(AssetError::Invalid)));
    assets.write(1, FIRST, 0, &PNG[..10]).unwrap();
    assets.cancel(1, FIRST).unwrap();
    assert!(matches!(
        assets.get(ASSET, FIRST),
        Err(AssetError::NotFound)
    ));
    assets.start(1, request(FIRST)).unwrap();
    assets.close_owner(1);
    assert!(matches!(
        assets.write(1, FIRST, 0, PNG),
        Err(AssetError::NotFound)
    ));
    for index in 0..4 {
        let version = format!("44444444-4444-4444-8444-{index:012}");
        assets.start(1, request(&version)).unwrap();
    }
    assert!(matches!(
        assets.start(1, request(FIRST)),
        Err(AssetError::Capacity)
    ));
    assets.close_owner(1);
    let mut invalid_source = request(FIRST);
    invalid_source.source = "not a URI".into();
    assert!(matches!(
        assets.start(1, invalid_source),
        Err(AssetError::Invalid)
    ));
    let mut large = request(FIRST);
    large.size = assets::MAX_ASSET_BYTES + 1;
    assert!(matches!(assets.start(1, large), Err(AssetError::Invalid)));
}

#[test]
fn invalid_images_and_conflicting_receipts_cannot_change_a_published_version() {
    let temp = tempfile::tempdir().unwrap();
    let assets = Assets::new(Arc::new(
        SqliteAssetStore::open(&temp.path().join("state.sqlite")).unwrap(),
    ));
    let first = publish(&assets, 1, FIRST);
    let mut changed = request(FIRST);
    changed.source = "file:///other.png".into();
    assets.start(1, changed).unwrap();
    assets.write(1, FIRST, 0, PNG).unwrap();
    assert!(matches!(assets.finish(1, FIRST), Err(AssetError::Conflict)));
    assert_eq!(assets.get(ASSET, FIRST).unwrap(), first);
    assets.start(1, request(SECOND)).unwrap();
    assets.write(1, SECOND, 0, &vec![0; PNG.len()]).unwrap();
    assert!(matches!(
        assets.finish(1, SECOND),
        Err(AssetError::InvalidImage)
    ));
    assert!(matches!(
        assets.get(ASSET, SECOND),
        Err(AssetError::NotFound)
    ));
}

#[test]
fn jpeg_webp_and_oriented_jpeg_keep_original_bytes_and_report_display_dimensions() {
    let temp = tempfile::tempdir().unwrap();
    let assets = Assets::new(Arc::new(
        SqliteAssetStore::open(&temp.path().join("state.sqlite")).unwrap(),
    ));
    for (index, format, media_type) in [
        (5, image::ImageFormat::Jpeg, assets::ImageType::Jpeg),
        (6, image::ImageFormat::WebP, assets::ImageType::Webp),
    ] {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(3, 2, image::Rgb([255, 0, 0]))
            .write_to(&mut encoded, format)
            .unwrap();
        let mut bytes = encoded.into_inner();
        if format == image::ImageFormat::Jpeg {
            // An EXIF orientation of 6 rotates display by 90 degrees; the original JPEG stays intact.
            let exif = [
                b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0,
                1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
            ];
            let mut oriented = vec![255, 216, 255, 225, 0, 34];
            oriented.extend_from_slice(&exif);
            oriented.extend_from_slice(&bytes[2..]);
            bytes = oriented;
        }
        let id = format!("55555555-5555-4555-8555-{index:012}");
        let mut input = request(&id);
        input.size = bytes.len();
        assets.start(1, input).unwrap();
        assets.write(1, &id, 0, &bytes).unwrap();
        let version = assets.finish(1, &id).unwrap();
        assert_eq!(version.media_type, media_type);
        assert_eq!(
            (version.width, version.height),
            if format == image::ImageFormat::Jpeg {
                (2, 3)
            } else {
                (3, 2)
            }
        );
        assert_eq!(assets.read(ASSET, &id, 0, bytes.len()).unwrap(), bytes);
    }
}
