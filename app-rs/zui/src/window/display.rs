use winit::monitor::MonitorHandle;
use winit::monitor::VideoModeHandle;

use super::PhysicalBounds;
use super::PhysicalExtent;
use super::PhysicalPosition;

mod change;
mod cursor;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod query;
mod watch;
#[cfg(target_os = "windows")]
mod windows;

pub use change::DisplayEvent;
pub use change::DisplayMetricChanges;
pub use cursor::CursorPositionError;
pub(crate) use watch::DisplayChangeMonitor;
#[cfg(target_os = "windows")]
pub(crate) use windows::is_change_message;

/// Backend-independent identity reported for one connected display.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DisplayId(String);

impl DisplayId {
    /// Creates an identity supplied by a custom or deterministic display source.
    pub fn from_raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the backend-owned identity string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(target_os = "macos")]
    fn from_native(monitor: &MonitorHandle) -> Self {
        use winit::platform::macos::MonitorHandleExtMacOS;

        Self(format!("macos:{}", monitor.native_id()))
    }

    #[cfg(target_os = "windows")]
    fn from_native(monitor: &MonitorHandle) -> Self {
        use winit::platform::windows::MonitorHandleExtWindows;

        Self(format!("windows:{}", monitor.native_id()))
    }

    #[cfg(target_os = "linux")]
    fn from_native(monitor: &MonitorHandle) -> Self {
        use winit::platform::x11::MonitorHandleExtX11;

        Self(format!("linux:{}", monitor.native_id()))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    fn from_native(monitor: &MonitorHandle) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        Self(format!(
            "display:{}:{}:{}:{}:{}",
            monitor.name().unwrap_or_default(),
            position.x,
            position.y,
            size.width,
            size.height,
        ))
    }
}

/// One fullscreen video mode advertised by a connected display.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DisplayMode {
    extent: PhysicalExtent,
    bit_depth: u16,
    refresh_rate_millihertz: u32,
}

impl DisplayMode {
    /// Creates an explicit display mode snapshot.
    pub const fn new(extent: PhysicalExtent, bit_depth: u16, refresh_rate_millihertz: u32) -> Self {
        Self {
            extent,
            bit_depth,
            refresh_rate_millihertz,
        }
    }

    /// Returns the physical pixel dimensions.
    pub const fn extent(self) -> PhysicalExtent {
        self.extent
    }

    /// Returns the total number of color bits reported by the backend.
    pub const fn bit_depth(self) -> u16 {
        self.bit_depth
    }

    /// Returns refresh rate in thousandths of a hertz.
    pub const fn refresh_rate_millihertz(self) -> u32 {
        self.refresh_rate_millihertz
    }

    fn from_native(mode: VideoModeHandle) -> Self {
        let size = mode.size();
        Self::new(
            PhysicalExtent::new(size.width, size.height),
            mode.bit_depth(),
            mode.refresh_rate_millihertz(),
        )
    }
}

/// Clockwise orientation reported for a connected display.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum DisplayRotation {
    /// No clockwise rotation.
    Degrees0,
    /// Ninety degrees clockwise.
    Degrees90,
    /// One hundred eighty degrees clockwise.
    Degrees180,
    /// Two hundred seventy degrees clockwise.
    Degrees270,
}

impl DisplayRotation {
    /// Returns the clockwise orientation in degrees.
    pub const fn degrees(self) -> u16 {
        match self {
            Self::Degrees0 => 0,
            Self::Degrees90 => 90,
            Self::Degrees180 => 180,
            Self::Degrees270 => 270,
        }
    }

    #[cfg(target_os = "macos")]
    fn from_degrees(degrees: f64) -> Option<Self> {
        if !degrees.is_finite() {
            return None;
        }
        let degrees = degrees.rem_euclid(360.0);
        if !(0.5..359.5).contains(&degrees) {
            Some(Self::Degrees0)
        } else if (degrees - 90.0).abs() < 0.5 {
            Some(Self::Degrees90)
        } else if (degrees - 180.0).abs() < 0.5 {
            Some(Self::Degrees180)
        } else if (degrees - 270.0).abs() < 0.5 {
            Some(Self::Degrees270)
        } else {
            None
        }
    }
}

