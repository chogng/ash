import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { editJsonObjectProperty } from '../../../base/common/json.js';
import { equals } from '../../../base/common/objects.js';
import { extUriBiasedIgnorePathCase, dirname } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IPolicyService } from '../../policy/common/policy.js';
import { PolicyConfiguration } from './configurations.js';
import { Registry } from '../../registry/common/platform.js';
import {
	ConfigurationTarget, isConfigurationOverrides, isConfigurationUpdateOverrides,
	type IConfigurationService, type IConfigurationOverrides, type IConfigurationValue,
	type IConfigurationChangeEvent, type IConfigurationData,
	type IConfigurationUpdateOverrides, type IConfigurationUpdateOptions,
} from './configuration.js';
import { ConfigurationModel, ConfigurationModelParser, UserSettings } from './configurationModels.js';
import { Extensions, ConfigurationScope, keyFromOverrideIdentifiers, type IConfigurationRegistry } from './configurationRegistry.js';
import { localize } from '../../../nls.js';

/** Single-resource configuration for hosts without workspace configuration. File providers own persistence. */
export class ConfigurationService extends Disposable implements IConfigurationService {
	readonly _serviceBrand = undefined;
	private readonly changes = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration = this.changes.event;
	private readonly userSettings: UserSettings;
	private user: ConfigurationModel;
	private defaults: ConfigurationModel;
	private effective: ConfigurationModel;
	private appliedPolicy: ConfigurationModel;
	private readonly policy: PolicyConfiguration;
	private readonly registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

	constructor(
		private readonly resource: URI,
		@IFileService private readonly files: IFileService,
		@IPolicyService policies: IPolicyService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.user = ConfigurationModel.createEmptyModel(log);
		this.defaults = this.readDefaults();
		this.effective = this.defaults;
		this.appliedPolicy = ConfigurationModel.createEmptyModel(log);
		this.policy = this._register(new PolicyConfiguration(this.registry, policies, log));
		this._register(this.policy.onDidChangeConfiguration(() => this.apply(this.user, ConfigurationTarget.DEFAULT)));
		this.userSettings = this._register(new UserSettings(resource, {}, extUriBiasedIgnorePathCase, files, log));
		this._register(this.userSettings.onDidChange(() => this.apply(this.userSettings.reparse())));
		this._register(this.registry.onDidUpdateConfiguration(() => {
			this.defaults = this.readDefaults();
			this.apply(this.user, ConfigurationTarget.DEFAULT);
		}));
	}

	async initialize(): Promise<void> {
		await Promise.all([this.reloadConfiguration(), this.policy.initialize()]);
	}

