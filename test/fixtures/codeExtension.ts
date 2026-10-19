import { prepareClientEditorExtension, startClientEditorExtension } from './clientEditorExtension.js';

export function prepareCodeExtension(): void {
	prepareClientEditorExtension('ash-code-editor');
}

export function startCodeExtension(language = 'en') {
	return startClientEditorExtension('ash-code-editor', 'ash.code', language);
}
