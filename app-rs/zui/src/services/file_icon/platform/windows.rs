#![allow(unsafe_code)]

use std::ffi::OsString;
use std::mem::size_of;
use std::mem::zeroed;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::slice;

use windows_sys::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows_sys::Win32::Graphics::Gdi::BI_RGB;
use windows_sys::Win32::Graphics::Gdi::BITMAPINFO;
use windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER;
use windows_sys::Win32::Graphics::Gdi::CreateCompatibleDC;
use windows_sys::Win32::Graphics::Gdi::CreateDIBSection;
use windows_sys::Win32::Graphics::Gdi::DIB_RGB_COLORS;
use windows_sys::Win32::Graphics::Gdi::DeleteDC;
use windows_sys::Win32::Graphics::Gdi::DeleteObject;
use windows_sys::Win32::Graphics::Gdi::HBITMAP;
use windows_sys::Win32::Graphics::Gdi::HDC;
use windows_sys::Win32::Graphics::Gdi::HGDIOBJ;
use windows_sys::Win32::Graphics::Gdi::RGBQUAD;
use windows_sys::Win32::Graphics::Gdi::SelectObject;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows_sys::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows_sys::Win32::System::Com::CoInitializeEx;
use windows_sys::Win32::System::Com::CoUninitialize;
use windows_sys::Win32::UI::Shell::SHFILEINFOW;
use windows_sys::Win32::UI::Shell::SHGFI_ICON;
use windows_sys::Win32::UI::Shell::SHGFI_LARGEICON;
use windows_sys::Win32::UI::Shell::SHGFI_SMALLICON;
use windows_sys::Win32::UI::Shell::SHGFI_USEFILEATTRIBUTES;
use windows_sys::Win32::UI::Shell::SHGetFileInfoW;
use windows_sys::Win32::UI::WindowsAndMessaging::DI_NORMAL;
use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
use windows_sys::Win32::UI::WindowsAndMessaging::DrawIconEx;
use windows_sys::Win32::UI::WindowsAndMessaging::HICON;

use super::super::FileIconImage;
use super::super::FileIconRequest;
use super::super::FileIconSize;
use crate::services::SystemServiceError;

const FILE_ICON_SERVICE: &str = "file icon";

pub(super) fn load(request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
    let size = match request.size() {
        FileIconSize::Small => 16,
        FileIconSize::Normal | FileIconSize::Large => 32,
    };
    let _apartment = ComApartment::enter()?;
    let icon = associated_icon(request, size)?;
    let rgba = rasterize(icon.0, size)?;
    FileIconImage::from_rgba(rgba, size as u32, size as u32)
        .map_err(|source| SystemServiceError::backend(FILE_ICON_SERVICE, source))
}

struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    fn enter() -> Result<Self, SystemServiceError> {
        // SAFETY: This initializes COM only for the current worker thread. A successful call is
        // balanced by Drop; an existing apartment with a different model remains untouched.
        let result = unsafe { CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if result < 0 && result != RPC_E_CHANGED_MODE {
            return Err(SystemServiceError::backend(
                FILE_ICON_SERVICE,
                std::io::Error::from_raw_os_error(result),
            ));
        }
        Ok(Self {
            initialized: result >= 0,
        })
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: This balances CoInitializeEx on the same worker thread.
            unsafe { CoUninitialize() };
        }
    }
}

struct OwnedIcon(HICON);

impl Drop for OwnedIcon {
    fn drop(&mut self) {
        // SAFETY: SHGetFileInfoW transferred exclusive ownership of this icon handle.
        unsafe { DestroyIcon(self.0) };
    }
}

fn associated_icon(
    request: &FileIconRequest,
    size: usize,
) -> Result<OwnedIcon, SystemServiceError> {
    let embedded = request
        .path()
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["exe", "dll", "ico"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        });
    if embedded
        && request.path().is_file()
        && let Some(icon) = query_icon(request.path().as_os_str().to_owned(), size, false)
    {
        return Ok(icon);
    }
    let extension = request
        .path()
        .extension()
        .map(|extension| {
            let mut group = OsString::from(".");
            group.push(extension);
            group
        })
        .unwrap_or_default();
    query_icon(extension, size, true).ok_or_else(|| {
        SystemServiceError::backend(FILE_ICON_SERVICE, std::io::Error::last_os_error())
    })
}

