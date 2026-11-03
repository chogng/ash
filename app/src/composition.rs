use std::error::Error;
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc;
use url::Url;
use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
use webview2_com::CoTaskMemPWSTR;
use webview2_com::CreateCoreWebView2CompositionControllerCompletedHandler;
use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
use webview2_com::CursorChangedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
use webview2_com::NavigationStartingEventHandler;
use webview2_com::NewWindowRequestedEventHandler;
use webview2_com::NonClientRegionChangedEventHandler;
use windows::Graphics::RectInt32;
use windows::Win32::Foundation::E_POINTER;
use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::LRESULT;
use windows::Win32::Foundation::POINT;
use windows::Win32::Foundation::RECT;
use windows::Win32::Foundation::WPARAM;
use windows::Win32::Graphics::DirectComposition::DCompositionCreateDevice;
use windows::Win32::Graphics::DirectComposition::IDCompositionDevice;
use windows::Win32::Graphics::DirectComposition::IDCompositionTarget;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::System::Com::CoUninitialize;
use windows::Win32::UI::Accessibility::IRawElementProviderSimple;
use windows::Win32::UI::Accessibility::UiaReturnRawElementProvider;
use windows::Win32::UI::Accessibility::UiaRootObjectId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetCapture;
use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows::Win32::UI::Input::KeyboardAndMouse::SetCapture;
use windows::Win32::UI::Input::KeyboardAndMouse::TME_LEAVE;
use windows::Win32::UI::Input::KeyboardAndMouse::TRACKMOUSEEVENT;
use windows::Win32::UI::Input::KeyboardAndMouse::TrackMouseEvent;
use windows::Win32::UI::Shell::DefSubclassProc;
use windows::Win32::UI::Shell::RemoveWindowSubclass;
use windows::Win32::UI::Shell::SetWindowSubclass;
use windows::Win32::UI::WindowsAndMessaging as win;
use windows::core::Interface;
use windows::core::PCWSTR;
use windows::core::PWSTR;

pub(crate) struct Apartment;

