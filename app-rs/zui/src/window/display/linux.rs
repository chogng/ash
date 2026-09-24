use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt;

use super::CursorPositionError;
use crate::window::PhysicalPosition;

pub(super) fn cursor_screen_position() -> Result<PhysicalPosition, CursorPositionError> {
    let (connection, screen_index) = x11rb::connect(None).map_err(CursorPositionError::platform)?;
    let screen = connection.setup().roots.get(screen_index).ok_or_else(|| {
        CursorPositionError::platform(std::io::Error::other(
            "the X11 connection did not expose its default screen",
        ))
    })?;
    let pointer = connection
        .query_pointer(screen.root)
        .map_err(CursorPositionError::platform)?
        .reply()
        .map_err(CursorPositionError::platform)?;
    Ok(PhysicalPosition::new(
        f64::from(pointer.root_x),
        f64::from(pointer.root_y),
    ))
}
