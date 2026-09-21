#![allow(unsafe_code)]

use crate::CaptureError;
use crate::CaptureTarget;
use crate::CapturedFrame;
use crate::DisplayInfo;
use crate::PermissionStatus;
use crate::ScreenCaptureSource;
use crate::ScreenCaptureStream;
use crate::WindowInfo;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::Direct3D11CaptureFramePool;
use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Graphics::Capture::GraphicsCaptureSession;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::D3D11_CPU_ACCESS_READ;
use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_BGRA_SUPPORT;
use windows::Win32::Graphics::Direct3D11::D3D11_MAP_READ;
use windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE;
use windows::Win32::Graphics::Direct3D11::D3D11_SDK_VERSION;
use windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC;
use windows::Win32::Graphics::Direct3D11::D3D11_USAGE_STAGING;
use windows::Win32::Graphics::Direct3D11::D3D11CreateDevice;
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dwm::DWMWA_CLOAKED;
use windows::Win32::Graphics::Dwm::DwmGetWindowAttribute;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::EnumDisplayMonitors;
use windows::Win32::Graphics::Gdi::GetMonitorInfoW;
use windows::Win32::Graphics::Gdi::HDC;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::Graphics::Gdi::MONITORINFOEXW;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::RO_INIT_MULTITHREADED;
use windows::Win32::System::WinRT::RoInitialize;
use windows::Win32::System::WinRT::RoUninitialize;
use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
use windows::Win32::UI::WindowsAndMessaging::IsIconic;
use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
use windows::core::BOOL;
use windows::core::Interface;

fn failure(error: impl std::fmt::Display) -> CaptureError {
    CaptureError::Backend(error.to_string())
}

pub fn check_permission() -> PermissionStatus {
    // Win32 capture keeps the system's capture border; it does not request borderless access.
    match GraphicsCaptureSession::IsSupported() {
        Ok(true) => PermissionStatus::Granted,
        _ => PermissionStatus::Denied,
    }
}

pub fn request_permission() -> bool {
    check_permission() == PermissionStatus::Granted
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    unsafe extern "system" fn monitor(
        handle: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // EnumDisplayMonitors invokes this callback synchronously with our live Vec.
        let displays = unsafe { &mut *(data.0 as *mut Vec<DisplayInfo>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) }.as_bool() {
            let rect = info.monitorInfo.rcMonitor;
            displays.push(DisplayInfo {
                id: (handle.0 as usize).to_string(),
                title: wide(&info.szDevice),
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
                is_primary: info.monitorInfo.dwFlags & 1 != 0,
            });
        }
        BOOL(1)
    }
    let mut displays = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(monitor),
            LPARAM(&mut displays as *mut _ as isize),
        )
    }
    .ok()
    .map_err(failure)?;
    Ok(displays)
}

pub fn enumerate_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    unsafe extern "system" fn window(handle: HWND, data: LPARAM) -> BOOL {
        let mut rect = RECT::default();
        let mut cloaked = 0u32;
        let mut title = [0u16; 1024];
        let mut class = [0u16; 256];
        unsafe {
            let _ =
                DwmGetWindowAttribute(handle, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
            if !IsWindowVisible(handle).as_bool()
                || IsIconic(handle).as_bool()
                || cloaked != 0
                || GetWindowRect(handle, &mut rect).is_err()
                || rect.right <= rect.left
                || rect.bottom <= rect.top
                || GetWindowTextW(handle, &mut title) == 0
            {
                return BOOL(1);
            }
            GetClassNameW(handle, &mut class);
            let windows = &mut *(data.0 as *mut Vec<WindowInfo>);
            windows.push(WindowInfo {
                id: (handle.0 as usize).to_string(),
                title: wide(&title),
                app_name: wide(&class),
                width: (rect.right - rect.left) as u32,
                height: (rect.bottom - rect.top) as u32,
                is_on_screen: true,
            });
        }
        BOOL(1)
    }
    let mut windows = Vec::new();
    unsafe { EnumWindows(Some(window), LPARAM(&mut windows as *mut _ as isize)) }
        .map_err(failure)?;
    Ok(windows)
}

fn wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())])
}

pub fn create_display_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    let info = enumerate_displays()?
        .into_iter()
        .find(|info| info.id == id)
        .ok_or_else(|| CaptureError::NotFound(id.into()))?;
    Ok(Box::new(Source {
        target: CaptureTarget::Display(info.clone()),
        info,
    }))
}

