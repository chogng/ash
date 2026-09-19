#![allow(unsafe_code)]

use std::os::raw::c_void;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::task::JoinHandle;

use core_graphics::display::CGDisplay;
use core_graphics::display::CGPoint;
use core_graphics::display::CGRect;
use core_graphics::display::CGSize;
use core_graphics::display::kCGWindowImageBestResolution;
use core_graphics::display::kCGWindowListExcludeDesktopElements;
use core_graphics::display::kCGWindowListOptionIncludingWindow;
use core_graphics::display::kCGWindowListOptionOnScreenOnly;
use core_graphics::image::CGImage;

use crate::CaptureError;
use crate::CaptureTarget;
use crate::CapturedFrame;
use crate::DisplayInfo;
use crate::PermissionStatus;
use crate::ScreenCaptureSource;
use crate::ScreenCaptureStream;
use crate::WindowInfo;

const K_CF_NUMBER_S_INT64_TYPE: i32 = 4;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(
        alloc: *const c_void,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        is_external_representation: bool,
    ) -> *const c_void;
    fn CFRelease(cf: *const c_void);
    fn CFDictionaryGetValueIfPresent(
        the_dict: *const c_void,
        key: *const c_void,
        value: *mut *const c_void,
    ) -> bool;
    fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    fn CFStringGetCString(
        the_string: *const c_void,
        buffer: *mut u8,
        buffer_size: isize,
        encoding: u32,
    ) -> bool;
}

pub fn check_permission() -> PermissionStatus {
    if unsafe { CGPreflightScreenCaptureAccess() } {
        PermissionStatus::Granted
    } else {
        PermissionStatus::Denied
    }
}

pub fn request_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    let ids = CGDisplay::active_displays()
        .map_err(|err| CaptureError::Backend(format!("failed to get active displays: {err}")))?;

    let mut displays = Vec::with_capacity(ids.len());
    for id in ids {
        let disp = CGDisplay::new(id);
        let bounds = disp.bounds();
        let pixel_width = disp.pixels_wide() as u32;
        let pixel_height = disp.pixels_high() as u32;
        let width = if pixel_width > 0 {
            pixel_width
        } else {
            bounds.size.width.max(1.0) as u32
        };
        let height = if pixel_height > 0 {
            pixel_height
        } else {
            bounds.size.height.max(1.0) as u32
        };
        let is_primary = disp.is_main();
        let title = if is_primary {
            format!("Display {id} (Main)")
        } else {
            format!("Display {id}")
        };

        displays.push(DisplayInfo {
            id: id.to_string(),
            title,
            width,
            height,
            is_primary,
        });
    }

    Ok(displays)
}

pub fn enumerate_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let cf_array = CGDisplay::window_list_info(options, None)
        .ok_or_else(|| CaptureError::Backend("failed to copy window list info".to_string()))?;

    let values = cf_array.get_all_values();
    let mut windows = Vec::with_capacity(values.len());

    for dict_ref in values {
        if dict_ref.is_null() {
            continue;
        }

        let layer = unsafe { get_i64_value(dict_ref, "kCGWindowLayer") }.unwrap_or(0);
        if layer != 0 {
            continue;
        }

        let id = match unsafe { get_i64_value(dict_ref, "kCGWindowNumber") } {
            Some(n) => n.to_string(),
            None => continue,
        };

        let app_name =
            unsafe { get_string_value(dict_ref, "kCGWindowOwnerName") }.unwrap_or_default();
        let title = unsafe { get_string_value(dict_ref, "kCGWindowName") }.unwrap_or_default();

        let mut rect = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(0.0, 0.0));
        let cf_bounds_key = unsafe { make_cf_string("kCGWindowBounds") };
        let mut bounds_val: *const c_void = ptr::null();
        let (width, height) = unsafe {
            let present = if !cf_bounds_key.is_null() {
                CFDictionaryGetValueIfPresent(dict_ref, cf_bounds_key, &mut bounds_val)
            } else {
                false
            };
            if !cf_bounds_key.is_null() {
                CFRelease(cf_bounds_key);
            }

            if present && !bounds_val.is_null() {
                if CGRectMakeWithDictionaryRepresentation(bounds_val, &mut rect) {
                    (
                        rect.size.width.max(0.0) as u32,
                        rect.size.height.max(0.0) as u32,
                    )
                } else {
                    (0, 0)
                }
            } else {
                (0, 0)
            }
        };

        if width == 0 || height == 0 {
            continue;
        }

        let is_on_screen =
            unsafe { get_bool_value(dict_ref, "kCGWindowIsOnscreen") }.unwrap_or(true);

        windows.push(WindowInfo {
            id,
            title,
            app_name,
            width,
            height,
            is_on_screen,
        });
    }

    Ok(windows)
}

