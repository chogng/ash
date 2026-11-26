use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use ash_computer_use_protocol::Action;
use ash_computer_use_protocol::CHANNEL;
use ash_computer_use_protocol::EXTENSION_ID;
use ash_computer_use_protocol::Element;
use ash_computer_use_protocol::ElementAction;
use ash_computer_use_protocol::MAX_VALUE_BYTES;
use ash_computer_use_protocol::MAX_WINDOWS;
use ash_computer_use_protocol::Request;
use ash_computer_use_protocol::Response;
use ash_computer_use_protocol::Window;
use base64::Engine;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use screen_capture::CapturedFrame;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Foundation::ERROR_ALREADY_EXISTS;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Foundation::HWND;
use windows::Win32::Security::GetTokenInformation;
use windows::Win32::Security::TOKEN_ELEVATION;
use windows::Win32::Security::TOKEN_QUERY;
use windows::Win32::Security::TokenElevation;
use windows::Win32::System::Com::CLSCTX_INPROC_SERVER;
use windows::Win32::System::Com::COINIT_MULTITHREADED;
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::System::Com::CoUninitialize;
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Ole::SafeArrayAccessData;
use windows::Win32::System::Ole::SafeArrayDestroy;
use windows::Win32::System::Ole::SafeArrayGetLBound;
use windows::Win32::System::Ole::SafeArrayGetUBound;
use windows::Win32::System::Ole::SafeArrayUnaccessData;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::System::Threading::GetProcessTimes;
use windows::Win32::System::Threading::OpenProcess;
use windows::Win32::System::Threading::OpenProcessToken;
use windows::Win32::System::Threading::PROCESS_NAME_WIN32;
use windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows::Win32::System::Threading::QueryFullProcessImageNameW;
use windows::Win32::UI::Accessibility::CUIAutomation;
use windows::Win32::UI::Accessibility::IUIAutomation;
use windows::Win32::UI::Accessibility::IUIAutomationElement;
use windows::Win32::UI::Accessibility::IUIAutomationInvokePattern;
use windows::Win32::UI::Accessibility::IUIAutomationScrollItemPattern;
use windows::Win32::UI::Accessibility::IUIAutomationSelectionItemPattern;
use windows::Win32::UI::Accessibility::IUIAutomationValuePattern;
use windows::Win32::UI::Accessibility::UIA_InvokePatternId;
use windows::Win32::UI::Accessibility::UIA_ScrollItemPatternId;
use windows::Win32::UI::Accessibility::UIA_SelectionItemPatternId;
use windows::Win32::UI::Accessibility::UIA_ValuePatternId;
use windows::Win32::UI::WindowsAndMessaging::GA_ROOT;
use windows::Win32::UI::WindowsAndMessaging::GetAncestor;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::Win32::UI::WindowsAndMessaging::IsIconic;
use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
use windows::core::BSTR;
use windows::core::PWSTR;
use windows::core::w;

const MAX_ELEMENTS: usize = 200;
const MAX_DEPTH: u8 = 24;
const MAX_TEXT_CHARS: usize = 256;

#[derive(Default)]
pub(crate) struct ComputerUse;

impl Extension for ComputerUse {
    fn id(&self) -> &str {
        EXTENSION_ID
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        // One provider activation represents a single Turn. No desktop grant survives restart.
        let session = Arc::new(Mutex::new(Session::default()));
        context
            .data_channels
            .register(CHANNEL, move |request, token| {
                token.check_cancelled()?;
                let result = session
                    .lock()
                    .map_err(|_| "Computer Use session is unavailable")
                    .and_then(|mut session| session.handle(request, &token));
                token.check_cancelled()?;
                Ok(result.unwrap_or_else(|message| Response::Failed {
                    message: message.to_owned(),
                }))
            })
    }
}

#[derive(Default)]
struct Session {
    window: Option<WindowGrant>,
    generation: u32,
    snapshot: Option<Vec<ObservedElement>>,
}

struct ObservedElement {
    runtime_id: Vec<i32>,
    role: String,
    name: String,
}

struct WindowGrant {
    window: Window,
    // The kernel closes the handle if the provider crashes or is killed.
    _lease: OwnedHandle,
}

impl WindowGrant {
    fn acquire(window: Window) -> Result<Self, &'static str> {
        verify_window(&window)?;
        // Each logon session has one live Computer Use grant across all Ash runtimes.
        let lease = OwnedHandle(
            unsafe { CreateMutexW(None, false, w!("Local\\Ash.ComputerUse.WindowGrant.v1")) }
                .map_err(|_| "Cannot reserve Windows Computer Use")?,
        );
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err("Another task has an active Computer Use window");
        }
        Ok(Self {
            window,
            _lease: lease,
        })
    }
}

