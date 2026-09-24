import { URI } from '../../../../base/common/uri.js';
import type { EditorInput } from '../../editor/common/editorService.js';

export const KeyboardShortcutsEditorContentType = 'application/vnd.ash.keyboard-shortcuts';
export const KeyboardShortcutsEditorResource = URI.parse('ash-preferences:/keyboard-shortcuts');

/** Creates the singleton editor input used by the Keyboard Shortcuts tab. */
export function createKeyboardShortcutsEditorInput(): EditorInput {
	return {
		resource: KeyboardShortcutsEditorResource,
		contentType: KeyboardShortcutsEditorContentType,
		label: 'Keyboard Shortcuts',
		readOnly: true,
	};
}

export function isKeyboardShortcutsEditorInput(input: EditorInput): boolean {
	return input.contentType === KeyboardShortcutsEditorContentType || input.resource.toString() === KeyboardShortcutsEditorResource.toString();
}