pub fn create_window_source(id: &str) -> Result<Box<dyn ScreenCaptureSource>, CaptureError> {
    let window = enumerate_windows()?
        .into_iter()
        .find(|info| info.id == id)
        .ok_or_else(|| CaptureError::NotFound(id.into()))?;
    let info = DisplayInfo {
        id: window.id.clone(),
        title: window.title.clone(),
        width: window.width,
        height: window.height,
        is_primary: false,
    };
    Ok(Box::new(Source {
        info,
        target: CaptureTarget::Window(window),
    }))
}

struct Source {
    info: DisplayInfo,
    target: CaptureTarget,
}

impl ScreenCaptureSource for Source {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }
    fn target(&self) -> CaptureTarget {
        self.target.clone()
    }
    fn start_stream(
        &self,
        fps: u32,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync + 'static>,
    ) -> Result<Box<dyn ScreenCaptureStream>, CaptureError> {
        if !(1..=60).contains(&fps) {
            return Err(failure("capture frame rate must be 1..60"));
        }
        let target = self.target.clone();
        let active = Arc::new(AtomicBool::new(true));
        let running = active.clone();
        let error = Arc::new(Mutex::new(None));
        let worker_error = error.clone();
        let (wake, notifications) = mpsc::sync_channel(1);
        let signals = wake.clone();
        let (ready, initialized) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("screen-capture".into())
            .spawn(move || {
                let _running = Running(running.clone());
                let result = (|| -> Result<(), CaptureError> {
                    let _apartment = Apartment::new()?;
                    let mut capture = Capture::new(&target, signals, running.clone())?;
                    if ready.send(Ok(())).is_err() {
                        return Ok(());
                    }
                    let interval = Duration::from_secs_f64(1.0 / f64::from(fps));
                    let mut previous = Instant::now() - interval;
                    while running.load(Ordering::Acquire) {
                        let _ = notifications.recv_timeout(Duration::from_millis(100));
                        if !running.load(Ordering::Acquire) {
                            break;
                        }
                        let remaining = interval.saturating_sub(previous.elapsed());
                        if !remaining.is_zero() {
                            thread::park_timeout(remaining);
                        }
                        if !running.load(Ordering::Acquire) {
                            break;
                        }
                        if let Some(frame) = capture.frame()? {
                            on_frame(frame);
                            previous = Instant::now();
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    if let Ok(mut slot) = worker_error.lock() {
                        *slot = Some(error.to_string());
                    }
                    let _ = ready.try_send(Err(error));
                }
            })
            .map_err(failure)?;
        let mut stream = Stream {
            active,
            wake,
            worker: Some(worker),
            error,
        };
        match initialized.recv().map_err(failure)? {
            Ok(()) => Ok(Box::new(stream)),
            Err(error) => {
                stream.stop();
                Err(error)
            }
        }
    }
}

struct Running(Arc<AtomicBool>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct Stream {
    active: Arc<AtomicBool>,
    wake: mpsc::SyncSender<()>,
    worker: Option<thread::JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}
impl ScreenCaptureStream for Stream {
    fn stop(&mut self) {
        self.active.store(false, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|error| error.clone())
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, CaptureError> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(failure)?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

// All GPU state stays on one worker. Event handlers retain only a wake channel or atomic flag.
struct Capture {
    item: GraphicsCaptureItem,
    closed: Option<i64>,
    pool: Direct3D11CaptureFramePool,
    arrived: Option<i64>,
    session: Option<GraphicsCaptureSession>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    interop: IDirect3DDevice,
    size: SizeInt32,
    staging: Option<ID3D11Texture2D>,
}
impl Capture {
    fn new(
        target: &CaptureTarget,
        wake: mpsc::SyncSender<()>,
        active: Arc<AtomicBool>,
    ) -> Result<Self, CaptureError> {
        let factory: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, _>().map_err(failure)?;
        let item: GraphicsCaptureItem = unsafe {
            match target {
                CaptureTarget::Display(info) => factory.CreateForMonitor(HMONITOR(
                    info.id.parse::<usize>().map_err(failure)? as *mut _,
                )),
                CaptureTarget::Window(info) => factory
                    .CreateForWindow(HWND(info.id.parse::<usize>().map_err(failure)? as *mut _)),
            }
        }
        .map_err(failure)?;
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(failure)?;
        let device = device.ok_or_else(|| failure("missing capture device"))?;
        let context = context.ok_or_else(|| failure("missing capture context"))?;
        let dxgi: IDXGIDevice = device.cast().map_err(failure)?;
        let interop: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(failure)?
            .cast()
            .map_err(failure)?;
        let size = item.Size().map_err(failure)?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &interop,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )
        .map_err(failure)?;
        let mut capture = Self {
            item,
            closed: None,
            pool,
            arrived: None,
            session: None,
            device,
            context,
            interop,
            size,
            staging: None,
        };
        capture.closed = Some(
            capture
                .item
                .Closed(&TypedEventHandler::new(move |_, _| {
                    active.store(false, Ordering::Release);
                    Ok(())
                }))
                .map_err(failure)?,
        );
        capture.arrived = Some(
            capture
                .pool
                .FrameArrived(&TypedEventHandler::new(move |_, _| {
                    let _ = wake.try_send(());
                    Ok(())
                }))
                .map_err(failure)?,
        );
        capture.session = Some(
            capture
                .pool
                .CreateCaptureSession(&capture.item)
                .map_err(failure)?,
        );
        capture
            .session
            .as_ref()
            .expect("created session")
            .StartCapture()
            .map_err(failure)?;
        Ok(capture)
    }

    fn frame(&mut self) -> Result<Option<CapturedFrame>, CaptureError> {
        // A null frame is reported as E_POINTER by the Rust WinRT binding.
        let frame = match self.pool.TryGetNextFrame() {
            Ok(frame) => frame,
            Err(error) if error.code() == windows::Win32::Foundation::E_POINTER => return Ok(None),
            Err(error) => return Err(failure(error)),
        };
        let result = (|| {
            let size = frame.ContentSize().map_err(failure)?;
            if size.Width <= 0 || size.Height <= 0 {
                return Ok(None);
            }
            // Recreate after releasing this frame; never read beyond the old surface on growth.
            if size != self.size {
                return Ok(None);
            }
            let access: IDirect3DDxgiInterfaceAccess =
                frame.Surface().map_err(failure)?.cast().map_err(failure)?;
            let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(failure)?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe {
                texture.GetDesc(&mut desc);
            }
            // During resize WGC can pair the new content size with an old pool surface.
            if desc.Width < size.Width as u32 || desc.Height < size.Height as u32 {
                return Ok(None);
            }
            if let Some(staging) = &self.staging {
                let mut previous = D3D11_TEXTURE2D_DESC::default();
                unsafe {
                    staging.GetDesc(&mut previous);
                }
                if previous.Width != desc.Width || previous.Height != desc.Height {
                    self.staging = None;
                }
            }
            if self.staging.is_none() {
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                unsafe {
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut self.staging))
                }
                .map_err(failure)?;
            }
            let staging = self
                .staging
                .as_ref()
                .ok_or_else(|| failure("missing staging texture"))?;
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context.CopyResource(staging, &texture);
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .map_err(failure)?;
            }
            let width = size.Width as u32;
            let height = size.Height as u32;
            let result = (|| {
                let stride = width
                    .checked_mul(4)
                    .ok_or_else(|| failure("capture dimensions overflow"))?;
                if mapped.pData.is_null() || mapped.RowPitch < stride {
                    return Err(failure("invalid capture surface"));
                }
                let length = (mapped.RowPitch as usize)
                    .checked_mul(height as usize)
                    .ok_or_else(|| failure("capture dimensions overflow"))?;
                let bytes =
                    unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), length) };
                let mut rgba = Vec::with_capacity(stride as usize * height as usize);
                for row in bytes.chunks_exact(mapped.RowPitch as usize) {
                    for pixel in row[..stride as usize].chunks_exact(4) {
                        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
                    }
                }
                Ok(Some(CapturedFrame::Rgba {
                    data: rgba.into(),
                    width,
                    height,
                    stride,
                    timestamp: Duration::from_nanos(
                        frame.SystemRelativeTime().map_err(failure)?.Duration.max(0) as u64 * 100,
                    ),
                }))
            })();
            unsafe {
                self.context.Unmap(staging, 0);
            }
            result
        })();
        let size = frame.ContentSize().map_err(failure)?;
        frame.Close().map_err(failure)?;
        if size.Width > 0 && size.Height > 0 && size != self.size {
            self.pool
                .Recreate(
                    &self.interop,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    2,
                    size,
                )
                .map_err(failure)?;
            self.size = size;
            self.staging = None;
        }
        result
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(token) = self.closed.take() {
            let _ = self.item.RemoveClosed(token);
        }
        if let Some(token) = self.arrived.take() {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(session) = self.session.take() {
            let _ = session.Close();
        }
        let _ = self.pool.Close();
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