pub fn create_display_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    let display_id: u32 = id
        .parse()
        .map_err(|_| CaptureError::NotFound(id.to_string()))?;
    let displays = enumerate_displays()?;
    let info = displays
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| CaptureError::NotFound(id.to_string()))?;

    Ok(Box::new(MacDisplaySource { info, display_id }))
}

pub fn create_window_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    let window_id: u32 = id
        .parse()
        .map_err(|_| CaptureError::NotFound(id.to_string()))?;
    let windows = enumerate_windows()?;
    let win = windows
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| CaptureError::NotFound(id.to_string()))?;

    let info = DisplayInfo {
        id: win.id.clone(),
        title: if win.title.is_empty() {
            win.app_name.clone()
        } else {
            format!("{}: {}", win.app_name, win.title)
        },
        width: win.width,
        height: win.height,
        is_primary: false,
    };

    Ok(Box::new(MacWindowSource {
        info,
        window_info: win,
        window_id,
    }))
}

pub struct MacDisplaySource {
    info: DisplayInfo,
    display_id: u32,
}

impl ScreenCaptureSource for MacDisplaySource {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }

    fn target(&self) -> CaptureTarget {
        CaptureTarget::Display(self.info.clone())
    }

    fn start_stream(
        &self,
        fps: u32,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    ) -> Result<Box<dyn ScreenCaptureStream>, CaptureError> {
        let display_id = self.display_id;
        start_capture_stream(fps, on_frame, move |timestamp| {
            capture_display_frame(display_id, timestamp)
        })
    }
}

pub struct MacWindowSource {
    info: DisplayInfo,
    window_info: WindowInfo,
    window_id: u32,
}

impl ScreenCaptureSource for MacWindowSource {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }

    fn target(&self) -> CaptureTarget {
        CaptureTarget::Window(self.window_info.clone())
    }

    fn start_stream(
        &self,
        fps: u32,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    ) -> Result<Box<dyn ScreenCaptureStream>, CaptureError> {
        let window_id = self.window_id;
        start_capture_stream(fps, on_frame, move |timestamp| {
            capture_window_frame(window_id, timestamp)
        })
    }
}

pub struct MacCaptureStream {
    active: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}

impl ScreenCaptureStream for MacCaptureStream {
    fn stop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for MacCaptureStream {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_capture_stream<F>(
    fps: u32,
    on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    capture_fn: F,
) -> Result<Box<dyn ScreenCaptureStream>, CaptureError>
where
    F: Fn(Duration) -> Result<CapturedFrame, CaptureError> + Send + Sync + 'static,
{
    let fps = fps.clamp(1, 60);
    let interval = Duration::from_secs_f64(1.0 / fps as f64);
    let active = Arc::new(AtomicBool::new(true));
    let active_clone = Arc::clone(&active);
    let start_time = Instant::now();

    let handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        while active_clone.load(Ordering::Relaxed) {
            ticker.tick().await;
            if !active_clone.load(Ordering::Relaxed) {
                break;
            }

            let timestamp = start_time.elapsed();
            match capture_fn(timestamp) {
                Ok(frame) => on_frame(frame),
                Err(CaptureError::PermissionDenied) => {
                    break;
                }
                Err(_) => {
                    // Transient capture errors (e.g. window resizing or occlusion)
                }
            }
        }
        active_clone.store(false, Ordering::SeqCst);
    });

