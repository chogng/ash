#![allow(unsafe_code)]

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SendInput;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LWIN;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_PERIOD;

const WINDOWS_10_RS4_BUILD: u32 = 17_134;

pub(super) fn is_emoji_panel_supported() -> bool {
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        dwMajorVersion: 0,
        dwMinorVersion: 0,
        dwBuildNumber: 0,
        dwPlatformId: 0,
        szCSDVersion: [0; 128],
    };
    // SAFETY: RtlGetVersion initializes the caller-owned, correctly sized OSVERSIONINFOW record.
    let status = unsafe { RtlGetVersion(&mut version) };
    status >= 0 && version_supports_emoji_panel(version.dwMajorVersion, version.dwBuildNumber)
}

const fn version_supports_emoji_panel(major: u32, build: u32) -> bool {
    major > 10 || major == 10 && build >= WINDOWS_10_RS4_BUILD
}

pub(super) fn show_emoji_panel() -> bool {
    if !is_emoji_panel_supported() {
        return false;
    }
    // SAFETY: INPUT is a plain Win32 input record. Every union access selects the keyboard
    // variant after setting `type`, and SendInput copies the four records synchronously.
    unsafe {
        let mut inputs: [INPUT; 4] = std::mem::zeroed();
        for input in &mut inputs {
            input.r#type = INPUT_KEYBOARD;
        }
        inputs[0].Anonymous.ki.wVk = VK_LWIN;
        inputs[1].Anonymous.ki.wVk = VK_OEM_PERIOD;
        inputs[2].Anonymous.ki.wVk = VK_LWIN;
        inputs[2].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].Anonymous.ki.wVk = VK_OEM_PERIOD;
        inputs[3].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        ) == inputs.len() as u32
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
