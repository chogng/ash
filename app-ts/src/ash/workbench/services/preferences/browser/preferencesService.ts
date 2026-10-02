import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { editJsonObjectProperty, parseJsonDocument } from '../../../../base/common/json.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import type { IOpenSettingsOptions, IPreferencesService } from '../common/preferences.js';
import { createSettingsEditorInput, createUserSettingsEditorInput } from '../common/settingsEditorInput.js';
import { createKeyboardShortcutsEditorInput } from './keybindingsEditorInput.js';

/** Routes Preferences through the editor and its shared, revision-aware file models. */
export class PreferencesService extends Disposable implements IPreferencesService {
	private readonly lifetime = new AbortController();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IFileTextModelService private readonly models: IFileTextModelService,
	) {
		super();
		this._register(toDisposable(() => this.lifetime.abort()));
	}

	public async openSettings(target?: string): Promise<void> {
		await this.editorService.openEditor(createSettingsEditorInput(target), { pinned: true }, 'modalGroup');
	}

	public async openUserSettings(options: IOpenSettingsOptions = {}): Promise<void> {
		if (options.target !== undefined && options.target !== ConfigurationTarget.USER && options.target !== ConfigurationTarget.USER_LOCAL) {
			throw new Error(localize({ bundle: 'ash.settings', key: 'json.unsupportedTarget' }, 'This configuration target does not support editing a settings file.'));
		}
		const input = createUserSettingsEditorInput();
		if (!options.revealSetting) {
			await this.editorService.openEditor(input, { pinned: true });
			return;
		}
		// Hold the same model the editor will acquire, including unsaved edits and its saved revision.
		using reference = await this.models.acquire(input, this.lifetime.signal);
		this.lifetime.signal.throwIfAborted();
		const model = reference.model;
		const { key, edit } = options.revealSetting;
		let source = model.getValue();
		let document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
		if (document.errors.length > 0 || document.root?.type !== 'object') {
			throw new Error(localize({ bundle: 'ash.settings', key: 'json.invalidDocument' }, 'Fix the JSON errors in settings.json before editing a setting.'));
		}
		let property = document.root.properties.find(candidate => candidate.key === key);
		if (!property && edit) {
			const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration(key);
			if (!configuration) {
				throw new Error(localize({ bundle: 'ash.settings', key: 'json.unknownSetting' }, 'Setting {0} is not registered.', key));
			}
			source = editJsonObjectProperty(source, key, configuration.serialize(configuration.defaultValue));
			model.pushStackElement();
			model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: source }], null);
			model.pushStackElement();
			document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
			property = document.root?.type === 'object' ? document.root.properties.find(candidate => candidate.key === key) : undefined;
		}
		const node = edit ? property?.valueNode : property?.keyNode;
		const selection = node ? Range.fromPositions(model.positionAt(node.offset), model.positionAt(node.offset + node.length)) : undefined;
		await this.editorService.openEditor(input, { pinned: true, selection });
	}

	public async openKeybindings(): Promise<void> {
		await this.editorService.openEditor(createKeyboardShortcutsEditorInput(), { pinned: true });
	}
}
