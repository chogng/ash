#![allow(unsafe_code)]

use std::cell::Cell;
use std::ffi::c_void;

use windows_sys::Win32::UI::WindowsAndMessaging::HACCEL;
use windows_sys::Win32::UI::WindowsAndMessaging::MSG;
use windows_sys::Win32::UI::WindowsAndMessaging::TranslateAcceleratorW;

use super::SystemServiceError;

pub(super) fn attach(menu: &muda::Menu, hwnd: isize) -> Result<(), SystemServiceError> {
    unsafe { menu.init_for_hwnd(hwnd) }
        .map_err(|source| SystemServiceError::backend("native application menu", source))
}

pub(super) fn remove(menu: &muda::Menu, hwnd: isize) -> Result<(), SystemServiceError> {
    unsafe { menu.remove_for_hwnd(hwnd) }
        .map_err(|source| SystemServiceError::backend("native application menu", source))
}

pub(super) fn translate_accelerator(table: &Cell<isize>, message: *const c_void) -> bool {
    let table = table.get();
    if table == 0 || message.is_null() {
        return false;
    }
    let message = message.cast::<MSG>();
    unsafe { TranslateAcceleratorW((*message).hwnd, table as HACCEL, message) != 0 }
}
