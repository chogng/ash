/** Commands and navigation identifiers shared by the Chat workspace and its conversation sources. */
export const OPEN_EXTERNAL_CHAT_CONVERSATION_COMMAND_ID = 'sessions.chat.openExternalConversation';
export const OPEN_ASH_CHAT_WITH_MODEL_COMMAND = 'sessions.chat.openAshWithModel';
export const SHOW_ASH_CHAT_COMMAND = 'sessions.show.ashChat';
export const SHOW_CHAT_WORKSPACE_COMMAND = 'sessions.show.chatWorkspace';

/** Asks a Chat entry command to prepare its normal view without navigating to it. */
export const CHAT_WORKSPACE_ENTRY_REQUEST = 'resolveEntry';

// Keep the persisted container ID for existing desktop sidebar layouts.
export const CHAT_WORKSPACE_NAVIGATION_ID = 'sessions.chatgpt.navigation';
export const ASH_CHAT_SELECTED_CONTEXT = 'sessions.activity.ashChatSelected';
export const CHAT_NAVIGATION_FOCUS_CONTEXT = 'chatNavigationFocused';

export const CHAT_WORKSPACE_LAST_BACKEND_KEY = 'sessions.chat.lastBackend';
