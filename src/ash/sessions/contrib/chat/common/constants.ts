export const NEW_SESSION_ACTION_ID = 'workbench.action.sessions.newChat';
export const OPEN_CHAT_CREATION_COMMAND_ID = 'sessions.artifacts.openDraft';
export const OPEN_EXTERNAL_CHAT_CONVERSATION_COMMAND_ID = 'sessions.chat.openExternalConversation';
export const NEW_SESSION_WELCOME_PHRASES_SETTING = 'sessions.chat.experimental.welcomePhrases';
export const NEW_SESSION_WELCOME_NAME_SETTING = 'sessions.chat.experimental.welcomeName';
export const NEW_SESSION_WELCOME_MESSAGES_SETTING = 'sessions.chat.experimental.welcomeMessages';
export const OPEN_ASH_CHAT_WITH_MODEL_COMMAND = 'sessions.chat.openAshWithModel';
export const SHOW_ASH_CHAT_COMMAND = 'sessions.show.ashChat';
export const SHOW_CHAT_WORKSPACE_COMMAND = 'sessions.show.chatWorkspace';
/** Asks a Chat entry command to prepare its normal view without navigating to it. */
export const CHAT_WORKSPACE_ENTRY_REQUEST = 'resolveEntry';
export const ASH_CHAT_SELECTED_CONTEXT = 'sessions.activity.ashChatSelected';
export const SESSIONS_COMPACT_INPUT_HEIGHT = Object.freeze({ minimum: 0, maximum: 240 });
// A 20-turn history page can already contain 60 prompt, tool and reply rows.
export const CHAT_HISTORY_VIRTUALIZE_FROM = 48;
// Keep the persisted container ID for existing desktop sidebar layouts.
export const CHAT_WORKSPACE_NAVIGATION_ID = 'sessions.chatgpt.navigation';
export const CHAT_NAVIGATION_FOCUS_CONTEXT = 'chatNavigationFocused';
export const CHAT_WORKSPACE_LAST_BACKEND_KEY = 'sessions.chat.lastBackend';

export const OPEN_ARTIFACT_CONVERSATION_COMMAND_ID = 'sessions.artifacts.openArtifactConversation';
