use crate::composition::Apartment;
use crate::composition::Composition;
use std::error::Error;
use std::io;
use std::io::BufRead;
use std::io::Read;
use std::path::PathBuf;
use url::Url;
use windows::Win32::Foundation::HWND;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::dpi::PhysicalPosition;
use winit::dpi::PhysicalSize;
use winit::event::WindowEvent;
use winit::event_loop::ActiveEventLoop;
use winit::event_loop::EventLoop;
use winit::event_loop::EventLoopProxy;
use winit::platform::windows::WindowAttributesExtWindows;
use winit::raw_window_handle::HasWindowHandle;
use winit::raw_window_handle::RawWindowHandle;
use winit::window::ResizeDirection;
use winit::window::Window;
use winit::window::WindowId;
use wry::NewWindowResponse;
use wry::Rect;
use wry::WebContext;
use wry::WebView;
use wry::WebViewBuilder;

enum WindowCommand {
    Minimize,
    ToggleMaximize,
    Close,
    ReadState,
    Resize(ResizeDirection),
}

enum View {
    Child(WebView),
    Composition(Composition),
}

enum Host {
    Child(WebContext),
    Composition(PathBuf),
}

struct Desktop {
    // The child controller must close before its context and parent HWND.
    webview: Option<View>,
    host: Host,
    window: Option<Window>,
    url: Url,
    last_size: Option<PhysicalSize<u32>>,
    last_maximized: Option<bool>,
    commands: EventLoopProxy<WindowCommand>,
    failure: Option<Box<dyn Error>>,
}

impl Desktop {
    fn open(&mut self, event_loop: &ActiveEventLoop) -> Result<(), Box<dyn Error>> {
        let window = event_loop.create_window(
            Window::default_attributes()
                .with_title("Ash")
                .with_inner_size(LogicalSize::new(1280, 800))
                .with_min_inner_size(LogicalSize::new(480, 320))
                .with_decorations(matches!(self.host, Host::Composition(_)))
                .with_undecorated_shadow(true)
                .with_visible(false),
        )?;
        let size = window.inner_size();
        let origin = self.url.origin();
        let command_origin = origin.clone();
        let commands = self.commands.clone();
        let command = move |source: &str, message: &str| {
            if !Url::parse(source).is_ok_and(|url| {
                url.origin() == command_origin && url.path() == "/browser/workbench/workbench.html"
            }) {
                return;
            }
            let command = match message {
                "minimize" => WindowCommand::Minimize,
                "toggle-maximize" => WindowCommand::ToggleMaximize,
                "close" => WindowCommand::Close,
                "read-state" => WindowCommand::ReadState,
                "resize:north" => WindowCommand::Resize(ResizeDirection::North),
                "resize:north-east" => WindowCommand::Resize(ResizeDirection::NorthEast),
                "resize:east" => WindowCommand::Resize(ResizeDirection::East),
                "resize:south-east" => WindowCommand::Resize(ResizeDirection::SouthEast),
                "resize:south" => WindowCommand::Resize(ResizeDirection::South),
                "resize:south-west" => WindowCommand::Resize(ResizeDirection::SouthWest),
                "resize:west" => WindowCommand::Resize(ResizeDirection::West),
                "resize:north-west" => WindowCommand::Resize(ResizeDirection::NorthWest),
                _ => return,
            };
            let _ = commands.send_event(command);
        };
        let webview = match &mut self.host {
            Host::Child(context) => View::Child(WebViewBuilder::new_with_web_context(context)
                .with_url(self.url.as_str())
                .with_bounds(client_bounds(size))
                .with_navigation_handler(move |url| {
                    Url::parse(&url).is_ok_and(|url| url.origin() == origin)
                })
                .with_initialization_script(
                    "if (window === window.top) Object.defineProperty(window, 'ashNativeWindowCommand', { value: command => window.ipc.postMessage(command) });",
                )
                .with_ipc_handler(move |request| command(&request.uri().to_string(), request.body()))
                .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                .build_as_child(&window)?),
            Host::Composition(profile) => {
                let RawWindowHandle::Win32(handle) = window.window_handle()?.as_raw() else {
                    return Err("Expected a Win32 window".into());
                };
                let system_window = crate::appwindow::attach(HWND(handle.hwnd.get() as *mut _))?;
                let size = window.inner_size();
                View::Composition(Composition::open(
                    HWND(handle.hwnd.get() as *mut _), profile, &self.url, size.width as i32, size.height as i32, system_window,
                )?)
            }
        };

        self.last_size = Some(size);
        self.webview = Some(webview);
        window.set_visible(true);
        self.window = Some(window);
        Ok(())
    }

    fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), Box<dyn Error>> {
        if size.width == 0 || size.height == 0 || self.last_size == Some(size) {
            return Ok(());
        }
        if let Some(webview) = &self.webview {
            // Win32 and WebView2 share the same physical client coordinates.
            match webview {
                View::Child(view) => view.set_bounds(client_bounds(size))?,
                View::Composition(view) => view.resize(size.width as i32, size.height as i32)?,
            }
            self.last_size = Some(size);
        }
        Ok(())
    }

    fn publish_window_state(&mut self) {
        let (Some(window), Some(webview)) = (&self.window, &self.webview) else {
            return;
        };
        let maximized = window.is_maximized();
        if self.last_maximized == Some(maximized) {
            return;
        }
        let script = format!(
            "window.dispatchEvent(new CustomEvent('ash-native-window-maximized', {{ detail: {maximized} }}))"
        );
        let delivered = match webview {
            View::Child(view) => view.evaluate_script(&script).is_ok(),
            View::Composition(view) => view.evaluate(&script).is_ok(),
        };
        if delivered {
            self.last_maximized = Some(maximized);
        }
    }
}

impl ApplicationHandler<WindowCommand> for Desktop {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none()
            && let Err(error) = self.open(event_loop)
        {
            self.failure = Some(error);
            event_loop.exit();
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: WindowCommand) {
        let Some(window) = &self.window else {
            return;
        };
        match command {
            WindowCommand::Minimize => window.set_minimized(true),
            WindowCommand::ToggleMaximize => window.set_maximized(!window.is_maximized()),
            WindowCommand::Close => event_loop.exit(),
            WindowCommand::ReadState => self.last_maximized = None,
            WindowCommand::Resize(direction) if !window.is_maximized() => {
                let _ = window.drag_resize_window(direction);
            }
            WindowCommand::Resize(_) => {}
        }
        self.publish_window_state();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(window) = &self.window else {
            return;
        };
        if window.id() != id {
            return;
        }
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Err(error) = self.resize(size) {
                    self.failure = Some(error);
                    event_loop.exit();
                }
                self.publish_window_state();
            }
            _ => {}
        }
    }
}

fn client_bounds(size: PhysicalSize<u32>) -> Rect {
    Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: size.into(),
    }
}

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    // The startup ticket travels over the launcher's pipe, not in process arguments.
    let mut line = String::new();
    io::stdin().lock().take(8192).read_line(&mut line)?;
    if !line.ends_with('\n') {
        return Err("Incomplete Workbench launch URL".into());
    }
    let url = Url::parse(line.trim_end()).map_err(|_| "Invalid Workbench launch URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/browser/workbench/workbench.html"
        || url.fragment().is_none()
    {
        return Err("The Workbench launch URL must target the local Ash Web listener".into());
    }
    let profile = std::env::var_os("ASH_NATIVE_DESKTOP_PROFILE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("An absolute WebView2 profile path is required")?;
    let event_loop = EventLoop::<WindowCommand>::with_user_event().build()?;
    let (host, _apartment) = match std::env::var("ASH_NATIVE_DESKTOP_VIEW").as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("child") => {
            (Host::Child(WebContext::new(Some(profile))), None)
        }
        Ok("composition") => (Host::Composition(profile), Some(Apartment::initialize()?)),
        _ => return Err("ASH_NATIVE_DESKTOP_VIEW must be child or composition".into()),
    };
    if matches!(host, Host::Composition(_)) {
        crate::appwindow::bootstrap()?;
    }
    let mut desktop = Desktop {
        webview: None,
        host,
        window: None,
        url,
        last_size: None,
        last_maximized: None,
        commands: event_loop.create_proxy(),
        failure: None,
    };
    event_loop.run_app(&mut desktop)?;
    match desktop.failure.take() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
