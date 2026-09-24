import type { IKeyboardLayoutDefinition, IKeyboardLayoutProvider } from './keyboardLayout.js';
import { validateKeyboardLayoutDefinition } from './keyboardLayoutValidation.js';

export const NATIVE_KEYBOARD_LAYOUT_READ_CHANNEL = 'ash:keyboard-layout:read';
export const NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL = 'ash:keyboard-layout:changed';

export interface INativeKeyboardLayoutApi extends IKeyboardLayoutProvider {}

export function validateNativeKeyboardLayout(value: unknown): IKeyboardLayoutDefinition | undefined {
	return validateKeyboardLayoutDefinition(value, 'native');
}
