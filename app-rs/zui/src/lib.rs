//! Reusable native UI framework capabilities for Ash applications.
//!
//! Public capability modules are also the physical source owners. Native adapters and backend
//! glue remain private, while product state and reusable product components stay outside ZUI.

#![deny(unsafe_code)]

#[cfg(feature = "native")]
pub mod accessibility;
#[cfg(feature = "native")]
pub mod app;
#[cfg(feature = "native")]
pub mod devtools;
#[cfg(feature = "native")]
pub mod distribution;
#[cfg(feature = "native")]
pub mod input;
#[cfg(feature = "native")]
mod internal;
pub mod prelude;
pub mod render;
pub mod runtime;
#[cfg(feature = "native")]
pub mod services;
#[cfg(feature = "native")]
pub mod task;
#[cfg(feature = "native")]
pub mod testing;
pub mod ui;
#[cfg(feature = "native")]
pub mod window;

pub use render::RenderOutcome;
pub use render::RenderTargetSize;
pub use render::Renderer;
pub use render::RendererError;
pub use ui::*;

#[cfg(feature = "native")]
pub use crate::app::App;
#[cfg(feature = "native")]
pub use crate::app::AppContext;
#[cfg(feature = "native")]
pub use crate::app::AppDisconnected;
#[cfg(feature = "native")]
pub use crate::app::AppProxy;
#[cfg(feature = "native")]
pub use crate::app::AppProxy as EventLoopProxy;
#[cfg(feature = "native")]
pub use crate::app::Application;
#[cfg(feature = "native")]
pub use crate::app::ApplicationBuilder;
#[cfg(feature = "native")]
pub use crate::app::ApplicationError;
#[cfg(feature = "native")]
pub use crate::app::ApplicationExit;
#[cfg(feature = "native")]
pub use crate::app::ApplicationHandle;
#[cfg(feature = "native")]
pub use crate::app::ApplicationRunError;
#[cfg(feature = "native")]
pub use crate::app::ApplicationRunError as EventLoopError;
#[cfg(feature = "native")]
pub use crate::app::ControlFlow;
#[cfg(feature = "native")]
pub use crate::app::ExitPolicy;
#[cfg(feature = "native")]
pub use crate::app::WindowContext;
#[cfg(feature = "native")]
pub use render::RendererFactory;
#[cfg(feature = "wgpu")]
pub use render::WgpuRendererFactory;
#[cfg(feature = "native")]
pub use runtime::BackgroundExecutor;
#[cfg(feature = "native")]
pub use runtime::Task;
#[cfg(feature = "native")]
pub use runtime::TaskScope;
#[cfg(feature = "native")]
pub use runtime::Timer;
#[cfg(feature = "native")]
pub use runtime::TimerId;
#[cfg(feature = "native")]
pub use runtime::TimerScheduleError;
#[cfg(feature = "native")]
pub use runtime::TimerScheduler;
#[cfg(feature = "native")]
pub use services::Clipboard;
#[cfg(feature = "native")]
pub use services::ClipboardError;
#[cfg(feature = "native")]
pub use services::ClipboardHandle;
#[cfg(feature = "native")]
pub use services::ClipboardHtml;
#[cfg(feature = "native")]
pub use services::ClipboardImage;
#[cfg(feature = "native")]
pub use services::SystemClipboard;
#[cfg(feature = "native")]
pub use testing as testkit;
#[cfg(feature = "native")]
pub use window::*;

#[cfg(test)]
#[path = "architecture_tests.rs"]
mod architecture_tests;
