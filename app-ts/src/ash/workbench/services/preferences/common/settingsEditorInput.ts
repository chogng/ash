import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import type { EditorInput } from '../../editor/common/editorService.js';

export const SettingsEditorContentType = 'application/vnd.ash.settings-editor';
export const SettingsEditorResource = URI.parse('ash-settings-editor:/settings');
export const SettingsFileSystemScheme = 'ash-settings';
export const UserSettingsResource = URI.parse(`${SettingsFileSystemScheme}:/user/settings.json`);

/** Creates the singleton input routed to the Workbench Settings editor. */
export function createSettingsEditorInput(category?: string): EditorInput {
	return {
		resource: category ? SettingsEditorResource.with({ query: `category=${category}` }) : SettingsEditorResource,
		contentType: SettingsEditorContentType,
		label: 'Ash Settings',
		getIcon: () => Lxicon.settings,
		readOnly: true,
	};
}

export function isSettingsEditorInput(input: EditorInput): boolean {
	return input.contentType === SettingsEditorContentType || input.resource.toString() === SettingsEditorResource.toString();
}

/** Creates the editable JSONC projection of the current profile's user settings. */
export function createUserSettingsEditorInput(): EditorInput {
	return Object.freeze({
		resource: UserSettingsResource,
		languageId: 'jsonc',
		label: 'User Settings (JSON)',
	});
}
