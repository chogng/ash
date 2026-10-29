import {
	IFileService,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import { dirname } from '../../../../base/common/resources.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { editJsonObjectProperty, parseJsonDocument } from '../../../../base/common/json.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { IEditorGroupsService } from '../../editor/common/editorGroupsService.js';
import { IEditorService, type EditorOpenTarget } from '../../editor/common/editorService.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import {
	validateSettingsEditorOptions,
	type IOpenSettingsOptions,
	type IOpenKeybindingsEditorOptions,
	type IKeybindingsEditorPane,
	type IPreferencesService,
} from '../common/preferences.js';
import { SettingsEditorInput, createUserSettingsEditorInput } from '../common/settingsEditorInput.js';
import {
	createKeybindingsJsonEditorInput,
	isKeybindingsEditorInput,
	KeybindingsEditorInput,
} from './keybindingsEditorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** Routes Preferences through the editor and its shared, revision-aware file models. */
export class PreferencesService extends Disposable implements IPreferencesService {
	private readonly lifetime = new AbortController();
	private readonly settingsEditorInput = this._register(new SettingsEditorInput());
	private keybindingsEditorInput: WeakRef<KeybindingsEditorInput> | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IFileService private readonly files: IFileService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
	) {
		super();
		this._register(toDisposable(() => this.lifetime.abort()));
	}

	public async openSettings(options: IOpenSettingsOptions = {}): Promise<void> {
		let validated = validateSettingsEditorOptions(options);
		const target =
			validated.target ??
			(validated.folderUri ? ConfigurationTarget.WORKSPACE_FOLDER : ConfigurationTarget.USER_LOCAL);
		if (
			target === ConfigurationTarget.WORKSPACE &&
			!this.workspace.getWorkspace().folders.length &&
			!this.workspace.getWorkspace().configuration
		) {
			throw new Error(
				localize(
					{ bundle: 'ash.settings', key: 'open.missingWorkspace' },
					'Open a workspace to edit workspace settings.',
				),
			);
		}
		if (target === ConfigurationTarget.WORKSPACE_FOLDER) {
			const folder = validated.folderUri && this.workspace.getWorkspaceFolder(validated.folderUri);
			if (!folder || folder.uri.toString() !== validated.folderUri!.toString()) {
				throw new Error(
					localize(
						{ bundle: 'ash.settings', key: 'open.missingFolder' },
						'Choose a workspace folder to open its settings.',
					),
				);
			}
			// Single-folder windows have one workspace settings layer.
			if (!this.workspace.getWorkspace().configuration)
				validated = { ...validated, target: ConfigurationTarget.WORKSPACE, folderUri: undefined };
		}
		validated = { ...validated, target: validated.target ?? target };
		if (
			validated.jsonEditor ??
			this.configurationService.getValue(WorkbenchConfiguration.settingsEditor) === 'json'
		) {
			await this.openSettingsJson(validated);
			return;
		}
		const opening =
			validated.revealSetting && validated.query === undefined
				? { ...validated, query: `@id:${validated.revealSetting.key}` }
				: validated;
		await this.editorService.openEditor(
			this.settingsEditorInput,
			{
				...opening,
				pinned: true,
				preserveFocus: validated.preserveFocus ?? validated.focusSearch === false,
				ignoreError: true,
			},
			this.getEditorTarget(validated, true),
		);
	}

	public async openUserSettings(options: IOpenSettingsOptions = {}): Promise<void> {
		await this.openSettings(options);
	}

	private getEditorTarget(options: IOpenSettingsOptions, graphical = false): EditorOpenTarget | undefined {
		if (options.openToSide) return 'sideGroup';
		if (options.groupId !== undefined) {
			const group = this.editorGroups.getGroup(options.groupId) ?? this.editorGroups.activeGroup;
			return { groupId: group.id };
		}
		return graphical ? 'modalGroup' : undefined;
	}

	private async openSettingsJson(options: IOpenSettingsOptions): Promise<void> {
		const workspace = this.workspace.getWorkspace();
		const folder = options.folderUri ? this.workspace.getWorkspaceFolder(options.folderUri) : workspace.folders[0];
		const resource =
			options.target === ConfigurationTarget.WORKSPACE
				? (workspace.configuration ?? URI.joinPath(folder!.uri, '.vscode', 'settings.json'))
				: options.target === ConfigurationTarget.WORKSPACE_FOLDER
					? URI.joinPath(folder!.uri, '.vscode', 'settings.json')
					: undefined;
		const nested = options.target === ConfigurationTarget.WORKSPACE && !!workspace.configuration;
		const input = resource
			? {
					resource,
					languageId: 'jsonc',
					label:
						options.target === ConfigurationTarget.WORKSPACE
							? localize(
									{ bundle: 'ash.settings', key: 'json.workspaceLabel' },
									'Workspace Settings (JSON)',
								)
							: localize({ bundle: 'ash.settings', key: 'json.folderLabel' }, 'Folder Settings (JSON)'),
				}
			: createUserSettingsEditorInput();
		if (!this.models.getModel(input.resource)) {
			try {
				await this.files.stat(input.resource);
			} catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound)
					throw error;
				await this.files.createDirectory(dirname(input.resource));
				try {
					await this.files.writeFile(
						{ resource: input.resource, content: '{}\n' },
						{ create: true, overwrite: false },
					);
				} catch (error) {
					// Another window may create the profile file while this editor is opening.
					if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileExists)
						throw error;
				}
			}
		}
		const candidate = options.query?.trim().replace(/^@id:/u, '');
		const keyFromQuery =
			candidate && Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration(candidate)
				? candidate
				: undefined;
		// Switching editors may reveal an existing value, but must not create an override.
		const revealSetting = options.revealSetting ?? (keyFromQuery ? { key: keyFromQuery, edit: false } : undefined);
		if (!revealSetting) {
			await this.editorService.openEditor(
				input,
				{ pinned: true, preserveFocus: options.preserveFocus },
				this.getEditorTarget(options),
			);
			return;
		}
		// Hold the same model the editor will acquire, including unsaved edits and its saved revision.
		using reference = await this.models.acquire(input, this.lifetime.signal);
		this.lifetime.signal.throwIfAborted();
		const model = reference.model;
		const { key, edit } = revealSetting;
		let source = model.getValue();
		let document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
		if (document.errors.length > 0 || document.root?.type !== 'object') {
			// A search hint must never block opening JSON to repair an invalid draft.
			if (!options.revealSetting) {
				await this.editorService.openEditor(
					input,
					{ pinned: true, preserveFocus: options.preserveFocus },
					this.getEditorTarget(options),
				);
				return;
			}
			throw new Error(
				localize(
					{ bundle: 'ash.settings', key: 'json.invalidDocument' },
					'Fix the JSON errors in settings.json before editing a setting.',
				),
			);
		}
		const settingsObject = () => {
			const root = document.root;
			if (root?.type !== 'object') return undefined;
			if (!nested) return root;
			const settings = root.properties.find(candidate => candidate.key === 'settings')?.valueNode;
			return settings?.type === 'object' ? settings : undefined;
		};
		if (nested && document.root.properties.some(property => property.key === 'settings') && !settingsObject()) {
			if (!options.revealSetting) {
				await this.editorService.openEditor(
					input,
					{ pinned: true, preserveFocus: options.preserveFocus },
					this.getEditorTarget(options),
				);
				return;
			}
			throw new Error(
				localize(
					{ bundle: 'ash.settings', key: 'json.invalidDocument' },
					'Fix the JSON errors in settings.json before editing a setting.',
				),
			);
		}
		let property = settingsObject()?.properties.find(candidate => candidate.key === key);
		if (!property && edit) {
			const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration(key);
			if (!configuration) {
				throw new Error(
					localize(
						{ bundle: 'ash.settings', key: 'json.unknownSetting' },
						'Setting {0} is not registered.',
						key,
					),
				);
			}
			const object = settingsObject();
			if (nested && object) {
				const settings = source.slice(object.offset, object.offset + object.length);
				source =
					source.slice(0, object.offset) +
					editJsonObjectProperty(settings, key, configuration.serialize(configuration.defaultValue)) +
					source.slice(object.offset + object.length);
			} else {
				source = editJsonObjectProperty(
					source,
					nested ? 'settings' : key,
					nested
						? { [key]: configuration.serialize(configuration.defaultValue) }
						: configuration.serialize(configuration.defaultValue),
				);
			}
			model.pushStackElement();
			model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: source }], null);
			model.pushStackElement();
			document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
			property = settingsObject()?.properties.find(candidate => candidate.key === key);
		}
		const node = edit || !options.revealSetting ? property?.valueNode : property?.keyNode;
		const selection = node
			? Range.fromPositions(model.positionAt(node.offset), model.positionAt(node.offset + node.length))
			: undefined;
		await this.editorService.openEditor(
			input,
			{ pinned: true, selection, preserveFocus: options.preserveFocus },
			this.getEditorTarget(options),
		);
	}

	public async openGlobalKeybindingSettings(
		textual: boolean,
		options?: IOpenKeybindingsEditorOptions,
	): Promise<void> {
		if (!textual) {
			const activeEditor = this.editorService.activeEditor;
			let input =
				activeEditor && isKeybindingsEditorInput(activeEditor)
					? KeybindingsEditorInput.getOrCreate(activeEditor, this.instantiationService)
					: this.keybindingsEditorInput?.deref();
			if (!input || input.isDisposed) input = this.instantiationService.createInstance(KeybindingsEditorInput);
			// Reuse the live input when returning to the modal or opening a shortcut already held by a group.
			this.keybindingsEditorInput = new WeakRef(input);
			using reference = input.acquire();
			await this.editorService.openEditor(input, { pinned: true }, 'modalGroup');
			if (options?.query !== undefined) {
				// The focused pane is the opened target even when split panes share the same input.
				this.editorService.focusActiveEditor();
				const pane = this.editorService.visibleEditorPanes.find(
					pane => pane.id === 'workbench.editor.keybindings' && pane.hasFocus(),
				) as IKeybindingsEditorPane | undefined;
				pane?.search(options.query);
			}
			return;
		}
		const resource = this.profiles.currentProfile.keybindingsResource;
		await this.files.createFile(resource, 'ignore');
		const current = await this.files.readFile(resource);
		if (current.content.trim().length === 0 && !this.models.getModel(resource)) {
			await this.files.writeFile({ resource, content: '[]\n', expectedRevision: current.revision });
		}
		await this.editorService.openEditor(createKeybindingsJsonEditorInput(resource), { pinned: true });
	}
}
