#![allow(unsafe_code)]

use std::ffi::c_void;
use std::mem::size_of;

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Graphics::Gdi::DEVMODEW;
use windows_sys::Win32::Graphics::Gdi::DMDO_90;
use windows_sys::Win32::Graphics::Gdi::DMDO_180;
use windows_sys::Win32::Graphics::Gdi::DMDO_270;
use windows_sys::Win32::Graphics::Gdi::DMDO_DEFAULT;
use windows_sys::Win32::Graphics::Gdi::ENUM_CURRENT_SETTINGS;
use windows_sys::Win32::Graphics::Gdi::EnumDisplaySettingsExW;
use windows_sys::Win32::Graphics::Gdi::GetMonitorInfoW;
use windows_sys::Win32::Graphics::Gdi::MONITORINFO;
use windows_sys::Win32::Graphics::Gdi::MONITORINFOEXW;
use windows_sys::Win32::UI::WindowsAndMessaging::GetPhysicalCursorPos;
use windows_sys::Win32::UI::WindowsAndMessaging::MSG;
use windows_sys::Win32::UI::WindowsAndMessaging::SPI_SETWORKAREA;
use windows_sys::Win32::UI::WindowsAndMessaging::WM_DISPLAYCHANGE;
use windows_sys::Win32::UI::WindowsAndMessaging::WM_SETTINGCHANGE;

use super::CursorPositionError;
use crate::window::DisplayRotation;
use crate::window::PhysicalBounds;
use crate::window::PhysicalExtent;
use crate::window::PhysicalPosition;

pub(super) fn cursor_screen_position() -> Result<PhysicalPosition, CursorPositionError> {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: point remains writable for the duration of this synchronous Win32 call.
    if unsafe { GetPhysicalCursorPos(&mut point) } == 0 {
        return Err(CursorPositionError::platform(
            std::io::Error::last_os_error(),
        ));
    }
    Ok(PhysicalPosition::new(
        f64::from(point.x),
        f64::from(point.y),
    ))
}

pub(super) fn work_area(hmonitor: isize) -> Option<PhysicalBounds> {
    let work = monitor_info(hmonitor)?.monitorInfo.rcWork;
    let width = i64::from(work.right) - i64::from(work.left);
    let height = i64::from(work.bottom) - i64::from(work.top);
    if !(0..=i64::from(u32::MAX)).contains(&width) || !(0..=i64::from(u32::MAX)).contains(&height) {
        return None;
    }
    Some(PhysicalBounds::new(
        PhysicalPosition::new(f64::from(work.left), f64::from(work.top)),
        PhysicalExtent::new(width as u32, height as u32),
    ))
}

pub(super) fn rotation(hmonitor: isize) -> Option<DisplayRotation> {
    let info = monitor_info(hmonitor)?;
    // SAFETY: DEVMODEW is a Win32 plain-data structure for which zero initialization is valid;
    // dmSize is set as required before EnumDisplaySettingsExW writes the current configuration.
    let mut mode = unsafe { std::mem::zeroed::<DEVMODEW>() };
    mode.dmSize = size_of::<DEVMODEW>() as u16;
    // SAFETY: szDevice is a null-terminated array owned by info, and mode remains writable for the
    // duration of this synchronous call.
    if unsafe {
        EnumDisplaySettingsExW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode, 0)
    } == 0
    {
        return None;
    }
    // SAFETY: EnumDisplaySettingsExW initialized the display variant of DEVMODEW for this device.
    match unsafe { mode.Anonymous1.Anonymous2.dmDisplayOrientation } {
        DMDO_DEFAULT => Some(DisplayRotation::Degrees0),
        DMDO_90 => Some(DisplayRotation::Degrees90),
        DMDO_180 => Some(DisplayRotation::Degrees180),
        DMDO_270 => Some(DisplayRotation::Degrees270),
        _ => None,
    }
}

fn monitor_info(hmonitor: isize) -> Option<MONITORINFOEXW> {
    // SAFETY: MONITORINFOEXW is a Win32 plain-data structure for which zero initialization is
    // valid; its embedded size field is set before the API writes the remaining fields.
    let mut info = unsafe { std::mem::zeroed::<MONITORINFOEXW>() };
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: hmonitor comes from winit's live MonitorHandle and info is correctly sized and
    // writable for the duration of the synchronous Win32 call.
    let result = unsafe {
        GetMonitorInfoW(
            hmonitor as *mut c_void,
            (&mut info as *mut MONITORINFOEXW).cast::<MONITORINFO>(),
        )
    };
    (result != 0).then_some(info)
}

pub(crate) fn is_change_message(message: *const c_void) -> bool {
    if message.is_null() {
        return false;
    }
    // SAFETY: winit's message hook supplies a valid MSG pointer for the duration of the callback.
    let message = unsafe { &*message.cast::<MSG>() };
    message.message == WM_DISPLAYCHANGE
        || (message.message == WM_SETTINGCHANGE && message.wParam == SPI_SETWORKAREA as usize)
}
