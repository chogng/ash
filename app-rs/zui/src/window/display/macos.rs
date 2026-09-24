#![allow(unsafe_code)]

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use core_graphics::display::CGDisplay;
use core_graphics::event::CGEvent;
use core_graphics::event_source::CGEventSource;
use core_graphics::event_source::CGEventSourceStateID;
use objc2_app_kit::NSApplicationDidChangeScreenParametersNotification;
use objc2_app_kit::NSScreen;
use objc2_foundation::NSNotification;
use objc2_foundation::NSNotificationCenter;

use super::CursorPositionError;
use crate::window::PhysicalBounds;
use crate::window::PhysicalExtent;
use crate::window::PhysicalPosition;

pub(super) fn rotation_degrees(display_id: u32) -> f64 {
    CGDisplay::new(display_id).rotation()
}

pub(super) fn is_internal(display_id: u32) -> bool {
    CGDisplay::new(display_id).is_builtin()
}

pub(super) fn cursor_screen_position(
    monitors: impl IntoIterator<Item = (u32, f64)>,
) -> Result<PhysicalPosition, CursorPositionError> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|()| {
        CursorPositionError::platform(std::io::Error::other(
            "Core Graphics could not create an event source",
        ))
    })?;
    let point = CGEvent::new(source)
        .map_err(|()| {
            CursorPositionError::platform(std::io::Error::other(
                "Core Graphics could not create a cursor-location event",
            ))
        })?
        .location();
    let scale_factor = monitors
        .into_iter()
        .find_map(|(display_id, scale_factor)| {
            let bounds = CGDisplay::new(display_id).bounds();
            let right = bounds.origin.x + bounds.size.width;
            let bottom = bounds.origin.y + bounds.size.height;
            (point.x >= bounds.origin.x
                && point.x < right
                && point.y >= bounds.origin.y
                && point.y < bottom)
                .then_some(scale_factor)
        })
        .ok_or_else(|| {
            CursorPositionError::platform(std::io::Error::other(
                "the cursor is not inside a connected Core Graphics display",
            ))
        })?;
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    Ok(PhysicalPosition::new(
        point.x * scale_factor,
        point.y * scale_factor,
    ))
}

pub(super) fn work_area(
    ns_screen: *mut c_void,
    bounds: PhysicalBounds,
    scale_factor: f64,
) -> Option<PhysicalBounds> {
    // SAFETY: winit returns the NSScreen backing this live MonitorHandle. The caller invokes this
    // synchronously on winit's main event-loop thread and does not retain the borrowed object.
    let screen = unsafe { ns_screen.cast::<NSScreen>().as_ref() }?;
    let frame = screen.frame();
    let visible = screen.visibleFrame();
    let values = [
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
        visible.origin.x,
        visible.origin.y,
        visible.size.width,
        visible.size.height,
        scale_factor,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return None;
    }

    let frame_right = frame.origin.x + frame.size.width;
    let frame_top = frame.origin.y + frame.size.height;
    let visible_right = visible.origin.x + visible.size.width;
    let visible_top = visible.origin.y + visible.size.height;
    let extent = bounds.extent();
    let left = physical_inset(
        visible.origin.x - frame.origin.x,
        scale_factor,
        extent.width,
    );
    let right = physical_inset(
        frame_right - visible_right,
        scale_factor,
        extent.width - left,
    );
    let bottom = physical_inset(
        visible.origin.y - frame.origin.y,
        scale_factor,
        extent.height,
    );
    let top = physical_inset(
        frame_top - visible_top,
        scale_factor,
        extent.height - bottom,
    );
    let position = bounds.position();
    Some(PhysicalBounds::new(
        PhysicalPosition::new(position.x + f64::from(left), position.y + f64::from(top)),
        PhysicalExtent::new(extent.width - left - right, extent.height - top - bottom),
    ))
}

fn physical_inset(logical: f64, scale_factor: f64, remaining: u32) -> u32 {
    (logical.max(0.0) * scale_factor)
        .round()
        .min(f64::from(remaining)) as u32
}

pub(super) struct ChangeMonitor {
    remove_observer: Option<Box<dyn FnOnce()>>,
}

impl ChangeMonitor {
    pub(super) fn new(pending: Rc<Cell<bool>>) -> Self {
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            pending.set(true);
        });
        // SAFETY: the event loop and this monitor are created and dropped on AppKit's main thread.
        // The retained center and observer token live in the cleanup closure until Drop.
        let center = unsafe { NSNotificationCenter::defaultCenter() };
        // SAFETY: the block has a 'static capture, no sender filter is required, and a null queue
        // asks Foundation to invoke it synchronously on the notification's main posting thread.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidChangeScreenParametersNotification),
                None,
                None,
                &block,
            )
        };
        let remove_observer = Box::new(move || {
            // SAFETY: center and observer remain retained by this closure and removal occurs once.
            unsafe { center.removeObserver(&observer) };
        });
        Self {
            remove_observer: Some(remove_observer),
        }
    }
}

impl Drop for ChangeMonitor {
    fn drop(&mut self) {
        if let Some(remove_observer) = self.remove_observer.take() {
            remove_observer();
        }
    }
}
