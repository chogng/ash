import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';

export const NewSessionPickersAvailableContext = new RawContextKey<boolean>('sessions.newSessionPickersAvailable', false);

export const FOCUS_NEW_SESSION_WORKSPACE_PICKER_KEYBINDING = KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF);
export const FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_KEYBINDING = KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyE);

const focusNewSessionPickerWhen = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), NewSessionPickersAvailableContext.isEqualTo(true), ChatContextKeys.inChatInput.isEqualTo(true));
export const FOCUS_NEW_SESSION_WORKSPACE_PICKER_WHEN = focusNewSessionPickerWhen;
export const FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_WHEN = focusNewSessionPickerWhen;
