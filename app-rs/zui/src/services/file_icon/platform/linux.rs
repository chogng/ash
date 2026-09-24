use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;

use gio::prelude::Cast;
use gio::prelude::FileExt;
use gtk::gdk_pixbuf::Pixbuf;
use icon_loader::IconLoader as FreedesktopIconLoader;

use super::super::FileIconImage;
use super::super::FileIconRequest;
use super::super::FileIconSize;
use crate::services::SystemServiceError;

const FILE_ICON_SERVICE: &str = "file icon";

pub(super) fn load(request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
    let size = match request.size() {
        FileIconSize::Small => 16,
        FileIconSize::Normal => 32,
        FileIconSize::Large => 48,
    };
    let icon = file_icon(request.path())?;
    if let Some(file_icon) = icon.downcast_ref::<gio::FileIcon>()
        && let Some(path) = file_icon.file().path()
    {
        return decode_first([path], size);
    }
    if let Some(themed_icon) = icon.downcast_ref::<gio::ThemedIcon>() {
        let mut last_error = None;
        for name in themed_icon.names() {
            let Some(icon) = icon_loader().load_icon(name.as_str()) else {
                continue;
            };
            let preferred = icon.file_for_size(size as u16).path().to_owned();
            let candidates = std::iter::once(preferred)
                .chain(icon.files().iter().map(|file| file.path().to_owned()));
            match decode_first(candidates, size) {
                Ok(image) => return Ok(image),
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Err(backend_error(
        "the desktop icon theme has no rasterizable icon for this file type",
    ))
}

fn file_icon(path: &Path) -> Result<gio::Icon, SystemServiceError> {
    if path.exists() {
        let file = gio::File::for_path(path);
        if let Ok(info) = file.query_info(
            "standard::icon",
            gio::FileQueryInfoFlags::NONE,
            None::<&gio::Cancellable>,
        ) && let Some(icon) = info.icon()
        {
            return Ok(icon);
        }
    }
    let (content_type, _) = gio::content_type_guess(Some(path), &[]);
    Ok(gio::content_type_get_icon(content_type.as_str()))
}

fn icon_loader() -> &'static FreedesktopIconLoader {
    static ICON_LOADER: OnceLock<FreedesktopIconLoader> = OnceLock::new();
    ICON_LOADER.get_or_init(|| FreedesktopIconLoader::new_gtk().unwrap_or_default())
}

fn decode_first(
    candidates: impl IntoIterator<Item = PathBuf>,
    size: i32,
) -> Result<FileIconImage, SystemServiceError> {
    let mut last_error = None;
    let mut visited = Vec::new();
    for path in candidates {
        if visited.contains(&path) {
            continue;
        }
        visited.push(path.clone());
        match Pixbuf::from_file_at_scale(&path, size, size, false) {
            Ok(pixbuf) => return pixbuf_image(&pixbuf),
            Err(source) => last_error = Some(format!("{}: {source}", path.display())),
        }
    }
    Err(backend_error_owned(last_error.unwrap_or_else(|| {
        "the selected desktop icon has no image files".to_owned()
    })))
}

fn pixbuf_image(pixbuf: &Pixbuf) -> Result<FileIconImage, SystemServiceError> {
    let width = usize::try_from(pixbuf.width())
        .ok()
        .filter(|width| *width != 0)
        .ok_or_else(|| backend_error("GdkPixbuf returned an invalid icon width"))?;
    let height = usize::try_from(pixbuf.height())
        .ok()
        .filter(|height| *height != 0)
        .ok_or_else(|| backend_error("GdkPixbuf returned an invalid icon height"))?;
    let channels = usize::try_from(pixbuf.n_channels())
        .ok()
        .filter(|channels| matches!(channels, 3 | 4))
        .ok_or_else(|| backend_error("GdkPixbuf returned an unsupported channel count"))?;
    let row_stride = usize::try_from(pixbuf.rowstride())
        .map_err(|_| backend_error("GdkPixbuf returned an invalid row stride"))?;
    let bytes = pixbuf.read_pixel_bytes();
    let bytes = bytes.as_ref();
    let required = row_stride
        .checked_mul(height.saturating_sub(1))
        .and_then(|prefix| prefix.checked_add(width * channels))
        .ok_or_else(|| backend_error("GdkPixbuf icon dimensions overflow"))?;
    if bytes.len() < required {
        return Err(backend_error("GdkPixbuf returned truncated icon pixels"));
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = &bytes[y * row_stride..y * row_stride + width * channels];
        for pixel in row.chunks_exact(channels) {
            rgba.extend_from_slice(&pixel[..3]);
            rgba.push(if channels == 4 { pixel[3] } else { 255 });
        }
    }
    FileIconImage::from_rgba(rgba, width as u32, height as u32)
        .map_err(|source| SystemServiceError::backend(FILE_ICON_SERVICE, source))
}

fn backend_error(message: &'static str) -> SystemServiceError {
    SystemServiceError::backend(FILE_ICON_SERVICE, std::io::Error::other(message))
}

fn backend_error_owned(message: String) -> SystemServiceError {
    SystemServiceError::backend(FILE_ICON_SERVICE, std::io::Error::other(message))
}
