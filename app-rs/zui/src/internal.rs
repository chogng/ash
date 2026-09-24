//! Private native integration bridge shared by public capability owners.

pub(crate) use crate::app::native_host::ApplicationRunError;
pub(crate) use crate::app::native_host::ControlFlow;
pub(crate) use crate::app::native_host::NativeEventLoopClosed;
pub(crate) use crate::app::native_host::NativeEventLoopOptions;
pub(crate) use crate::app::native_host::NativeEventProxy;
pub(crate) use crate::app::native_host::run_application_with_user_events;
pub(crate) use winit::application::ApplicationHandler;
pub(crate) use winit::event::DeviceEvent as NativeDeviceEvent;
pub(crate) use winit::event::DeviceId as NativeDeviceId;
pub(crate) use winit::event::WindowEvent as NativeWindowEvent;
pub(crate) use winit::event_loop::ActiveEventLoop;
pub(crate) use winit::window::WindowId as NativeWindowId;
