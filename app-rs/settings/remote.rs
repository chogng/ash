//! Remote connection and Tunnel state plus product presentation.
//!
//! Target validation, profile storage, runtime installation, SSH, and Tunnel lifecycle remain in
//! the `ash-rs/remote*` crates. The public API here is limited to resolved style, typed UI state,
//! and requests that the product host forwards to those capabilities.

mod interaction;
mod remote_connection_manager;
mod remote_connection_manager_view;
mod remote_connection_picker;
mod remote_tunnel_manager;
mod remote_tunnel_manager_view;
mod style;

pub use interaction::*;
pub use remote_connection_manager::*;
pub use remote_connection_manager_view::RemoteConnectionManager;
pub use remote_connection_picker::*;
pub use remote_tunnel_manager::*;
pub use remote_tunnel_manager_view::RemoteTunnelManager;
pub use style::RemoteUiStyle;

#[cfg(test)]
fn test_style() -> RemoteUiStyle {
    use ash_ui_components::{ScrollViewStyle, ScrollbarStyle};
    use zui::ui::Color;

    let scroll = ScrollViewStyle::new(ScrollbarStyle::new(
        Color::TRANSPARENT,
        Color::rgb(80, 80, 80),
    ));
    RemoteUiStyle::new(
        Color::WHITE,
        Color::rgb(246, 246, 247),
        Color::rgb(248, 248, 249),
        Color::rgb(222, 222, 224),
        Color::rgb(38, 38, 41),
        Color::rgb(126, 126, 132),
        Color::rgb(15, 110, 96),
        Color::rgb(180, 38, 38),
        Color::rgba(68, 139, 202, 72),
        Color::rgb(235, 235, 237),
        scroll,
        scroll,
    )
}
