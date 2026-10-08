import { AbstractDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IOpenSettingsOptions } from './preferences.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputSerializers } from '../../editor/common/editorInputSerializer.js';

export const SettingsEditorContentType = 'application/vnd.ash.settings-editor';
export const SettingsEditorResource = URI.parse('ash-settings-editor:/settings');
export const SettingsFileSystemScheme = 'ash-settings';
export const UserSettingsResource = URI.parse(`${SettingsFileSystemScheme}:/user/settings.json`);

/** Preferences owns the fixed resource; the active pane owns its opening delegate. */
export class SettingsEditorInput extends AbstractDisposable implements IResourceEditorInput {
	public readonly resource = SettingsEditorResource;
	public readonly contentType = SettingsEditorContentType;
	public readonly readOnly = true;
	private optionsHandler: ((options: IOpenSettingsOptions) => void) | undefined;

	public get label(): string { return localize({ bundle: 'ash.settings', key: 'chrome.modalTitle' }, 'Ash Settings'); }
	public getIcon(): typeof Lxicon.settings { return Lxicon.settings; }

	public attachOptionsHandler(handler: (options: IOpenSettingsOptions) => void): IDisposable {
		this.assertNotDisposed();
		if (this.optionsHandler) throw new Error('Settings input already has an active pane');
		this.optionsHandler = handler;
		return toDisposable(() => { if (this.optionsHandler === handler) this.optionsHandler = undefined; });
	}

	public applyOptions(options: IOpenSettingsOptions): void {
		this.assertNotDisposed();
		// A direct delegate preserves pane validation failures in the opening promise.
		this.optionsHandler?.(options);
	}

	protected override disposeCore(): void {
		this.optionsHandler = undefined;
	}
}

/** Creates the singleton input routed to the Workbench Settings editor. */
export function createSettingsEditorInput(target?: string, parameters: Readonly<Record<string, string>> = {}): IResourceEditorInput {
	const query = Object.entries(target ? { ...parameters, target } : parameters)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
	return {
		resource: SettingsEditorResource.with({ query }),
		contentType: SettingsEditorContentType,
		get label(): string { return localize({ bundle: 'ash.settings', key: 'chrome.modalTitle' }, 'Ash Settings'); },
		getIcon: () => Lxicon.settings,
		readOnly: true,
	};
}

export function isSettingsEditorInput(input: IResourceEditorInput): boolean {
	return input.contentType === SettingsEditorContentType || input.resource.toString() === SettingsEditorResource.toString();
}

/** Creates the editable JSONC projection of the current profile's user settings. */
export function createUserSettingsEditorInput(): IResourceEditorInput {
	return Object.freeze({
		resource: UserSettingsResource,
		languageId: 'jsonc',
		get label(): string { return localize({ bundle: 'ash.settings', key: 'json.editorLabel' }, 'User Settings (JSON)'); },
	});
}

// Working sets persist identity, while the restored input resolves its label in the new locale.
EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.userSettings',
	canSerialize: input => input.resource.toString() === UserSettingsResource.toString(),
	serialize: () => UserSettingsResource.toString(),
	deserialize: value => {
		if (value !== UserSettingsResource.toString()) throw new TypeError('Invalid user settings editor resource');
		return createUserSettingsEditorInput();
	},
});