    Ok(Box::new(MacCaptureStream {
        active,
        task: Some(handle),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capture_stream_reports_inactive_after_capture_ends() {
        let mut stream = start_capture_stream(60, Box::new(|_| {}), |_| {
            Err(CaptureError::PermissionDenied)
        })
        .expect("capture stream should start");

        let finished = tokio::time::timeout(Duration::from_secs(1), async {
            while stream.is_active() {
                tokio::task::yield_now().await;
            }
        })
        .await;

        assert!(finished.is_ok(), "capture stream did not finish");
        assert!(!stream.is_active());
        stream.stop();
    }
}

fn capture_display_frame(
    display_id: u32,
    timestamp: Duration,
) -> Result<CapturedFrame, CaptureError> {
    let display = CGDisplay::new(display_id);
    let image = display.image().ok_or_else(|| {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            CaptureError::PermissionDenied
        } else {
            CaptureError::Backend(format!("failed to capture image for display {display_id}"))
        }
    })?;

    cgimage_to_rgba_frame(image, timestamp)
}

fn capture_window_frame(
    window_id: u32,
    timestamp: Duration,
) -> Result<CapturedFrame, CaptureError> {
    let null_rect = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(0.0, 0.0));
    let image = CGDisplay::screenshot(
        null_rect,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBestResolution,
    )
    .ok_or_else(|| {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            CaptureError::PermissionDenied
        } else {
            CaptureError::Backend(format!("failed to capture image for window {window_id}"))
        }
    })?;

    cgimage_to_rgba_frame(image, timestamp)
}

fn cgimage_to_rgba_frame(
    image: CGImage,
    timestamp: Duration,
) -> Result<CapturedFrame, CaptureError> {
    let width = image.width() as u32;
    let height = image.height() as u32;
    let bytes_per_row = image.bytes_per_row();
    let cf_data = image.data();
    let raw = cf_data.bytes();

    if width == 0 || height == 0 {
        return Err(CaptureError::Backend(
            "captured image has empty dimensions".to_string(),
        ));
    }

    let stride = width * 4;
    let mut rgba = vec![0u8; (stride * height) as usize];

    for y in 0..height as usize {
        let src_row = y * bytes_per_row;
        let dst_row = y * (stride as usize);
        for x in 0..width as usize {
            let sp = src_row + x * 4;
            let dp = dst_row + x * 4;
            if sp + 3 < raw.len() && dp + 3 < rgba.len() {
                // CoreGraphics 32-bit pixel buffers on macOS are BGRA in memory.
                rgba[dp] = raw[sp + 2]; // R
                rgba[dp + 1] = raw[sp + 1]; // G
                rgba[dp + 2] = raw[sp]; // B
                rgba[dp + 3] = raw[sp + 3]; // A
            }
        }
    }

    Ok(CapturedFrame::Rgba {
        data: Arc::from(rgba.into_boxed_slice()),
        width,
        height,
        stride,
        timestamp,
    })
}

unsafe fn make_cf_string(s: &str) -> *const c_void {
    unsafe {
        CFStringCreateWithBytes(
            ptr::null(),
            s.as_ptr(),
            s.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            false,
        )
    }
}

unsafe fn get_string_value(dict: *const c_void, key_str: &str) -> Option<String> {
    let cf_key = unsafe { make_cf_string(key_str) };
    if cf_key.is_null() {
        return None;
    }
    let mut val: *const c_void = ptr::null();
    let present = unsafe { CFDictionaryGetValueIfPresent(dict, cf_key, &mut val) };
    unsafe { CFRelease(cf_key) };

    if present && !val.is_null() {
        let mut buf = vec![0u8; 256];
        if unsafe {
            CFStringGetCString(
                val,
                buf.as_mut_ptr(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            )
        } {
            let nul_pos = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            String::from_utf8(buf[..nul_pos].to_vec()).ok()
        } else {
            None
        }
    } else {
        None
    }
}

unsafe fn get_i64_value(dict: *const c_void, key_str: &str) -> Option<i64> {
    let cf_key = unsafe { make_cf_string(key_str) };
    if cf_key.is_null() {
        return None;
    }
    let mut val: *const c_void = ptr::null();
    let present = unsafe { CFDictionaryGetValueIfPresent(dict, cf_key, &mut val) };
    unsafe { CFRelease(cf_key) };

    if present && !val.is_null() {
        let mut out: i64 = 0;
        if unsafe { CFNumberGetValue(val, K_CF_NUMBER_S_INT64_TYPE, (&mut out as *mut i64).cast()) }
        {
            Some(out)
        } else {
            None
        }
    } else {
        None
    }
}

unsafe fn get_bool_value(dict: *const c_void, key_str: &str) -> Option<bool> {
    let cf_key = unsafe { make_cf_string(key_str) };
    if cf_key.is_null() {
        return None;
    }
    let mut val: *const c_void = ptr::null();
    let present = unsafe { CFDictionaryGetValueIfPresent(dict, cf_key, &mut val) };
    unsafe { CFRelease(cf_key) };

    if present && !val.is_null() {
        Some(unsafe { CFBooleanGetValue(val) })
    } else {
        None
    }
}