impl Session {
    fn handle(
        &mut self,
        request: Request,
        token: &CancellationToken,
    ) -> Result<Response, &'static str> {
        not_cancelled(token)?;
        match request {
            Request::ListWindows { query } => Ok(Response::Windows {
                windows: list_windows(query.as_deref())?,
            }),
            Request::Bind { window } => {
                if self.window.is_some() {
                    return Err("This Computer Use session already has a window");
                }
                self.window = Some(WindowGrant::acquire(window)?);
                Ok(Response::Bound)
            }
            Request::Observe {
                observation,
                screenshot,
            } => {
                if observation <= self.generation {
                    return Err("Observation expired. Observe the window again");
                }
                self.snapshot = None;
                let window = &self.window.as_ref().ok_or("Select a window first")?.window;
                let _apartment = ComApartment::open()?;
                let (elements, truncated) = walk(window, token)?;
                let mut ids = Vec::with_capacity(elements.len());
                let mut result = Vec::with_capacity(elements.len());
                for (depth, element, id) in elements {
                    not_cancelled(token)?;
                    let element = describe(result.len() as u32, depth, &element);
                    ids.push(ObservedElement {
                        runtime_id: id,
                        role: element.role.clone(),
                        name: element.name.clone(),
                    });
                    result.push(element);
                }
                let screenshot_png = screenshot.then(|| capture(window, token)).transpose()?;
                verify_window(window)?;
                self.generation = observation;
                self.snapshot = Some(ids);
                Ok(Response::Observation {
                    observation: self.generation,
                    elements: result,
                    truncated,
                    screenshot_png,
                })
            }
            Request::Act {
                observation,
                element,
                action,
            } => {
                let window = &self.window.as_ref().ok_or("Select a window first")?.window;
                if observation != self.generation {
                    return Err("Observation expired. Observe the window again");
                }
                // Consume the snapshot before execution. All outcomes require a fresh observation.
                let ids = self
                    .snapshot
                    .take()
                    .ok_or("Observation expired. Observe the window again")?;
                let id = ids
                    .get(element as usize)
                    .ok_or("Unknown element in this observation")?;
                let _apartment = ComApartment::open()?;
                let (elements, _) = walk(window, token)?;
                let mut matches = elements
                    .into_iter()
                    .filter(|(_, _, current)| current == &id.runtime_id);
                let (_, target, _) = matches
                    .next()
                    .ok_or("Element moved or closed. Observe again")?;
                if matches.next().is_some() {
                    return Err("Element is ambiguous. Observe again");
                }
                if element_name(&target) != id.name || element_role(&target) != id.role {
                    return Err("Element changed. Observe again");
                }
                verify_window(window)?;
                not_cancelled(token)?;
                perform(&target, action)?;
                Ok(Response::Applied)
            }
        }
    }
}

fn not_cancelled(token: &CancellationToken) -> Result<(), &'static str> {
    token
        .check_cancelled()
        .map_err(|_| "Computer Use was cancelled")
}

struct ComApartment;

impl ComApartment {
    fn open() -> Result<Self, &'static str> {
        // SDK invocation workers do not own windows. COM stays initialized for the lifetime of
        // every UIA reference created by the invocation, including error paths.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| "Cannot initialize Windows UI Automation")?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct OwnedHandle(HANDLE);

// The process and mutex handles are owned kernel references. They are released only by Drop.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn is_standard_process(process: HANDLE) -> bool {
    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.is_err() {
        return false;
    }
    let token = OwnedHandle(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut written = 0;
    let size = std::mem::size_of_val(&elevation) as u32;
    // Query a fixed-size TOKEN_ELEVATION structure from the target's primary token.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            size,
            &mut written,
        )
    }
    .is_ok()
        && written == size
        && elevation.TokenIsElevated == 0
}

fn window_process(handle: u64) -> Option<(u32, u64, String)> {
    let hwnd = HWND(usize::try_from(handle).ok()? as *mut _);
    // The handle is opaque to Rust and is validated by Windows before any other use.
    if !unsafe { IsWindowVisible(hwnd) }.as_bool()
        || unsafe { IsIconic(hwnd) }.as_bool()
        || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd
    {
        return None;
    }
    let mut pid = 0;
    if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) } == 0 || pid == 0 {
        return None;
    }
    let process =
        OwnedHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    if !is_standard_process(process.0) {
        return None;
    }
    let mut started = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(process.0, &mut started, &mut exited, &mut kernel, &mut user) }
        .ok()?;
    let mut image = [0u16; 1024];
    let mut len = image.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(image.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    let image = String::from_utf16_lossy(image.get(..len as usize)?);
    let name = Path::new(&image).file_name()?.to_str()?;
    // An Agent must not invoke Ash's own approval UX or the system's security prompts.
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "ash.exe"
            | "ash-insiders.exe"
            | "ash-computer-use.exe"
            | "electron.exe"
            | "consent.exe"
            | "logonui.exe"
            | "credentialuibroker.exe"
    ) {
        return None;
    }
    Some((
        pid,
        (u64::from(started.dwHighDateTime) << 32) | u64::from(started.dwLowDateTime),
        name.to_owned(),
    ))
}

