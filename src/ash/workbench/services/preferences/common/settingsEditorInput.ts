import { Schemas } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputSerializers } from '../../editor/common/editorInputSerializer.js';

export const SettingsEditorContentType = 'application/vnd.ash.settings-editor';
export const SettingsEditorResource = URI.parse('ash-settings-editor:/settings');
export const UserSettingsResource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' });

/** Shared resource identity; each group host owns its pane and opening options. */
export class SettingsEditorInput extends Disposable implements IResourceEditorInput {
	public readonly resource = SettingsEditorResource;
	public readonly contentType = SettingsEditorContentType;
	public readonly readOnly = true;

	public get label(): string {
		return localize({ bundle: 'ash.settings', key: 'chrome.modalTitle' }, 'Ash Settings');
	}
	public getIcon(): typeof Lxicon.settings {
		return Lxicon.settings;
	}
}

/** Creates the singleton input routed to the Workbench Settings editor. */
export function createSettingsEditorInput(
	target?: string,
	parameters: Readonly<Record<string, string>> = {},
): IResourceEditorInput {
	const query = Object.entries(target ? { ...parameters, target } : parameters)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');
	return {
		resource: SettingsEditorResource.with({ query }),
		contentType: SettingsEditorContentType,
		get label(): string {
			return localize({ bundle: 'ash.settings', key: 'chrome.modalTitle' }, 'Ash Settings');
		},
		getIcon: () => Lxicon.settings,
		readOnly: true,
	};
}

export function isSettingsEditorInput(input: IResourceEditorInput): boolean {
	return (
		input.contentType === SettingsEditorContentType ||
		input.resource.toString() === SettingsEditorResource.toString()
	);
}

/** Opens the current profile settings file as an editable JSONC resource. */
export function createUserSettingsEditorInput(): IResourceEditorInput {
	return Object.freeze({
		resource: UserSettingsResource,
		languageId: 'jsonc',
		get label(): string {
			return localize({ bundle: 'ash.settings', key: 'json.editorLabel' }, 'User Settings (JSON)');
		},
	});
}

// Working sets persist identity, while the restored input resolves its label in the new locale.
EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.userSettings',
	canSerialize: input => input.resource.toString() === UserSettingsResource.toString(),
	serialize: () => UserSettingsResource.toString(),
	deserialize: value => {
		if (value !== UserSettingsResource.toString() && value !== 'ash-settings:/user/settings.json')
			throw new TypeError('Invalid user settings editor resource');
		return createUserSettingsEditorInput();
	},
});
