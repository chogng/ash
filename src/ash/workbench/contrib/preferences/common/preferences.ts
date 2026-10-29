import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/** Stable command identities shared by Preferences contributions and callers. */
export const OpenSettingsCommandId = 'workbench.action.openSettings';
export const OpenSettingsJsonCommandId = 'workbench.action.openSettingsJson';
export const OpenSettingsUICommandId = 'workbench.action.openSettings2';
export const OpenKeyboardShortcutsCommandId = 'workbench.action.openKeyboardShortcuts';
export const ChangeKeyboardLayoutCommandId = 'workbench.action.changeKeyboardLayout';
export const InspectKeyMappingsCommandId = 'workbench.action.inspectKeyMappings';
export const InspectKeyMappingsJsonCommandId = 'workbench.action.inspectKeyMappingsJSON';
export const ToggleKeyboardShortcutsTroubleshootingCommandId =
	'workbench.action.toggleKeyboardShortcutsTroubleshooting';

export const KEYBINDINGS_EDITOR_COMMAND_RECORD_SEARCH_KEYS = 'keybindings.editor.recordSearchKeys';
export const KEYBINDINGS_EDITOR_COMMAND_SORTBY_PRECEDENCE = 'keybindings.editor.toggleSortByPrecedence';
export const KEYBINDINGS_EDITOR_COMMAND_CLEAR_SEARCH_RESULTS = 'keybindings.editor.clearSearchResults';
export const CONTEXT_KEYBINDINGS_EDITOR = new RawContextKey<boolean>('inKeybindings', false);
export const CONTEXT_KEYBINDINGS_SEARCH_FOCUS = new RawContextKey<boolean>('inKeybindingsSearch', false);
export const CONTEXT_KEYBINDINGS_SEARCH_HAS_VALUE = new RawContextKey<boolean>('keybindingsSearchHasValue', false);

/** Stable navigation target used by language-server commands and Preferences. */
export const LanguageServerSettingsTarget = 'editor-language.group.language-servers';