/// Immutable topology and mode snapshot for one connected display.
#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    id: DisplayId,
    name: Option<String>,
    bounds: PhysicalBounds,
    work_area: Option<PhysicalBounds>,
    rotation: Option<DisplayRotation>,
    internal: Option<bool>,
    scale_factor: f64,
    refresh_rate_millihertz: Option<u32>,
    video_modes: Vec<DisplayMode>,
}

impl Display {
    /// Creates a display snapshot without optional refresh or fullscreen-mode information.
    pub fn new(
        id: DisplayId,
        name: Option<String>,
        bounds: PhysicalBounds,
        scale_factor: f64,
    ) -> Self {
        Self {
            id,
            name,
            bounds,
            work_area: None,
            rotation: None,
            internal: None,
            scale_factor: valid_scale_factor(scale_factor),
            refresh_rate_millihertz: None,
            video_modes: Vec::new(),
        }
    }

    /// Attaches the usable physical bounds after platform-reserved screen areas are removed.
    pub const fn with_work_area(mut self, work_area: PhysicalBounds) -> Self {
        self.work_area = Some(work_area);
        self
    }

    /// Attaches the display orientation reported by the platform.
    pub const fn with_rotation(mut self, rotation: DisplayRotation) -> Self {
        self.rotation = Some(rotation);
        self
    }

    /// Marks whether the platform classifies this as a built-in display.
    pub const fn with_internal(mut self, internal: bool) -> Self {
        self.internal = Some(internal);
        self
    }

    /// Attaches the display's active refresh rate.
    pub const fn with_refresh_rate(mut self, refresh_rate_millihertz: Option<u32>) -> Self {
        self.refresh_rate_millihertz = refresh_rate_millihertz;
        self
    }

    /// Attaches the available fullscreen video modes.
    pub fn with_video_modes(mut self, video_modes: Vec<DisplayMode>) -> Self {
        self.video_modes = video_modes;
        self
    }

    /// Returns the backend-independent display identity.
    pub const fn id(&self) -> &DisplayId {
        &self.id
    }

    /// Returns the human-readable platform display name when available.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Returns global physical screen bounds.
    pub const fn bounds(&self) -> PhysicalBounds {
        self.bounds
    }

    /// Returns usable physical bounds when the platform can report reserved screen areas.
    pub const fn work_area(&self) -> Option<PhysicalBounds> {
        self.work_area
    }

    /// Returns the clockwise display orientation when the platform reports it.
    pub const fn rotation(&self) -> Option<DisplayRotation> {
        self.rotation
    }

    /// Returns whether this is a built-in display when the platform can classify it.
    pub const fn is_internal(&self) -> Option<bool> {
        self.internal
    }

    /// Returns the physical-to-logical scale factor reported for this display.
    pub const fn scale_factor(&self) -> f64 {
        self.scale_factor
    }

    /// Returns the currently active refresh rate in thousandths of a hertz.
    pub const fn refresh_rate_millihertz(&self) -> Option<u32> {
        self.refresh_rate_millihertz
    }

    /// Returns fullscreen video modes advertised for this display.
    pub fn video_modes(&self) -> &[DisplayMode] {
        &self.video_modes
    }

    fn from_native(monitor: &MonitorHandle) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        let bounds = PhysicalBounds::new(
            PhysicalPosition::new(f64::from(position.x), f64::from(position.y)),
            PhysicalExtent::new(size.width, size.height),
        );
        let scale_factor = monitor.scale_factor();
        let mut display = Self::new(
            DisplayId::from_native(monitor),
            monitor.name(),
            bounds,
            scale_factor,
        );
        if let Some(work_area) = native_work_area(monitor, bounds, scale_factor) {
            display = display.with_work_area(work_area);
        }
        if let Some(rotation) = native_rotation(monitor) {
            display = display.with_rotation(rotation);
        }
        if let Some(internal) = native_internal(monitor) {
            display = display.with_internal(internal);
        }
        display
            .with_refresh_rate(monitor.refresh_rate_millihertz())
            .with_video_modes(
                monitor
                    .video_modes()
                    .map(DisplayMode::from_native)
                    .collect(),
            )
    }
}

