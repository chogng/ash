import { RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";

export const CHAT_VIEW_CONTAINER_ID = "ash.chat";
export const CHAT_VIEW_ID = "ash.chat.view";
export const OPEN_CHAT_COMMAND_ID = "workbench.action.chat.open";
export const NEW_CHAT_COMMAND_ID = "workbench.action.chat.new";
export const SHOW_CHAT_HISTORY_COMMAND_ID =
	"workbench.action.chat.showHistory";
export const TOGGLE_SESSION_INSPECTOR_COMMAND_ID =
	"workbench.action.chat.toggleSessionInspector";
export const ChatSessionInspectorVisibleContext = new RawContextKey<boolean>(
	"chatSessionInspectorVisible",
	false,
);
export const OPEN_CHAT_BROWSER_COMMAND_ID =
	"workbench.action.chat.openBrowser";
export const MOVE_CHAT_TO_EDITOR_COMMAND_ID =
	"workbench.action.chat.moveToEditor";
export const MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID =
	"workbench.action.chat.moveToNewWindow";
export const OPEN_CHAT_SETTINGS_COMMAND_ID =
	"workbench.action.chat.openSettings";
