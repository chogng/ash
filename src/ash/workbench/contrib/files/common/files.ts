import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/** Registered workspace file view used by the Explorer and other contributions. */
export const VIEW_ID = 'ash.explorer';
export const OpenEditorsFocusedContext = new RawContextKey<boolean>('openEditorsFocus', false);