#[cfg(target_os = "macos")]
fn native_rotation(monitor: &MonitorHandle) -> Option<DisplayRotation> {
    use winit::platform::macos::MonitorHandleExtMacOS;

    DisplayRotation::from_degrees(macos::rotation_degrees(monitor.native_id()))
}

#[cfg(target_os = "windows")]
fn native_rotation(monitor: &MonitorHandle) -> Option<DisplayRotation> {
    use winit::platform::windows::MonitorHandleExtWindows;

    windows::rotation(monitor.hmonitor())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_rotation(_monitor: &MonitorHandle) -> Option<DisplayRotation> {
    None
}

#[cfg(target_os = "macos")]
fn native_internal(monitor: &MonitorHandle) -> Option<bool> {
    use winit::platform::macos::MonitorHandleExtMacOS;

    Some(macos::is_internal(monitor.native_id()))
}

#[cfg(not(target_os = "macos"))]
fn native_internal(_monitor: &MonitorHandle) -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
fn native_work_area(
    monitor: &MonitorHandle,
    bounds: PhysicalBounds,
    scale_factor: f64,
) -> Option<PhysicalBounds> {
    use winit::platform::macos::MonitorHandleExtMacOS;

    macos::work_area(
        monitor.ns_screen()?,
        bounds,
        valid_scale_factor(scale_factor),
    )
}

#[cfg(target_os = "windows")]
fn native_work_area(
    monitor: &MonitorHandle,
    _bounds: PhysicalBounds,
    _scale_factor: f64,
) -> Option<PhysicalBounds> {
    use winit::platform::windows::MonitorHandleExtWindows;

    windows::work_area(monitor.hmonitor())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_work_area(
    _monitor: &MonitorHandle,
    _bounds: PhysicalBounds,
    _scale_factor: f64,
) -> Option<PhysicalBounds> {
    None
}

/// All connected displays plus primary/current identities captured at one instant.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DisplaySnapshot {
    displays: Vec<Display>,
    primary: Option<DisplayId>,
    current: Option<DisplayId>,
}

impl DisplaySnapshot {
    /// Creates a deterministic snapshot, discarding primary/current identities not in `displays`.
    pub fn new(
        displays: Vec<Display>,
        primary: Option<DisplayId>,
        current: Option<DisplayId>,
    ) -> Self {
        let contains =
            |candidate: &DisplayId| displays.iter().any(|display| display.id() == candidate);
        Self {
            primary: primary.filter(&contains),
            current: current.filter(&contains),
            displays,
        }
    }

    /// Returns all displays in backend topology order.
    pub fn displays(&self) -> &[Display] {
        &self.displays
    }

    /// Returns the platform primary display when one is reported.
    pub fn primary(&self) -> Option<&Display> {
        self.primary
            .as_ref()
            .and_then(|id| self.displays.iter().find(|display| display.id() == id))
    }

    /// Returns the display containing the querying window when one is reported.
    pub fn current(&self) -> Option<&Display> {
        self.current
            .as_ref()
            .and_then(|id| self.displays.iter().find(|display| display.id() == id))
    }

    pub(crate) fn from_native(
        monitors: impl IntoIterator<Item = MonitorHandle>,
        primary: Option<MonitorHandle>,
        current: Option<MonitorHandle>,
    ) -> Self {
        let displays = monitors
            .into_iter()
            .map(|monitor| Display::from_native(&monitor))
            .collect();
        Self::new(
            displays,
            primary.as_ref().map(DisplayId::from_native),
            current.as_ref().map(DisplayId::from_native),
        )
    }
}

pub(crate) fn cursor_screen_position(
    event_loop: &winit::event_loop::ActiveEventLoop,
) -> Result<PhysicalPosition, CursorPositionError> {
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::MonitorHandleExtMacOS;

        let monitors = event_loop
            .available_monitors()
            .map(|monitor| (monitor.native_id(), monitor.scale_factor()));
        macos::cursor_screen_position(monitors)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = event_loop;
        windows::cursor_screen_position()
    }
    #[cfg(target_os = "linux")]
    {
        use winit::platform::wayland::ActiveEventLoopExtWayland;

        if event_loop.is_wayland() {
            Err(CursorPositionError::Unsupported)
        } else {
            linux::cursor_screen_position()
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = event_loop;
        Err(CursorPositionError::Unsupported)
    }
}

const fn valid_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;