impl Apartment {
    pub(crate) fn initialize() -> windows::core::Result<Self> {
        // WebView2 and the HWND callbacks stay on the winit UI thread.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(crate) struct Composition {
    hwnd: HWND,
    input: Rc<Input>,
    webview: wv::ICoreWebView2,
    _target: IDCompositionTarget,
    system_window: crate::appwindow_bindings::Microsoft::UI::Windowing::AppWindow,
    device: IDCompositionDevice,
}

struct Input {
    visual: wv::ICoreWebView2CompositionController,
    regions: wv::ICoreWebView2CompositionController4,
    controller: wv::ICoreWebView2Controller,
}

impl Drop for Input {
    fn drop(&mut self) {
        unsafe {
            let _ = self.visual.SetRootVisualTarget(None);
            let _ = self.controller.Close();
        }
    }
}

impl Composition {
    pub(crate) fn open(
        hwnd: HWND,
        profile: &Path,
        url: &Url,
        width: i32,
        height: i32,
        system_window: crate::appwindow_bindings::Microsoft::UI::Windowing::AppWindow,
    ) -> Result<Self, Box<dyn Error>> {
        let folder = CoTaskMemPWSTR::from(profile.to_str().ok_or("Invalid WebView2 profile path")?);
        let (send, receive) = mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                wv::CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    *folder.as_ref().as_pcwstr(),
                    None,
                    &handler,
                )
                .map_err(Into::into)
            }),
            Box::new(move |status, environment| {
                status?;
                let _ = send.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)));
                Ok(())
            }),
        )?;
        let environment: wv::ICoreWebView2Environment = receive.recv()??;
        let environment: wv::ICoreWebView2Environment3 = environment.cast()?;
        let (send, receive) = mpsc::channel();
        CreateCoreWebView2CompositionControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                environment
                    .CreateCoreWebView2CompositionController(hwnd, &handler)
                    .map_err(Into::into)
            }),
            Box::new(move |status, visual| {
                status?;
                let _ = send.send(visual.ok_or_else(|| windows::core::Error::from(E_POINTER)));
                Ok(())
            }),
        )?;
        let visual: wv::ICoreWebView2CompositionController = receive.recv()??;
        let controller: wv::ICoreWebView2Controller = visual.cast()?;
        let webview = unsafe { controller.CoreWebView2()? };
        let input = Rc::new(Input {
            regions: visual.cast()?,
            controller,
            visual,
        });

        // WebView2 attaches its existing visual tree to this host-owned visual.
        let (device, target) = unsafe {
            let device: IDCompositionDevice = DCompositionCreateDevice(None::<&IDXGIDevice>)?;
            let target = device.CreateTargetForHwnd(hwnd, false)?;
            let root = device.CreateVisual()?;
            target.SetRoot(&root)?;
            input.visual.SetRootVisualTarget(&root)?;
            device.Commit()?;
            (device, target)
        };

        let allowed_origin = url.origin();
        let titlebar = system_window.TitleBar()?;
        unsafe {
            webview.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        args.SetCancel(
                            !Url::parse(&webview2_com::take_pwstr(uri))
                                .is_ok_and(|url| url.origin() == allowed_origin),
                        )?;
                    }
                    Ok(())
                })),
                &mut 0,
            )?;
            webview.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut 0,
            )?;
            webview
                .Settings()?
                .cast::<wv::ICoreWebView2Settings9>()?
                .SetIsNonClientRegionSupportEnabled(true)?;
            input.regions.add_NonClientRegionChanged(
                &NonClientRegionChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender {
                        let regions = sender.cast::<wv::ICoreWebView2CompositionController4>()?;
                        let bounds = regions.QueryNonClientRegion(
                            wv::COREWEBVIEW2_NON_CLIENT_REGION_KIND_CAPTION,
                        )?;
                        let mut count = 0;
                        bounds.Count(&mut count)?;
                        let mut drag = Vec::with_capacity(count as usize);
                        for index in 0..count {
                            let mut rect = RECT::default();
                            bounds.GetValueAtIndex(index, &mut rect)?;
                            drag.push(RectInt32 {
                                X: rect.left,
                                Y: rect.top,
                                Width: rect.right - rect.left,
                                Height: rect.bottom - rect.top,
                            });
                        }
                        // AppWindow routes pointer input using these regions before it reaches the host.
                        titlebar.SetDragRectangles(&drag)?;
                    }
                    Ok(())
                })),
                &mut 0,
            )?;
            input.visual.add_CursorChanged(
                &CursorChangedEventHandler::create(Box::new(|sender, _| {
                    if let Some(sender) = sender {
                        let mut cursor = win::HCURSOR::default();
                        sender.Cursor(&mut cursor)?;
                        win::SetCursor(Some(cursor));
                    }
                    Ok(())
                })),
                &mut 0,
            )?;
        }

        let script_view = webview.clone();
        let metrics = caption_script(&system_window)?;
        AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                let script = CoTaskMemPWSTR::from(format!(
                    "if (window === window.top) window.addEventListener('DOMContentLoaded', () => {{ {metrics} }}, {{ once: true }});"
                ).as_str());
                script_view
                    .AddScriptToExecuteOnDocumentCreated(*script.as_ref().as_pcwstr(), &handler)
                    .map_err(Into::into)
            }),
            Box::new(|status, _| status),
        )?;
        unsafe {
            input.controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })?;
            input.controller.SetIsVisible(true)?;
            let uri = CoTaskMemPWSTR::from(url.as_str());
            webview.Navigate(*uri.as_ref().as_pcwstr())?;
            SetWindowSubclass(hwnd, Some(input_proc), 0, Rc::as_ptr(&input) as usize).ok()?;
        }
        let view = Self {
            hwnd,
            input,
            webview,
            _target: target,
            system_window,
            device,
        };
        view.resize(width, height)?;
        Ok(view)
    }

    pub(crate) fn resize(&self, width: i32, height: i32) -> windows::core::Result<()> {
        unsafe {
            self.input.controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            })?;
            self.device.Commit()?;
        }
        self.evaluate(&caption_script(&self.system_window)?)
    }

    pub(crate) fn evaluate(&self, script: &str) -> windows::core::Result<()> {
        let script = CoTaskMemPWSTR::from(script);
        unsafe {
            self.webview
                .ExecuteScript(*script.as_ref().as_pcwstr(), None)
        }
    }
}

fn caption_script(
    window: &crate::appwindow_bindings::Microsoft::UI::Windowing::AppWindow,
) -> windows::core::Result<String> {
    let caption = window.TitleBar()?;
    let height = caption.Height()?;
    let left = caption.LeftInset()?;
    let right = caption.RightInset()?;
    Ok(format!(
        "Object.assign(document.documentElement.dataset, {{ systemCaptionHeight: '{height}', systemCaptionLeftInset: '{left}', systemCaptionRightInset: '{right}' }}); window.dispatchEvent(new Event('ash-system-caption-changed'));"
    ))
}

impl Drop for Composition {
    fn drop(&mut self) {
        // Remove the native callback before dropping its borrowed Rc pointer.
        unsafe {
            let _ = RemoveWindowSubclass(self.hwnd, Some(input_proc), 0);
        }
    }
}

