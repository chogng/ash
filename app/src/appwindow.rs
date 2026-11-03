use crate::appwindow_bindings::Microsoft::UI::{WindowId, Windowing::AppWindow};
use windows::Win32::Foundation::HWND;
use windows::Win32::Security::PSID;
use windows::Win32::Storage::Packaging::Appx::*;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::core::{HRESULT, PCSTR, PCWSTR, w};

pub fn bootstrap() -> windows::core::Result<()> {
    unsafe {
        let dependency = TryCreatePackageDependency(
            PSID::default(),
            w!("Microsoft.WindowsAppRuntime.1.8_8wekyb3d8bbwe"),
            PACKAGE_VERSION::default(),
            PackageDependencyProcessorArchitectures_None,
            PackageDependencyLifetimeKind_Process,
            PCWSTR::null(),
            CreatePackageDependencyOptions_None,
        )?;
        let mut context = PACKAGEDEPENDENCY_CONTEXT::default();
        let result = AddPackageDependency(
            dependency,
            0,
            AddPackageDependencyOptions_None,
            &mut context,
            None,
        );
        let _ = DeletePackageDependency(dependency);
        result
    }
}

pub fn attach(hwnd: HWND) -> windows::core::Result<AppWindow> {
    unsafe {
        let module = LoadLibraryW(w!("Microsoft.Internal.FrameworkUdk.dll"))?;
        let raw = GetProcAddress(
            module,
            PCSTR(c"Windowing_GetWindowIdFromWindow".as_ptr().cast()),
        )
        .ok_or_else(|| windows::core::Error::from_hresult(HRESULT(0x8007007fu32 as i32)))?;
        let get_window_id: unsafe extern "system" fn(HWND, *mut WindowId) -> HRESULT =
            std::mem::transmute(raw);
        let mut id = WindowId::default();
        get_window_id(hwnd, &mut id).ok()?;
        let window = AppWindow::GetFromWindowId(id)?;
        window.TitleBar()?.SetExtendsContentIntoTitleBar(true)?;
        Ok(window)
    }
}
