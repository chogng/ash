import { RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";

export const CHAT_VIEW_CONTAINER_ID = "ash.chat";
export const CHAT_VIEW_ID = "ash.chat.view";
export const OPEN_CHAT_PERMISSIONS_COMMAND_ID = 'chat.permission';
export const OPEN_GUARDIAN_SETUP_COMMAND_ID = 'chat.guardian.setup';
export const OPEN_CHAT_COMMAND_ID = "workbench.action.chat.open";
export const NEW_CHAT_COMMAND_ID = "workbench.action.chat.new";
export const SHOW_CHAT_HISTORY_COMMAND_ID =
	"workbench.action.chat.showHistory";
export const TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID =
	'agentSessions.toggleAgentSessionsSidebar';
export const AgentSessionsSidebarVisibleContext = new RawContextKey<boolean>(
	'agentSessionsSidebarVisible',
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
