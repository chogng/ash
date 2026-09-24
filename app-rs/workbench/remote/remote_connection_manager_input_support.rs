use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollDelta;
use zui::input::MouseScrollDelta;
use zui::ui::ElementId;

use ash_settings::REMOTE_CONNECTION_MANAGER;
use ash_settings::REMOTE_CONNECTION_MANAGER_CLOSE;
use ash_settings::REMOTE_CONNECTION_MANAGER_CONNECT;
use ash_settings::REMOTE_CONNECTION_MANAGER_DELETE;
use ash_settings::REMOTE_CONNECTION_MANAGER_DIRECTORY;
use ash_settings::REMOTE_CONNECTION_MANAGER_HOST;
use ash_settings::REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT;
use ash_settings::REMOTE_CONNECTION_MANAGER_LIST;
use ash_settings::REMOTE_CONNECTION_MANAGER_NAME;
use ash_settings::REMOTE_CONNECTION_MANAGER_NEW;
use ash_settings::REMOTE_CONNECTION_MANAGER_SAVE;
use ash_settings::REMOTE_CONNECTION_MANAGER_STATUS;
use ash_settings::remote_connection_manager_item_index;

const MANAGER_ROWS_PER_WHEEL_STEP: f32 = 3.0;

pub(super) fn remote_connection_manager_scroll_command(delta: MouseScrollDelta) -> ScrollCommand {
    let pixels = match delta {
        MouseScrollDelta::LineDelta(_, vertical) => {
            vertical * MANAGER_ROWS_PER_WHEEL_STEP * REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT
        }
        MouseScrollDelta::PixelDelta(position) => position.y as f32,
    };
    ScrollCommand::ByPixels(ScrollDelta::vertical(-pixels))
}

pub(super) fn is_remote_connection_manager_element(id: ElementId, item_count: usize) -> bool {
    matches!(
        id,
        REMOTE_CONNECTION_MANAGER
            | REMOTE_CONNECTION_MANAGER_CLOSE
            | REMOTE_CONNECTION_MANAGER_NEW
            | REMOTE_CONNECTION_MANAGER_NAME
            | REMOTE_CONNECTION_MANAGER_HOST
            | REMOTE_CONNECTION_MANAGER_DIRECTORY
            | REMOTE_CONNECTION_MANAGER_SAVE
            | REMOTE_CONNECTION_MANAGER_DELETE
            | REMOTE_CONNECTION_MANAGER_CONNECT
            | REMOTE_CONNECTION_MANAGER_LIST
            | REMOTE_CONNECTION_MANAGER_STATUS
    ) || remote_connection_manager_item_index(id, item_count).is_some()
}