const WM_MOUSELEAVE: u32 = wv::COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE.0 as u32;
unsafe extern "system" fn input_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    data: usize,
) -> LRESULT {
    // The view owns this pointer for the entire subclass lifetime. Keep a reference
    // across WebView2 calls, which may pump messages and cause reentrant window teardown.
    let pointer = data as *const Input;
    let input = unsafe {
        Rc::increment_strong_count(pointer);
        Rc::from_raw(pointer)
    };
    unsafe {
        let mut point = POINT {
            x: lparam.0 as i16 as i32,
            y: (lparam.0 >> 16) as i16 as i32,
        };
        match message {
            win::WM_SETFOCUS => {
                let result = DefSubclassProc(hwnd, message, wparam, lparam);
                let _ = input
                    .controller
                    .MoveFocus(wv::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                return result;
            }
            win::WM_NCHITTEST => {
                let native = DefSubclassProc(hwnd, message, wparam, lparam);
                // Keep the native frame and system buttons ahead of the WebView.
                if native.0 != win::HTCLIENT as isize && native.0 != win::HTCAPTION as isize {
                    return native;
                }
                let mut region = wv::COREWEBVIEW2_NON_CLIENT_REGION_KIND_NOWHERE;
                if ScreenToClient(hwnd, &mut point).as_bool()
                    && input
                        .regions
                        .GetNonClientRegionAtPoint(point, &mut region)
                        .is_ok()
                {
                    if region == wv::COREWEBVIEW2_NON_CLIENT_REGION_KIND_CAPTION {
                        return LRESULT(win::HTCAPTION as isize);
                    }
                    if region == wv::COREWEBVIEW2_NON_CLIENT_REGION_KIND_CLIENT {
                        return LRESULT(win::HTCLIENT as isize);
                    }
                }
                return native;
            }
            win::WM_MOUSEMOVE..=win::WM_MOUSEHWHEEL
            | WM_MOUSELEAVE
            | win::WM_NCRBUTTONDOWN
            | win::WM_NCRBUTTONUP => {
                match message {
                    win::WM_MOUSEMOVE => {
                        let _ = TrackMouseEvent(&mut TRACKMOUSEEVENT {
                            cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        });
                    }
                    win::WM_MOUSEWHEEL
                    | win::WM_MOUSEHWHEEL
                    | win::WM_NCRBUTTONDOWN
                    | win::WM_NCRBUTTONUP => {
                        let _ = ScreenToClient(hwnd, &mut point);
                    }
                    win::WM_LBUTTONDOWN
                    | win::WM_RBUTTONDOWN
                    | win::WM_MBUTTONDOWN
                    | win::WM_XBUTTONDOWN
                    | win::WM_LBUTTONDBLCLK
                    | win::WM_RBUTTONDBLCLK
                    | win::WM_MBUTTONDBLCLK
                    | win::WM_XBUTTONDBLCLK => {
                        SetCapture(hwnd);
                        let _ = input
                            .controller
                            .MoveFocus(wv::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                    }
                    _ => {}
                }
                // WebView2 mouse event and virtual-key values mirror the Win32 messages.
                let _ = input.visual.SendMouseInput(
                    wv::COREWEBVIEW2_MOUSE_EVENT_KIND(message as i32),
                    wv::COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(
                        if matches!(message, win::WM_NCRBUTTONDOWN | win::WM_NCRBUTTONUP) {
                            0
                        } else {
                            wparam.0 as u16 as i32
                        },
                    ),
                    (wparam.0 >> 16) as u16 as i16 as i32 as u32,
                    point,
                );
                if matches!(
                    message,
                    win::WM_LBUTTONUP | win::WM_RBUTTONUP | win::WM_MBUTTONUP | win::WM_XBUTTONUP
                ) && wparam.0 & 0x0073 == 0
                    && GetCapture() == hwnd
                {
                    let _ = ReleaseCapture();
                }
                return LRESULT(isize::from(matches!(
                    message,
                    win::WM_XBUTTONDOWN | win::WM_XBUTTONUP | win::WM_XBUTTONDBLCLK
                )));
            }
            win::WM_SETCURSOR if lparam.0 as u16 == win::HTCLIENT as u16 => {
                let mut cursor = win::HCURSOR::default();
                if input.visual.Cursor(&mut cursor).is_ok() && !cursor.is_invalid() {
                    win::SetCursor(Some(cursor));
                    return LRESULT(1);
                }
            }
            win::WM_GETOBJECT if lparam.0 as i32 == UiaRootObjectId => {
                if let Ok(provider) = input
                    .visual
                    .cast::<wv::ICoreWebView2CompositionController2>()
                    .and_then(|visual| visual.AutomationProvider())
                    .and_then(|provider| provider.cast::<IRawElementProviderSimple>())
                {
                    return UiaReturnRawElementProvider(hwnd, wparam, lparam, &provider);
                }
            }
            win::WM_MOVE => {
                let _ = input.controller.NotifyParentWindowPositionChanged();
            }
            win::WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(input_proc), 0);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}