	private readDefaults(): ConfigurationModel {
		const parser = new ConfigurationModelParser('defaults', this.log);
		const defaults = Object.fromEntries(this.registry.getRegisteredConfigurations().map(setting => [setting.key, setting.defaultValue]));
		for (const [key, override] of this.registry.getConfigurationDefaultsOverrides()) defaults[key] = override.value;
		parser.parseRaw(defaults);
		return parser.configurationModel;
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(sectionOrOverrides?: string | IConfigurationOverrides, overrides?: IConfigurationOverrides): T {
		const section = typeof sectionOrOverrides === 'string' ? sectionOrOverrides : undefined;
		const requested = typeof sectionOrOverrides === 'object' ? sectionOrOverrides : overrides;
		if (requested !== undefined && !isConfigurationOverrides(requested)) throw new TypeError('Configuration overrides are invalid');
		return this.resolve(this.defaults.merge(this.user), this.policy.configurationModel, requested?.overrideIdentifier).getValue<T>(section) as T;
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		const identifier = overrides?.overrideIdentifier;
		const userValue = (identifier ? this.user.override(identifier) : this.user).getValue<Readonly<T>>(key);
		const defaultValue = (identifier ? this.defaults.override(identifier) : this.defaults).getValue<Readonly<T>>(key);
		const user = {
			value: this.user.getValue<Readonly<T>>(key),
			override: identifier ? this.user.getOverrideValue<Readonly<T>>(key, identifier) : undefined,
		};
		const policyValue = this.policy.configurationModel.getValue<Readonly<T>>(key);
		return {
			defaultValue, userValue, userLocalValue: userValue, policyValue,
			value: this.getValue(key, overrides ?? {}),
			default: { value: defaultValue }, user, userLocal: user,
			...(policyValue === undefined ? {} : { policy: { value: policyValue } }),
		};
	}

	async updateValue(
		key: string,
		value: unknown,
		arg3?: ConfigurationTarget | IConfigurationOverrides | IConfigurationUpdateOverrides,
		target?: ConfigurationTarget,
		_options?: IConfigurationUpdateOptions,
	): Promise<void> {
		if (this.policy.configurationModel.getValue(key) !== undefined) {
			throw new Error(localize('configuration.policyReadOnly', 'Setting {0} is controlled by administrator policy.', key));
		}
		const overrides = typeof arg3 === 'object' ? arg3 : undefined;
		const destination = typeof arg3 === 'number' ? arg3 : target;
		if (overrides !== undefined && !isConfigurationOverrides(overrides) && !isConfigurationUpdateOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		if (overrides?.resource || destination !== undefined && destination !== ConfigurationTarget.USER && destination !== ConfigurationTarget.USER_LOCAL) {
			throw new Error('Single-resource configuration supports only user settings');
		}
		let content = '{}\n';
		let revision: string | undefined;
		try {
			const file = await this.files.readFile(this.resource);
			content = file.content;
			revision = file.revision;
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
		}
		const identifiers = overrides && 'overrideIdentifiers' in overrides ? overrides.overrideIdentifiers
			: overrides && 'overrideIdentifier' in overrides && overrides.overrideIdentifier ? [overrides.overrideIdentifier] : [];
		const overrideKey = identifiers?.length ? keyFromOverrideIdentifiers(identifiers) : undefined;
		const setting = this.registry.getConfiguration(key);
		if (overrideKey && setting?.scope !== undefined && setting.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) {
			throw new TypeError(localize('configuration.languageScopeError', 'Setting {0} does not support language overrides', key));
		}
		if (value !== undefined && setting) value = setting.serialize(setting.parse(value));
		if (overrideKey) {
			const parser = new ConfigurationModelParser('settings', this.log);
			parser.parse(content);
			if (parser.errors.length) throw new TypeError('Settings JSONC is invalid');
			const properties = { ...parser.configurationModel.contents[overrideKey] as Record<string, unknown> };
			if (value === undefined) {
				delete properties[key];
			} else {
				properties[key] = value;
			}
			content = editJsonObjectProperty(content, overrideKey, Object.keys(properties).length ? properties : undefined);
		} else {
			content = editJsonObjectProperty(content, key, value);
		}
		const parser = new ConfigurationModelParser('settings', this.log);
		parser.parse(content);
		if (parser.errors.length) throw new TypeError('Settings JSONC is invalid');
		await this.files.createDirectory(dirname(this.resource));
		await this.files.writeFile({ resource: this.resource, content, expectedRevision: revision }, { create: true, overwrite: revision !== undefined });
		await this.reloadConfiguration();
	}

	async reloadConfiguration(target?: ConfigurationTarget): Promise<void> {
		if (target !== undefined && target !== ConfigurationTarget.USER && target !== ConfigurationTarget.USER_LOCAL) throw new Error('Unsupported single-resource configuration target');
		this.apply(await this.userSettings.loadConfiguration());
	}

	keys() {
		return {
			default: this.defaults.keys,
			policy: this.policy.configurationModel.keys,
			user: this.user.keys,
			workspace: [], workspaceFolder: [],
		};
	}

	getConfigurationData(): IConfigurationData {
		const empty = () => ConfigurationModel.createEmptyModel(this.log).toJSON();
		return {
			defaults: this.defaults.toJSON(),
			userLocal: this.user.toJSON(),
			policy: this.policy.configurationModel.toJSON(),
			application: empty(), userRemote: empty(), workspace: empty(), folders: [],
		};
	}

	private resolve(base: ConfigurationModel, policy: ConfigurationModel, identifier?: string | null): ConfigurationModel {
		return (identifier ? base.override(identifier) : base).merge(policy);
	}

	private apply(user: ConfigurationModel, source = ConfigurationTarget.USER_LOCAL): void {
		const previous = this.effective;
		const previousPolicy = this.appliedPolicy;
		this.user = user;
		this.effective = this.defaults.merge(user);
		this.appliedPolicy = this.policy.configurationModel;
		const current = this.effective;
		const policy = this.appliedPolicy;
		// Acquiring or releasing policy changes editability even when the effective value is equal.
		const changed = (key: string, identifier?: string): boolean =>
			!equals(previousPolicy.getValue(key), policy.getValue(key)) || !equals(
				this.resolve(previous, previousPolicy, identifier).getValue(key),
				this.resolve(current, policy, identifier).getValue(key),
			);
		const keys = [...new Set([...previous.keys, ...current.keys, ...previousPolicy.keys, ...policy.keys])].filter(key => changed(key));
		const blocks = [...previous.overrides, ...current.overrides];
		const overrides: [string, string[]][] = [...new Set(blocks.flatMap(block => block.identifiers))].map(identifier => [
			identifier,
			[...new Set(blocks.filter(block => block.identifiers.includes(identifier)).flatMap(block => block.keys))].filter(key => changed(key, identifier)),
		]);
		const changedOverrides = overrides.filter(([, keys]) => keys.length > 0);
		if (!keys.length && !changedOverrides.length) return;
		const affectedKeys = new Set(keys);
		for (const [, keys] of changedOverrides) {
			for (const key of keys) affectedKeys.add(key);
		}
		this.changes.fire({
			source, affectedKeys, change: { keys, overrides: changedOverrides },
			affectsConfiguration: (section, overrides) => changed(section, overrides?.overrideIdentifier ?? undefined),
		});
	}
}