fn query_icon(group: OsString, size: usize, use_file_attributes: bool) -> Option<OwnedIcon> {
    let group = group
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: SHFILEINFOW is a plain C output structure and zero is a valid initial state.
    let mut info: SHFILEINFOW = unsafe { zeroed() };
    let mut flags = SHGFI_ICON
        | if size == 16 {
            SHGFI_SMALLICON
        } else {
            SHGFI_LARGEICON
        };
    if use_file_attributes {
        flags |= SHGFI_USEFILEATTRIBUTES;
    }
    // SAFETY: `group` is live NUL-terminated UTF-16 and `info` is a writable output structure.
    let result = unsafe {
        SHGetFileInfoW(
            group.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    (result != 0 && !info.hIcon.is_null()).then_some(OwnedIcon(info.hIcon))
}

fn rasterize(icon: HICON, size: usize) -> Result<Vec<u8>, SystemServiceError> {
    let black = DibSurface::draw(icon, size, [0, 0, 0, 255])?;
    let white = DibSurface::draw(icon, size, [255, 255, 255, 255])?;
    let mut rgba = vec![0; size * size * 4];
    for pixel in 0..size * size {
        let offset = pixel * 4;
        let blue_difference = white[offset].saturating_sub(black[offset]);
        let green_difference = white[offset + 1].saturating_sub(black[offset + 1]);
        let red_difference = white[offset + 2].saturating_sub(black[offset + 2]);
        let transparency = blue_difference.max(green_difference).max(red_difference);
        let alpha = 255_u8.saturating_sub(transparency);
        rgba[offset] = recover_channel(black[offset + 2], alpha);
        rgba[offset + 1] = recover_channel(black[offset + 1], alpha);
        rgba[offset + 2] = recover_channel(black[offset], alpha);
        rgba[offset + 3] = alpha;
    }
    Ok(rgba)
}

fn recover_channel(premultiplied: u8, alpha: u8) -> u8 {
    if alpha == 0 {
        0
    } else {
        ((u32::from(premultiplied) * 255 + u32::from(alpha) / 2) / u32::from(alpha)).min(255) as u8
    }
}

struct DibSurface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    length: usize,
}

impl DibSurface {
    fn draw(icon: HICON, size: usize, background: [u8; 4]) -> Result<Vec<u8>, SystemServiceError> {
        let surface = Self::new(size)?;
        // SAFETY: The DIB allocation contains exactly `length` writable bytes until surface drop.
        let pixels = unsafe { slice::from_raw_parts_mut(surface.bits, surface.length) };
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&background);
        }
        // SAFETY: The icon, memory DC, and selected square DIB remain live for this synchronous
        // draw. Windows scales the source icon to the requested logical dimensions.
        let drawn = unsafe {
            DrawIconEx(
                surface.dc,
                0,
                0,
                icon,
                size as i32,
                size as i32,
                0,
                ptr::null_mut(),
                DI_NORMAL,
            )
        };
        if drawn == 0 {
            return Err(SystemServiceError::backend(
                FILE_ICON_SERVICE,
                std::io::Error::last_os_error(),
            ));
        }
        Ok(pixels.to_vec())
    }

    fn new(size: usize) -> Result<Self, SystemServiceError> {
        // SAFETY: A null source creates a memory device context compatible with the current
        // display and transfers ownership to the caller.
        let dc = unsafe { CreateCompatibleDC(ptr::null_mut()) };
        if dc.is_null() {
            return Err(last_os_error("CreateCompatibleDC"));
        }
        let length = size * size * 4;
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size as i32,
                biHeight: -(size as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: length as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }],
        };
        let mut bits = ptr::null_mut();
        // SAFETY: `info` describes a top-down 32-bit DIB and the output slot is valid.
        let bitmap =
            unsafe { CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, ptr::null_mut(), 0) };
        if bitmap.is_null() || bits.is_null() {
            // SAFETY: The memory DC is owned and contains no selected owned bitmap yet.
            unsafe { DeleteDC(dc) };
            return Err(last_os_error("CreateDIBSection"));
        }
        // SAFETY: Both handles are live and the bitmap remains selected until Drop restores the
        // previous object.
        let previous = unsafe { SelectObject(dc, bitmap) };
        if previous.is_null() {
            // SAFETY: Neither handle escaped and the bitmap was not selected successfully.
            unsafe {
                DeleteObject(bitmap);
                DeleteDC(dc);
            }
            return Err(last_os_error("SelectObject"));
        }
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            length,
        })
    }
}

impl Drop for DibSurface {
    fn drop(&mut self) {
        // SAFETY: The previous object belongs to the DC, and both owned GDI handles are released
        // only after the bitmap is no longer selected.
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

fn last_os_error(operation: &'static str) -> SystemServiceError {
    let source = std::io::Error::last_os_error();
    SystemServiceError::backend(
        FILE_ICON_SERVICE,
        std::io::Error::other(format!("{operation} failed: {source}")),
    )
}
