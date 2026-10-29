import type { IKeyboardLayoutDefinition, IKeyboardLayoutProvider } from './keyboardLayout.js';
import { validateKeyboardLayoutDefinition } from './keyboardLayoutValidation.js';


export interface INativeKeyboardLayoutApi extends IKeyboardLayoutProvider { }

export function validateNativeKeyboardLayout(value: unknown): IKeyboardLayoutDefinition | undefined {
	return validateKeyboardLayoutDefinition(value, 'native');
}
