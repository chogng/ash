import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { editJsonObjectProperty, parseJsonDocument } from '../../../../base/common/json.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { equals } from '../../../../base/common/objects.js';
import { ConfigurationModel, ConfigurationModelParser, UserSettings } from '../../../../platform/configuration/common/configurationModels.js';
import { ConfigurationTarget, isConfigurationOverrides, isConfigurationUpdateOverrides, type IConfigurationChange, type IConfigurationChangeEvent, type IConfigurationData, type IConfigurationModel, type IConfigurationOverrides, type IConfigurationService, type IConfigurationUpdateOptions, type IConfigurationUpdateOverrides, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration, ConfigurationScope, keyFromOverrideIdentifiers, overrideIdentifiersFromKey } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ILogService, NullLoggerService } from '../../../../platform/log/common/log.js';
import { WorkbenchState, type IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { dirname } from '../../../../base/common/resources.js';
import { NullPolicyService, type IPolicyService } from '../../../../platform/policy/common/policy.js';
import { PolicyConfiguration } from '../../../../platform/configuration/common/configurations.js';
import { FolderConfiguration, WorkspaceConfiguration, migrateSettings } from './configuration.js';
import type { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';

const configurationModelLog = new NullLoggerService();

export interface WorkbenchConfigurationServiceOptions {
	readonly initialConfiguration?: IConfigurationModel;
	readonly registry?: IConfigurationRegistry;
	readonly onError?: (error: unknown) => void;
	readonly defaults?: ReadonlyMap<string, unknown>;
	readonly readOnlyKeys?: ReadonlySet<string>;
}

interface ConfigurationOverrideBlock {
	readonly key: string;
	readonly identifiers: readonly string[];
	readonly values: ReadonlyMap<string, unknown>;
}

export class WorkbenchConfigurationService extends Disposable implements IConfigurationService {
	readonly _serviceBrand = undefined;

	private readonly userSettings: UserSettings;
	private readonly settingsResource: URI;
	protected readonly registry: IConfigurationRegistry;
	private readonly onError: (error: unknown) => void;
	private readonly defaults: ReadonlyMap<string, unknown>;
	private readonly readOnlyKeys: ReadonlySet<string>;
	private readonly changeEmitter = this._register(new Emitter<IConfigurationChangeEvent>());
	private defaultConfiguration = ConfigurationModel.createEmptyModel(configurationModelLog);
	private userConfiguration = this.defaultConfiguration;
	private effectiveConfiguration = this.defaultConfiguration;
	private consolidated: { base: ConfigurationModel; workspace: ConfigurationModel; policy: ConfigurationModel; model: ConfigurationModel; } | undefined;
	private workspaceConfiguration = this.defaultConfiguration;
	private policyConfiguration = this.defaultConfiguration;
	private readonly folderConfigurations = new Map<string, { root: URI; resource: FolderConfiguration; model: ConfigurationModel; }>();
	private readonly workspaceResources = this._register(new DisposableStore());
	private workspaceResource: WorkspaceConfiguration | FolderConfiguration | undefined;
	private workspaceService: IWorkspaceContextService | undefined;
	private workspaceLoad: Promise<void> = Promise.resolve();
	private stopped = false;
	private workingCopies: IWorkingCopyService | undefined;
	private document = ConfigurationModel.createEmptyModel(configurationModelLog);

	readonly onDidChangeConfiguration = this.changeEmitter.event;

	constructor(
		options: WorkbenchConfigurationServiceOptions = {},
		@IFileService private readonly userFiles: IFileService,
		@ILogService log: ILogService,
		@IUserDataProfileService profile: IUserDataProfileService,
	) {
		super();
		this.settingsResource = profile.currentProfile.settingsResource;
		this.userSettings = this._register(new UserSettings(this.settingsResource, {}, extUriBiasedIgnorePathCase, userFiles, log));
		this.registry = options.registry ?? Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		this.defaults = options.defaults ?? new Map();
		this.readOnlyKeys = options.readOnlyKeys ?? new Set();
		this.onError = options.onError ?? (error => console.error('Failed to apply configuration', error));
		if (options.initialConfiguration) {
			const initial = options.initialConfiguration;
			this.document = new ConfigurationModel(initial.contents, initial.keys, initial.overrides, initial.raw, configurationModelLog);
		}
		this.rebuildValues();
		this._register(this.registry.onDidUpdateConfiguration(event => {
			const previous = this.state();
			this.rebuildValues();
			this.changeEmitter.fire(configurationChangeEvent({ keys: [...event.properties], overrides: [] }, previous, this.state(), ConfigurationTarget.DEFAULT));
		}));
		this._register(this.userSettings.onDidChange(() => {
			void this.reloadUserConfiguration().catch(error => { if (!this.stopped) this.onError(error); });
		}));
	}

	/** Attach the host's existing workspace and file owners before restoring editors. */
	async initialize(workspace: IWorkspaceContextService, files: IFileService, policies: IPolicyService = new NullPolicyService(), workingCopies?: IWorkingCopyService): Promise<void> {
		if (this.workspaceService) throw new Error('Configuration service is already initialized');
		this.workspaceService = workspace;
		this.workingCopies = workingCopies;
		const policy = this._register(new PolicyConfiguration(this.registry, policies, configurationModelLog, this.onError));
		this._register(policy.onDidChangeConfiguration(model => {
			const previous = this.state();
			this.policyConfiguration = model;
			this.fireLayerChange(previous, ConfigurationTarget.DEFAULT);
		}));
		const loadWorkspace = (): Promise<void> => {
			const previous = this.state();
			this.workspaceResources.clear();
			this.folderConfigurations.clear();
			this.workspaceResource = undefined;
			this.workspaceConfiguration = ConfigurationModel.createEmptyModel(configurationModelLog);
			const current = workspace.getWorkspace();
			if (current.configuration) {
				this.workspaceResource = this.workspaceResources.add(new WorkspaceConfiguration(current.configuration, files, this.onError));
			} else if (workspace.getWorkbenchState() === WorkbenchState.FOLDER && current.folders[0]) {
				this.workspaceResource = this.workspaceResources.add(new FolderConfiguration(URI.joinPath(current.folders[0].uri, '.vscode', 'settings.json'), files, this.onError));
			}
			if (this.workspaceResource) {
				this.workspaceResources.add(this.workspaceResource.onDidUpdateConfiguration(() => this.updateWorkspaceModels(ConfigurationTarget.WORKSPACE)));
			}
			if (current.configuration) {
				for (const folder of current.folders) {
					const resource = this.workspaceResources.add(new FolderConfiguration(URI.joinPath(folder.uri, '.vscode', 'settings.json'), files, this.onError));
					this.folderConfigurations.set(folder.uri.toString(), { root: folder.uri, resource, model: ConfigurationModel.createEmptyModel(configurationModelLog) });
					this.workspaceResources.add(resource.onDidUpdateConfiguration(() => this.updateWorkspaceModels(ConfigurationTarget.WORKSPACE_FOLDER)));
				}
			}
			this.fireLayerChange(previous, ConfigurationTarget.WORKSPACE);
			const resources = [this.workspaceResource, ...[...this.folderConfigurations.values()].map(folder => folder.resource)].filter(resource => resource !== undefined);
			return Promise.all(resources.map(resource => resource.loadConfiguration().catch(this.onError))).then(() => { });
		};
		this._register(workspace.onDidChangeWorkspace(() => { this.workspaceLoad = loadWorkspace(); }));
		this.workspaceLoad = loadWorkspace();
		await Promise.all([this.workspaceLoad, policy.initialize(), this.reloadUserConfiguration()]);
		await this.waitForWorkspace();
	}

	getConfigurationData(): IConfigurationData {
		return Object.freeze({
			defaults: this.defaultConfiguration.toJSON(),
			policy: this.policyConfiguration.toJSON(),
			application: emptyConfigurationModel(),
			userLocal: this.userConfiguration.toJSON(),
			userRemote: emptyConfigurationModel(),
			workspace: this.workspaceConfiguration.toJSON(),
			folders: [...this.folderConfigurations.values()].map(folder => [folder.root.toJSON(), folder.model.toJSON()] as [ReturnType<URI['toJSON']>, IConfigurationModel]),
		});
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(sectionOrOverrides?: unknown, overrides?: unknown): T {
		const section = typeof sectionOrOverrides === 'string' ? sectionOrOverrides : undefined;
		if (sectionOrOverrides === undefined && overrides !== undefined) throw new TypeError('Configuration overrides require a configuration section');
		const resolvedOverrides = section === undefined ? sectionOrOverrides : overrides;
		if (resolvedOverrides !== undefined && !isConfigurationOverrides(resolvedOverrides)) throw new TypeError('Configuration overrides are invalid');
		// Reads use the current configuration domain; the resource identifies the consumer, not a write target.
		if (section !== undefined) return this.resolveSection(section, resolvedOverrides) as T;
		const result: Record<string, unknown> = {};
		for (const key of this.registry.getConfigurations()) setConfigurationValue(result, key, this.resolveSection(key, resolvedOverrides));
		return result as T;
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	async updateValue(key: string, value: unknown, arg3?: unknown, arg4?: unknown, _options?: IConfigurationUpdateOptions): Promise<void> {
		const configuration = this.requireConfiguration(key);
		if (this.isReadOnly(key)) throw new Error(localize('configuration.readOnly', 'Setting {0} is read-only in this window.', key));
		const { identifiers, overrides, target } = parseUpdateArguments(arg3, arg4);
		if (this.workspaceService) await this.waitForWorkspace();
		else {
			assertNoResourceOverride(overrides, 'Workbench configuration');
			if (target === ConfigurationTarget.WORKSPACE || target === ConfigurationTarget.WORKSPACE_FOLDER) throw new Error(`Unable to write ${key} to target ${target}.`);
		}
		if (this.policyConfiguration.getValue(key) !== undefined) throw new Error(localize('configuration.policyReadOnly', 'Setting {0} is controlled by administrator policy.', key));
		if (target !== undefined && ![ConfigurationTarget.USER, ConfigurationTarget.USER_LOCAL, ConfigurationTarget.WORKSPACE, ConfigurationTarget.WORKSPACE_FOLDER].includes(target)) throw new Error(`Unable to write ${key} to target ${target}.`);
		if (identifiers.length && configuration.scope !== undefined && configuration.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) { throw new TypeError(localize('configuration.languageScopeError', 'Setting {0} does not support language overrides', key)); }
		const parsed = value === undefined ? undefined : configuration.parse(value);
		let serialized = parsed === undefined ? undefined : configuration.serialize(parsed);
		if (serialized === undefined && value !== undefined) throw new TypeError(`Configuration key '${key}' did not serialize to JSON`);
		await this.reloadUserConfiguration();
		const inspection = this.inspect(key, { resource: overrides?.resource, overrideIdentifier: identifiers[0] });
		const defined = [
			...(inspection.workspaceFolderValue === undefined ? [] : [ConfigurationTarget.WORKSPACE_FOLDER]),
			...(inspection.workspaceValue === undefined ? [] : [ConfigurationTarget.WORKSPACE]),
			...(inspection.userValue === undefined ? [] : [ConfigurationTarget.USER_LOCAL]),
		];
		const targets = target === undefined ? value === undefined ? defined : [defined[0] ?? ConfigurationTarget.USER_LOCAL] : [target];
		if (targets.length === 1 && (targets[0] === ConfigurationTarget.USER || targets[0] === ConfigurationTarget.USER_LOCAL) && equals(parsed, this.defaultValue(configuration))) serialized = undefined;
		// Resolve all resources and validate all scopes before any removal crosses multiple targets.
		const writes = targets.map(target => {
			this.validateTargetScope(configuration, target);
			const resource = target === ConfigurationTarget.WORKSPACE ? this.workspaceResource
				: target === ConfigurationTarget.WORKSPACE_FOLDER ? this.folderResource(overrides?.resource) : undefined;
			if ((target === ConfigurationTarget.WORKSPACE || target === ConfigurationTarget.WORKSPACE_FOLDER) && !resource) throw new Error(localize('configuration.missingTarget', 'No settings resource is available for target {0}.', target));
			return { resource, settingsResource: resource?.resource ?? this.settingsResource };
		});
		if (!_options?.handleDirtyFile) {
			for (const { settingsResource } of writes) {
				if (this.workingCopies?.get(settingsResource).some(copy => copy.isDirty)) {
					throw new Error(localize('configuration.dirtyResource', 'Save or revert unsaved changes in {0} before updating settings.', settingsResource.toString()));
				}
			}
		}
		for (const { resource, settingsResource } of writes) {
			for (const copy of this.workingCopies?.get(settingsResource) ?? []) {
				if (!copy.isDirty) continue;
				if (_options?.handleDirtyFile === 'save') await copy.save(new AbortController().signal);
				else if (_options?.handleDirtyFile === 'revert') await copy.revert(new AbortController().signal);
				else throw new Error(localize('configuration.dirtyResource', 'Save or revert unsaved changes in {0} before updating settings.', settingsResource.toString()));
			}
			const transform = (source: string): string => editSetting(source, key, serialized, identifiers);
			if (resource) {
				await resource.write(transform);
			}
			else await this.writeUserSetting(transform);
		}
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		this.requireConfiguration(key);
		const defaultValue = this.defaultConfiguration.getValue<Readonly<T>>(key);
		const base = this.userConfiguration.getValue<Readonly<T>>(key);
		const hasBase = base !== undefined;
		const override = overrides?.overrideIdentifier
			? this.userConfiguration.getOverrideValue<Readonly<T>>(key, overrides.overrideIdentifier) : undefined;
		const hasOverride = override !== undefined;
		const userLocalValue = overrides?.overrideIdentifier
			? this.userConfiguration.override(overrides.overrideIdentifier).getValue<Readonly<T>>(key) : base;
		const overrideEntries = this.userConfiguration.overrides
			.filter(block => block.keys.includes(key))
			.map(block => Object.freeze({
				identifiers: [...block.identifiers],
				value: new ConfigurationModel(block.contents, block.keys, [], undefined, configurationModelLog).getValue<Readonly<T>>(key)!,
			}));
		const overrideIdentifiers = [...new Set(overrideEntries.flatMap(entry => entry.identifiers))];
		const userLocal = hasBase || hasOverride || overrideEntries.length > 0
			? Object.freeze({
				...(hasBase ? { value: base } : {}),
				...(hasOverride ? { override } : {}),
				...(overrideEntries.length > 0 ? { overrides: overrideEntries } : {}),
			})
			: undefined;
		return Object.freeze({
			defaultValue,
			...(userLocalValue === undefined ? {} : { userValue: userLocalValue, userLocalValue }),
			value: this.resolveSection(key, overrides) as Readonly<T>,
			default: Object.freeze({ value: defaultValue }),
			...(userLocal === undefined ? {} : { user: userLocal, userLocal }),
			...inspectModel<T>('workspace', this.workspaceConfiguration, key, overrides),
			...inspectModel<T>('workspaceFolder', this.folderModel(overrides?.resource), key, overrides),
			...(this.policyConfiguration.getValue(key) === undefined ? {} : { policyValue: this.policyConfiguration.getValue<Readonly<T>>(key), policy: { value: this.policyConfiguration.getValue<Readonly<T>>(key) } }),
			...configurationOverrideIdentifiers(key, [this.userConfiguration, this.workspaceConfiguration, this.folderModel(overrides?.resource)], overrideIdentifiers),
		});
	}

	async reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		await this.waitForWorkspace();
		if (!this.workspaceService && (target === ConfigurationTarget.WORKSPACE || target === ConfigurationTarget.WORKSPACE_FOLDER || typeof target === 'object')) throw new Error(`Unable to reload workbench configuration target ${typeof target === 'number' ? target : 'workspace folder'}.`);
		if (target === undefined || target === ConfigurationTarget.USER || target === ConfigurationTarget.USER_LOCAL) await this.reloadUserConfiguration();
		if (target === undefined || target === ConfigurationTarget.DEFAULT) {
			const previous = this.state();
			this.rebuildValues();
			this.fireLayerChange(previous, ConfigurationTarget.DEFAULT);
		}
		if (target === undefined || target === ConfigurationTarget.WORKSPACE) await this.workspaceResource?.loadConfiguration();
		if (target === undefined || target === ConfigurationTarget.WORKSPACE_FOLDER) await Promise.all([...this.folderConfigurations.values()].map(folder => folder.resource.loadConfiguration()));
		if (typeof target === 'object') await this.folderResource(target.uri)?.loadConfiguration();
		else if (target !== undefined && ![ConfigurationTarget.DEFAULT, ConfigurationTarget.USER, ConfigurationTarget.USER_LOCAL, ConfigurationTarget.WORKSPACE, ConfigurationTarget.WORKSPACE_FOLDER].includes(target)) throw new Error(`Unable to reload workbench configuration target ${target}.`);
	}

	private async reloadUserConfiguration(): Promise<void> {
		if (this.stopped) return;
		try {
			const file = await this.userFiles.readFile(this.settingsResource);
			const output = await migrateSettings(file.content, this.onError);
			if (this.stopped) return;
			if (output !== file.content) {
				if (this.workingCopies?.get(this.settingsResource).some(copy => copy.isDirty)) throw new Error(localize('configuration.dirtyResource', 'Save or revert unsaved changes in {0} before updating settings.', this.settingsResource.toString()));
				this.parseResourceSource(output);
				await this.userFiles.writeFile({ resource: this.settingsResource, content: output, expectedRevision: file.revision }, { create: true, overwrite: true });
			}
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
		}
		if (this.stopped) return;
		this.applyConfiguration(await this.userSettings.loadConfiguration());
	}

	private async waitForWorkspace(): Promise<void> {
		// Selection can replace the load while callers await it; readiness follows the current owner.
		while (!this.stopped) {
			const loading = this.workspaceLoad;
			await loading;
			if (loading === this.workspaceLoad) return;
		}
	}

	keys(): { default: string[]; policy: string[]; user: string[]; workspace: string[]; workspaceFolder: string[]; memory?: string[]; } {
		return {
			default: [...this.registry.getConfigurations()],
			policy: this.policyConfiguration.keys,
			user: this.userConfiguration.keys,
			workspace: this.workspaceConfiguration.keys,
			workspaceFolder: [...new Set([...this.folderConfigurations.values()].flatMap(folder => folder.model.keys))],
			memory: [],
		};
	}

	private resolveSection(section: string, overrides?: IConfigurationOverrides): unknown {
		if (overrides === undefined) {
			const base = this.effectiveConfiguration, workspace = this.workspaceConfiguration, policy = this.policyConfiguration;
			// Layers are immutable snapshots. Reuse their combined read model until
			// an owner replaces a layer, including reads made inside change events.
			if (!this.consolidated || this.consolidated.base !== base || this.consolidated.workspace !== workspace || this.consolidated.policy !== policy) {
				this.consolidated = { base, workspace, policy, model: base.merge(workspace, policy) };
			}
			return this.consolidated.model.getValue(section);
		}
		return resolveConfiguration(this.state(), section, overrides);
	}

	private async writeUserSetting(transform: (source: string) => string): Promise<void> {
		let source = '{}\n';
		let revision: string | undefined;
		try {
			const file = await this.userFiles.readFile(this.settingsResource);
			source = file.content;
			revision = file.revision;
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
		}
		const output = transform(source);
		this.parseResourceSource(output);
		if (source !== output) {
			await this.userFiles.createDirectory(dirname(this.settingsResource));
			await this.userFiles.writeFile({ resource: this.settingsResource, content: output, expectedRevision: revision }, { create: true, overwrite: revision !== undefined });
		}
		await this.reloadUserConfiguration();
	}

	private applyConfiguration(document: ConfigurationModel): void {
		if (this.stopped || equals(this.document.toJSON(), document.toJSON())) return;
		for (const [key, value] of Object.entries(configurationValues(document))) {
			if (!this.isReadOnly(key)) this.validateRegisteredValue(key, value);
		}
		for (const block of configurationOverrideValues(document)) {
			for (const [key, value] of Object.entries(block.values)) {
				if (!this.isReadOnly(key)) this.validateRegisteredValue(key, value);
			}
		}
		const previous = this.state();
		const documentChange = changedConfiguration(this.document, document);
		const change: IConfigurationChange = {
			keys: documentChange.keys.filter(key => !this.isReadOnly(key)),
			overrides: documentChange.overrides.map(([identifier, keys]): [string, string[]] => [identifier, keys.filter(key => !this.isReadOnly(key))]).filter(([, keys]) => keys.length > 0),
		};
		this.document = document;
		this.rebuildValues();
		if (change.keys.length || change.overrides.length) this.changeEmitter.fire(configurationChangeEvent(change, previous, this.state()));
	}

	private rebuildValues(): void {
		const defaults = new Map<string, unknown>();
		const configuredValues = new Map<string, unknown>();
		const overrideBlocks: ConfigurationOverrideBlock[] = [];
		const configured = configurationValues(this.document);
		for (const configuration of this.registry.getRegisteredConfigurations()) {
			defaults.set(configuration.key, this.defaultValue(configuration));
			const candidate = configured[configuration.key];
			if (candidate === undefined || this.isReadOnly(configuration.key)) {
				continue;
			}
			const value = this.parseConfigurationValue(configuration, candidate);
			configuredValues.set(configuration.key, value);
		}
		for (const entry of configurationOverrideValues(this.document)) {
			const blockValues = new Map<string, unknown>();
			for (const [key, candidate] of Object.entries(entry.values)) {
				const configuration = this.registry.getConfiguration(key);
				if (configuration && !this.isReadOnly(key)) {
					if (configuration.scope !== undefined && configuration.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) {
						this.onError(new TypeError(localize('configuration.languageScopeError', 'Setting {0} does not support language overrides', key)));
						continue;
					}
					blockValues.set(key, this.parseConfigurationValue(configuration, candidate));
				}
			}
			if (blockValues.size === 0) continue;
			overrideBlocks.push({ key: entry.key, identifiers: [...entry.identifiers], values: blockValues });
		}
		this.defaultConfiguration = configurationModel(defaults);
		this.userConfiguration = configurationModel(configuredValues, overrideBlocks);
		this.effectiveConfiguration = this.defaultConfiguration.merge(this.userConfiguration);
		this.workspaceConfiguration = this.modelFor(this.workspaceResource?.getConfiguration(), ConfigurationTarget.WORKSPACE);
		for (const folder of this.folderConfigurations.values()) folder.model = this.modelFor(folder.resource.getConfiguration(), ConfigurationTarget.WORKSPACE_FOLDER);
	}

	private modelFor(document: ConfigurationModel | undefined, target: ConfigurationTarget): ConfigurationModel {
		if (!document) return ConfigurationModel.createEmptyModel(configurationModelLog);
		const values = new Map<string, unknown>();
		const blocks: ConfigurationOverrideBlock[] = [];
		const parse = (key: string, candidate: unknown, language: boolean): unknown => {
			const setting = this.registry.getConfiguration(key);
			if (!setting || this.isReadOnly(key) || !supportsTarget(setting, target)) return undefined;
			if (language && setting.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) return undefined;
			try { return setting.parse(candidate); }
			catch (error) { this.onError(error); return undefined; }
		};
		for (const [key, candidate] of Object.entries(configurationValues(document))) {
			const value = parse(key, candidate, false);
			if (value !== undefined) values.set(key, value);
		}
		for (const block of configurationOverrideValues(document)) {
			const values = new Map<string, unknown>();
			for (const [key, candidate] of Object.entries(block.values)) {
				const value = parse(key, candidate, true);
				if (value !== undefined) values.set(key, value);
			}
			if (values.size) blocks.push({ key: block.key, identifiers: block.identifiers, values });
		}
		return configurationModel(values, blocks);
	}

	private state(): ConfigurationState {
		return {
			base: this.effectiveConfiguration, workspace: this.workspaceConfiguration, policy: this.policyConfiguration,
			folders: [...this.folderConfigurations.values()].map(folder => ({ root: folder.root, model: folder.model })),
		};
	}

	private updateWorkspaceModels(target: ConfigurationTarget): void {
		const previous = this.state();
		this.workspaceConfiguration = this.modelFor(this.workspaceResource?.getConfiguration(), ConfigurationTarget.WORKSPACE);
		for (const folder of this.folderConfigurations.values()) folder.model = this.modelFor(folder.resource.getConfiguration(), ConfigurationTarget.WORKSPACE_FOLDER);
		this.fireLayerChange(previous, target);
	}

	private fireLayerChange(previous: ConfigurationState, target: ConfigurationTarget): void {
		if (this.stopped) return;
		const current = this.state();
		const models = [previous.base, previous.workspace, previous.policy, ...previous.folders.map(folder => folder.model), current.base, current.workspace, current.policy, ...current.folders.map(folder => folder.model)];
		const resources = [undefined, ...previous.folders.map(folder => folder.root), ...current.folders.map(folder => folder.root)];
		const identifiers = [...new Set(models.flatMap(model => model.overrides.flatMap(block => block.identifiers)))];
		const changed = (key: string, identifier?: string): boolean => resources.some(resource => !equals(resolveConfiguration(previous, key, { resource, overrideIdentifier: identifier }), resolveConfiguration(current, key, { resource, overrideIdentifier: identifier })));
		const keys = [...new Set(models.flatMap(model => model.keys))].filter(key => changed(key) || identifiers.some(identifier => changed(key, identifier)));
		const overrides: [string, string[]][] = identifiers.map(identifier => [identifier, keys.filter(key => changed(key, identifier))]);
		if (keys.length) this.changeEmitter.fire(configurationChangeEvent({ keys, overrides: overrides.filter(([, keys]) => keys.length) }, previous, current, target));
	}

	private folderResource(resource: URI | null | undefined): FolderConfiguration | undefined {
		if (!resource) return undefined;
		const root = this.workspaceService?.getWorkspaceFolder(resource)?.uri;
		return root ? this.folderConfigurations.get(root.toString())?.resource
			?? (this.workspaceService?.getWorkbenchState() === WorkbenchState.FOLDER ? this.workspaceResource as FolderConfiguration : undefined) : undefined;
	}

	private folderModel(resource: URI | null | undefined): ConfigurationModel {
		return matchingFolder(this.state(), resource)?.model ?? ConfigurationModel.createEmptyModel(configurationModelLog);
	}

	private validateTargetScope(setting: IRegisteredConfiguration, target: ConfigurationTarget): void {
		if (!supportsTarget(setting, target)) throw new Error(localize('configuration.invalidScope', 'Setting {0} cannot be written at target {1}.', setting.key, target));
	}

	override dispose(): void {
		this.stopped = true;
		super.dispose();
	}

	private parseConfigurationValue(configuration: IRegisteredConfiguration, value: unknown): unknown {
		try {
			return configuration.parse(value);
		} catch (error) {
			this.onError(new Error(`Invalid configuration value for '${configuration.key}'`, { cause: error }));
			return this.defaultValue(configuration);
		}
	}

	protected defaultValue(configuration: IRegisteredConfiguration): unknown {
		return this.defaults.has(configuration.key) ? this.defaults.get(configuration.key) : configuration.defaultValue;
	}

	protected isReadOnly(key: string): boolean {
		return this.readOnlyKeys.has(key);
	}

	private requireConfiguration(key: string): IRegisteredConfiguration {
		const configuration = this.registry.getConfiguration(key);
		if (!configuration) throw new Error(`Unknown configuration key: ${key}`);
		return configuration;
	}

	private parseResourceSource(source: string): ConfigurationModel {
		const document = parseSettings(source);
		for (const [key, value] of Object.entries(configurationValues(document))) this.validateRegisteredValue(key, value);
		for (const entry of configurationOverrideValues(document)) for (const [key, value] of Object.entries(entry.values)) {
			const configuration = this.registry.getConfiguration(key);
			if (configuration?.scope !== undefined && configuration.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) throw new TypeError(localize('configuration.languageScopeError', 'Setting {0} does not support language overrides', key));
			this.validateRegisteredValue(key, value);
		}
		return document;
	}

	private validateRegisteredValue(key: string, value: unknown): void {
		const configuration = this.registry.getConfiguration(key);
		if (!configuration) return;
		try {
			configuration.serialize(configuration.parse(value));
		} catch (error) {
			throw new TypeError(`Invalid configuration value for '${key}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}

}

function configurationChangeEvent(
	change: IConfigurationChange,
	previous: ConfigurationState,
	current: ConfigurationState,
	source: ConfigurationTarget = ConfigurationTarget.USER_LOCAL,
): IConfigurationChangeEvent {
	const affectedKeys = new Set([...change.keys, ...change.overrides.flatMap(([, keys]) => keys)]);
	return Object.freeze({
		source,
		affectedKeys,
		change,
		affectsConfiguration(configuration: string, overrides?: IConfigurationOverrides): boolean {
			if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
			const affected = [...affectedKeys].some(key =>
				key === configuration || key.startsWith(`${configuration}.`) || configuration.startsWith(`${key}.`));
			if (!affected) return false;
			if (!overrides) return true;
			const before = resolveConfiguration(previous, configuration, overrides);
			const after = resolveConfiguration(current, configuration, overrides);
			return !equals(before, after);
		},
	});
}

interface ConfigurationState {
	readonly base: ConfigurationModel;
	readonly workspace: ConfigurationModel;
	readonly policy: ConfigurationModel;
	readonly folders: readonly { root: URI; model: ConfigurationModel; }[];
}

function matchingFolder(state: ConfigurationState, resource: URI | null | undefined) {
	return resource ? state.folders.filter(folder => extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.root)).sort((a, b) => b.root.path.length - a.root.path.length)[0] : undefined;
}

function resolveConfiguration(state: ConfigurationState, section: string, overrides?: IConfigurationOverrides): unknown {
	let model = state.base.merge(state.workspace);
	const folder = matchingFolder(state, overrides?.resource);
	if (folder) model = model.merge(folder.model);
	if (overrides?.overrideIdentifier) model = model.override(overrides.overrideIdentifier);
	return model.merge(state.policy).getValue(section);
}

function supportsTarget(setting: IRegisteredConfiguration, target: ConfigurationTarget): boolean {
	if (target !== ConfigurationTarget.WORKSPACE && target !== ConfigurationTarget.WORKSPACE_FOLDER) return true;
	const scope = setting.scope ?? ConfigurationScope.WINDOW;
	return scope === ConfigurationScope.RESOURCE || scope === ConfigurationScope.LANGUAGE_OVERRIDABLE || scope === ConfigurationScope.MACHINE_OVERRIDABLE
		|| target === ConfigurationTarget.WORKSPACE && scope === ConfigurationScope.WINDOW;
}

function inspectModel<T>(name: 'workspace' | 'workspaceFolder', model: ConfigurationModel, key: string, overrides?: IConfigurationOverrides): Record<string, unknown> {
	const value = model.getValue<Readonly<T>>(key);
	const override = overrides?.overrideIdentifier ? model.getOverrideValue<Readonly<T>>(key, overrides.overrideIdentifier) : undefined;
	const effective = overrides?.overrideIdentifier ? model.override(overrides.overrideIdentifier).getValue<Readonly<T>>(key) : value;
	const blocks = model.overrides.filter(block => block.keys.includes(key)).map(block => ({ identifiers: block.identifiers, value: new ConfigurationModel(block.contents, block.keys, [], undefined, configurationModelLog).getValue(key) }));
	return effective === undefined && blocks.length === 0 ? {} : {
		...(effective === undefined ? {} : { [`${name}Value`]: effective }),
		[name]: { ...(value === undefined ? {} : { value }), ...(override === undefined ? {} : { override }), ...(blocks.length ? { overrides: blocks } : {}) },
	};
}

function configurationOverrideIdentifiers(key: string, models: ConfigurationModel[], initial: string[]): { overrideIdentifiers?: string[]; } {
	const identifiers = [...new Set([...initial, ...models.flatMap(model => model.overrides.filter(block => block.keys.includes(key)).flatMap(block => block.identifiers))])];
	return identifiers.length ? { overrideIdentifiers: identifiers } : {};
}

function editSetting(source: string, key: string, value: unknown, identifiers: string[]): string {
	if (!identifiers.length) return editJsonObjectProperty(source, key, value);
	const entries = configurationOverrideValues(parseSettings(source));
	const block = entries.find(entry => equalIdentifierSets(entry.identifiers, identifiers));
	const overrideKey = block?.key ?? keyFromOverrideIdentifiers(identifiers);
	const next = { ...block?.values } as Record<string, unknown>;
	if (value === undefined) delete next[key];
	else next[key] = value;
	if (!Object.keys(next).length) return editJsonObjectProperty(source, overrideKey, undefined);
	const parsed = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	const node = parsed.root?.type === 'object' ? parsed.root.properties.find(property => property.key === overrideKey)?.valueNode : undefined;
	if (!node) return editJsonObjectProperty(source, overrideKey, next);
	const updated = editJsonObjectProperty(source.slice(node.offset, node.offset + node.length), key, value);
	return source.slice(0, node.offset) + updated + source.slice(node.offset + node.length);
}

function changedConfiguration(previous: ConfigurationModel, next: ConfigurationModel): IConfigurationChange {
	const keys = changedKeys(configurationValues(previous), configurationValues(next));
	const previousOverrides = overrideMap(previous);
	const nextOverrides = overrideMap(next);
	const identifiers = new Set([...previousOverrides.keys(), ...nextOverrides.keys()]);
	const overrides: [string, string[]][] = [];
	for (const identifier of identifiers) {
		const changed = changedKeys(previousOverrides.get(identifier) ?? {}, nextOverrides.get(identifier) ?? {});
		if (changed.length > 0) overrides.push([identifier, changed]);
	}
	return Object.freeze({ keys, overrides });
}

function overrideMap(document: ConfigurationModel): Map<string, Readonly<Record<string, unknown>>> {
	const blocks = configurationOverrideValues(document);
	const model = configurationModel(new Map(), blocks.map(block => ({
		key: block.key, identifiers: block.identifiers, values: new Map(Object.entries(block.values)),
	})));
	const result = new Map<string, Readonly<Record<string, unknown>>>();
	for (const identifier of new Set(blocks.flatMap(block => [...block.identifiers]))) {
		const keys = new Set(blocks.filter(block => block.identifiers.includes(identifier)).flatMap(block => Object.keys(block.values)));
		result.set(identifier, Object.fromEntries([...keys].map(key => [key, model.getOverrideValue(key, identifier)])));
	}
	return result;
}

function changedKeys(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): string[] {
	const result: string[] = [];
	for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (!equals(previous[key], next[key])) result.push(key);
	return result.sort();
}

function configurationModel(values: ReadonlyMap<string, unknown>, overrideBlocks: readonly ConfigurationOverrideBlock[] = []): ConfigurationModel {
	const raw = Object.fromEntries(values);
	for (const block of overrideBlocks) raw[block.key] = Object.fromEntries(block.values);
	const parser = new ConfigurationModelParser('settings', configurationModelLog);
	parser.parseRaw(raw);
	return parser.configurationModel;
}

function emptyConfigurationModel(): IConfigurationModel {
	return Object.freeze({ contents: Object.freeze({}), keys: [], overrides: [] });
}

function setConfigurationValue(target: Record<string, unknown>, key: string, value: unknown): void {
	const segments = key.split('.');
	let node = target;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index]!;
		const existing = node[segment];
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1)!] = value;
}

interface ParsedUpdateArguments {
	readonly identifiers: string[];
	readonly overrides: IConfigurationUpdateOverrides | undefined;
	readonly target: ConfigurationTarget | undefined;
}

function parseUpdateArguments(arg3: unknown, arg4: unknown): ParsedUpdateArguments {
	let overrides: IConfigurationUpdateOverrides | undefined;
	if (arg3 !== undefined && typeof arg3 !== 'number') {
		if (Array.isArray(arg3)) throw new TypeError('Configuration update overrides are invalid');
		if (isConfigurationUpdateOverrides(arg3)) {
			overrides = { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifiers };
		} else if (isConfigurationOverrides(arg3)) {
			overrides = { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifier ? [arg3.overrideIdentifier] : undefined };
		} else {
			throw new TypeError('Configuration update overrides are invalid');
		}
	}
	if (overrides === undefined && arg4 !== undefined) throw new TypeError('Configuration target cannot be passed without configuration overrides');
	const target = (overrides === undefined ? arg3 : arg4) as unknown;
	if (target !== undefined && (typeof target !== 'number' || !isConfigurationTarget(target))) throw new TypeError(`Configuration target is invalid: ${String(target)}`);
	const identifiers = [...new Set(overrides?.overrideIdentifiers ?? [])].sort();
	return { identifiers, overrides, target };
}

function isConfigurationTarget(value: number): value is ConfigurationTarget {
	return Number.isInteger(value) && value >= ConfigurationTarget.APPLICATION && value <= ConfigurationTarget.MEMORY;
}

function assertNoResourceOverride(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides | undefined, owner: string): void {
	if (overrides?.resource != null) throw new Error(`${owner} does not support resource overrides.`);
}

function equalIdentifierSets(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((identifier, index) => identifier === sortedRight[index]);
}

function parseSettings(source: string): ConfigurationModel {
	const parser = new ConfigurationModelParser('settings', configurationModelLog);
	parser.parse(source);
	if (parser.errors.length) throw new TypeError(`Settings JSONC is invalid: ${parser.errors[0].message}`);
	return parser.configurationModel;
}

function configurationValues(model: ConfigurationModel): Readonly<Record<string, unknown>> {
	return Object.fromEntries(model.keys.filter(key => !key.startsWith('[')).map(key => [key, model.getValue(key)]));
}

function configurationOverrideValues(model: ConfigurationModel) {
	return model.keys.filter(key => key.startsWith('[')).map(key => ({
		key, identifiers: overrideIdentifiersFromKey(key), values: model.contents[key] as Record<string, unknown>,
	}));
}
