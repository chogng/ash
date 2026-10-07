import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';
import { EditorInputSerializers, requireString } from '../../editor/common/editorInputSerializer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

export const KeyboardShortcutsEditorContentType = 'application/vnd.ash.keyboard-shortcuts';
export const KeyboardShortcutsEditorResource = URI.parse('ash-preferences:/keyboard-shortcuts');

/** Creates the singleton editor input used by the Keyboard Shortcuts tab. */
export function createKeyboardShortcutsEditorInput(): IResourceEditorInput {
	return {
		resource: KeyboardShortcutsEditorResource,
		contentType: KeyboardShortcutsEditorContentType,
		label: 'Keyboard Shortcuts',
		readOnly: true,
	};
}

export function isKeyboardShortcutsEditorInput(input: IResourceEditorInput): boolean {
	return input.contentType === KeyboardShortcutsEditorContentType || input.resource.toString() === KeyboardShortcutsEditorResource.toString();
}

/** Uses the profile resource identity shared by the text model and shortcut services. */
export function createKeybindingsJsonEditorInput(resource: URI): IResourceEditorInput {
	return Object.freeze({
		resource,
		languageId: 'jsonc',
		get label(): string { return localize({ bundle: 'ash', key: 'keybindings.jsonLabel' }, 'Keyboard Shortcuts (JSON)'); },
	});
}

EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.keybindingsJson',
	canSerialize: input => input.resource.scheme === Schemas.vscodeUserData && input.resource.path === '/user/keybindings.json' && !input.resource.authority && !input.resource.query && !input.resource.fragment,
	serialize: input => input.resource.toString(),
	deserialize: value => {
		const resource = URI.parse(requireString(value, 'keybindings JSON resource'));
		if (resource.scheme !== Schemas.vscodeUserData || resource.path !== '/user/keybindings.json' || resource.authority || resource.query || resource.fragment) throw new TypeError('Invalid keybindings JSON resource');
		return createKeybindingsJsonEditorInput(resource);
	},
});