fn verify_window(window: &Window) -> Result<(), &'static str> {
    let (pid, started, _) =
        window_process(window.handle).ok_or("Selected window is no longer available")?;
    if (pid, started) != (window.process, window.process_started) {
        return Err("Selected window has changed");
    }
    Ok(())
}

fn list_windows(query: Option<&str>) -> Result<Vec<Window>, &'static str> {
    if query.is_some_and(|text| text.len() > 128 || text.contains('\0')) {
        return Err("Invalid window search");
    }
    let query = query.map(str::to_lowercase);
    let windows =
        screen_capture::enumerate_windows().map_err(|_| "Cannot list Windows desktop windows")?;
    Ok(windows
        .into_iter()
        .filter_map(|window| {
            let handle = window.id.parse().ok()?;
            let (process, process_started, app) = window_process(handle)?;
            if query.as_ref().is_some_and(|query| {
                !window.title.to_lowercase().contains(query) && !app.to_lowercase().contains(query)
            }) {
                return None;
            }
            Some(Window {
                handle,
                process,
                process_started,
                title: bounded(&window.title),
                app,
            })
        })
        .take(MAX_WINDOWS)
        .collect())
}

type LiveElement = (u8, IUIAutomationElement, Vec<i32>);

fn walk(
    window: &Window,
    token: &CancellationToken,
) -> Result<(Vec<LiveElement>, bool), &'static str> {
    verify_window(window)?;
    // UI Automation returns COM references valid inside the current apartment. The snapshot
    // keeps only RuntimeIds so the following invocation can resolve them from the granted root.
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| "Cannot connect to Windows UI Automation")?;
    let root = unsafe { automation.ElementFromHandle(HWND(window.handle as usize as *mut _)) }
        .map_err(|_| "Cannot read the selected window")?;
    let walker = unsafe { automation.ControlViewWalker() }
        .map_err(|_| "Cannot read the accessibility tree")?;
    let mut stack = vec![(0u8, root)];
    let mut elements = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    while let Some((depth, element)) = stack.pop() {
        not_cancelled(token)?;
        if visited >= MAX_ELEMENTS {
            truncated = true;
            break;
        }
        visited += 1;
        if depth > 0
            && let Ok(next) = unsafe { walker.GetNextSiblingElement(&element) }
        {
            stack.push((depth, next));
        }
        // Cross-process descendants and password controls are outside the authorized tree.
        if unsafe { element.CurrentProcessId() }.ok() != Some(window.process as i32)
            || !unsafe { element.CurrentIsPassword() }.is_ok_and(|value| !value.as_bool())
        {
            continue;
        }
        if let Ok(child) = unsafe { walker.GetFirstChildElement(&element) } {
            if depth < MAX_DEPTH {
                stack.push((depth + 1, child));
            } else {
                truncated = true;
            }
        }
        if let Some(id) = runtime_id(&element) {
            elements.push((depth, element, id));
        }
    }
    Ok((elements, truncated))
}

struct RuntimeId(*mut SAFEARRAY);

impl Drop for RuntimeId {
    fn drop(&mut self) {
        let _ = unsafe { SafeArrayDestroy(self.0) };
    }
}

fn runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
    // GetRuntimeId allocates a one-dimensional SAFEARRAY of 32-bit integers for its caller.
    let array = unsafe { element.GetRuntimeId() }.ok()?;
    if array.is_null() {
        return None;
    }
    let id = RuntimeId(array);
    let lower = unsafe { SafeArrayGetLBound(id.0, 1) }.ok()?;
    let upper = unsafe { SafeArrayGetUBound(id.0, 1) }.ok()?;
    let len = usize::try_from(i64::from(upper) - i64::from(lower) + 1).ok()?;
    if !(1..=64).contains(&len) {
        return None;
    }
    let mut data = std::ptr::null_mut();
    unsafe { SafeArrayAccessData(id.0, &mut data) }.ok()?;
    let result = (!data.is_null())
        .then(|| unsafe { std::slice::from_raw_parts(data.cast::<i32>(), len) }.to_vec());
    let _ = unsafe { SafeArrayUnaccessData(id.0) };
    result
}

