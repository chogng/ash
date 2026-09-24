#![allow(unsafe_code)]

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::ptr;
use std::ptr::NonNull;
use std::slice;

use objc2::ClassType;
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSBitmapFormat;
use objc2_app_kit::NSBitmapImageRep;
use objc2_app_kit::NSCompositingOperation;
use objc2_app_kit::NSDeviceRGBColorSpace;
use objc2_app_kit::NSGraphicsContext;
use objc2_app_kit::NSImage;
use objc2_app_kit::NSImageInterpolation;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::CGPoint;
use objc2_foundation::CGRect;
use objc2_foundation::CGSize;
use objc2_foundation::NSURL;

use super::super::FileIconImage;
use super::super::FileIconRequest;
use super::super::FileIconSize;
use crate::services::SystemServiceError;

const FILE_ICON_SERVICE: &str = "file icon";

pub(super) fn load(request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
    let size = match request.size() {
        FileIconSize::Small => 16,
        FileIconSize::Normal => 32,
        FileIconSize::Large => return Err(SystemServiceError::unsupported(FILE_ICON_SERVICE)),
    };
    autoreleasepool(|_| load_in_pool(request, size))
}

fn load_in_pool(
    request: &FileIconRequest,
    size: usize,
) -> Result<FileIconImage, SystemServiceError> {
    let representation = CString::new(request.path().as_os_str().as_bytes())
        .map_err(|source| SystemServiceError::invalid_input(FILE_ICON_SERVICE, source))?;
    let pointer = NonNull::new(representation.as_ptr().cast_mut())
        .expect("CString always exposes a non-null representation");
    // SAFETY: The filesystem representation remains live and NUL terminated throughout URL
    // creation. NSURL and the returned path retain their own Objective-C storage.
    let path = unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            pointer,
            request.path().is_dir(),
            None,
        )
        .path()
    }
    .ok_or_else(|| backend_error("NSURL did not expose a filesystem path"))?;
    // SAFETY: NSWorkspace documents this lookup as thread-safe. The retained NSString and image
    // outlive all drawing performed in this autorelease pool.
    let image = unsafe { NSWorkspace::sharedWorkspace().iconForFile(&path) };
    rasterize(&image, size)
}

fn rasterize(image: &NSImage, size: usize) -> Result<FileIconImage, SystemServiceError> {
    let dimension = isize::try_from(size).expect("file icon dimensions fit NSInteger");
    let bytes_per_row = dimension * 4;
    // SAFETY: A null plane array asks AppKit to allocate packed 8-bit premultiplied RGBA storage.
    // AppKit drawing contexts require premultiplied alpha for four-channel bitmap targets.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            ptr::null_mut(),
            dimension,
            dimension,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            NSBitmapFormat::empty(),
            bytes_per_row,
            32,
        )
    }
    .ok_or_else(|| backend_error("NSBitmapImageRep could not allocate RGBA storage"))?;
    // SAFETY: The bitmap representation is live and compatible with an offscreen AppKit graphics
    // context for the duration of the drawing operation.
    let context = unsafe { NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap) }
        .ok_or_else(|| backend_error("NSGraphicsContext could not target the icon bitmap"))?;
    let frame = CGRect::new(CGPoint::ZERO, CGSize::new(size as f64, size as f64));
    // SAFETY: Saving/restoring the current graphics state balances the temporary offscreen
    // context. NSImage draws synchronously into the live bitmap representation.
    unsafe {
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        context.setImageInterpolation(NSImageInterpolation::High);
        image.drawInRect_fromRect_operation_fraction(
            frame,
            CGRect::ZERO,
            NSCompositingOperation::Copy,
            1.0,
        );
        context.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
    }

    let row_length = size * 4;
    let allocation_length = row_length * size;
    // SAFETY: NSBitmapImageRep owns at least bytesPerRow * pixelsHigh bytes until `bitmap` drops.
    // The format is packed premultiplied RGBA8. AppKit bitmap rows use a bottom-left origin, so
    // rows are reversed and colors are unpremultiplied for the top-left-oriented ZUI image.
    let source = unsafe { slice::from_raw_parts(bitmap.bitmapData(), allocation_length) };
    let mut rgba = vec![0; allocation_length];
    for destination_y in 0..size {
        let source_y = size - destination_y - 1;
        rgba[destination_y * row_length..(destination_y + 1) * row_length]
            .copy_from_slice(&source[source_y * row_length..(source_y + 1) * row_length]);
    }
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = pixel[3];
        for channel in &mut pixel[..3] {
            *channel = unpremultiply(*channel, alpha);
        }
    }
    FileIconImage::from_rgba(rgba, size as u32, size as u32)
        .map_err(|source| SystemServiceError::backend(FILE_ICON_SERVICE, source))
}

fn unpremultiply(channel: u8, alpha: u8) -> u8 {
    if alpha == 0 {
        0
    } else {
        ((u32::from(channel) * 255 + u32::from(alpha) / 2) / u32::from(alpha)).min(255) as u8
    }
}

fn backend_error(message: &'static str) -> SystemServiceError {
    SystemServiceError::backend(FILE_ICON_SERVICE, std::io::Error::other(message))
}