fn bounded(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_TEXT_CHARS)
        .collect()
}

fn element_name(element: &IUIAutomationElement) -> String {
    unsafe { element.CurrentName() }
        .map(|name| bounded(&name.to_string()))
        .unwrap_or_default()
}

fn element_role(element: &IUIAutomationElement) -> String {
    unsafe { element.CurrentLocalizedControlType() }
        .map(|role| bounded(&role.to_string()))
        .unwrap_or_default()
}

fn describe(id: u32, depth: u8, element: &IUIAutomationElement) -> Element {
    let enabled = unsafe { element.CurrentIsEnabled() }.is_ok_and(|state| state.as_bool());
    let mut actions = Vec::new();
    let mut value = None;
    if enabled
        && unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }
            .is_ok()
    {
        actions.push(ElementAction::Invoke);
    }
    if enabled
        && unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        }
        .is_ok()
    {
        actions.push(ElementAction::Select);
    }
    if enabled
        && unsafe {
            element.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
        }
        .is_ok()
    {
        actions.push(ElementAction::ScrollIntoView);
    }
    if let Ok(pattern) =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
    {
        value = unsafe { pattern.CurrentValue() }
            .ok()
            .map(|value| bounded(&value.to_string()));
        if enabled && unsafe { pattern.CurrentIsReadOnly() }.is_ok_and(|state| !state.as_bool()) {
            actions.push(ElementAction::SetValue);
        }
    }
    Element {
        id,
        depth,
        role: element_role(element),
        name: element_name(element),
        value,
        enabled,
        actions,
    }
}

fn perform(element: &IUIAutomationElement, action: Action) -> Result<(), &'static str> {
    if !unsafe { element.CurrentIsEnabled() }.is_ok_and(|value| value.as_bool())
        || !unsafe { element.CurrentIsPassword() }.is_ok_and(|value| !value.as_bool())
    {
        return Err("Element cannot be operated");
    }
    match action {
        Action::Invoke => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            }
            .map_err(|_| "Element does not support invoke")?;
            unsafe { pattern.Invoke() }
        }
        Action::Select => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            }
            .map_err(|_| "Element does not support selection")?;
            unsafe { pattern.Select() }
        }
        Action::ScrollIntoView => {
            let pattern = unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
            }
            .map_err(|_| "Element does not support scrolling into view")?;
            unsafe { pattern.ScrollIntoView() }
        }
        Action::SetValue { value } => {
            if value.len() > MAX_VALUE_BYTES || value.contains('\0') {
                return Err("Invalid control value");
            }
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            }
            .map_err(|_| "Element does not support setting a value")?;
            unsafe { pattern.SetValue(&BSTR::from(value)) }
        }
    }
    .map_err(|_| "Windows did not confirm the action. Observe before retrying")
}

fn capture(window: &Window, token: &CancellationToken) -> Result<String, &'static str> {
    verify_window(window)?;
    let source = screen_capture::create_window_source(&window.handle.to_string())
        .map_err(|_| "Cannot capture the selected window")?;
    let (send, receive) = mpsc::sync_channel(1);
    let _stream = source
        .start_stream(
            15,
            Box::new(move |frame| {
                let _ = send.try_send(frame);
            }),
        )
        .map_err(|_| "Cannot start window capture")?;
    let until = std::time::Instant::now() + Duration::from_secs(3);
    let CapturedFrame::Rgba {
        data,
        width,
        height,
        stride,
        ..
    } = loop {
        not_cancelled(token)?;
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => break frame,
            Err(mpsc::RecvTimeoutError::Timeout) if std::time::Instant::now() < until => continue,
            Err(_) => return Err("Window capture did not return a frame"),
        }
    };
    drop(_stream);
    verify_window(window)?;
    let row_bytes = width as usize * 4;
    if row_bytes == 0
        || (stride as usize) < row_bytes
        || data.len() != stride as usize * height as usize
    {
        return Err("Invalid window frame");
    }
    let rgba = image::RgbaImage::from_raw(
        width,
        height,
        data.chunks_exact(stride as usize)
            .flat_map(|row| row[..row_bytes].iter().copied())
            .collect(),
    )
    .ok_or("Invalid window frame")?;
    let image = image::DynamicImage::ImageRgba8(rgba).thumbnail(1280, 1280);
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| "Cannot encode the window screenshot")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png.into_inner()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_invalid_queries_before_enumerating_windows() {
        for query in ["x".repeat(129), "window\0title".into()] {
            assert_eq!(
                super::list_windows(Some(&query)),
                Err("Invalid window search")
            );
        }
    }
}
