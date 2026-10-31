import { validateJsonSchema, type JsonSchema } from '../../../base/common/jsonSchema.js';
import { parseJsonDocument } from '../../../base/common/json.js';
import { validateJsonValue } from '../../../base/common/jsonValue.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import type { JsonValue } from '../../../base/common/jsonValue.js';
import { Registry } from '../../registry/common/platform.js';
import type { PolicyDefinition } from '../../policy/common/policy.js';
import type { IManagedSettingPolicyDefinition } from '../../../base/common/policy.js';
import { merge } from './configuration.js';

type ConfigurationPolicy = Omit<PolicyDefinition, 'type'> & { readonly name: string; readonly minimumVersion?: string; };

export const Extensions = {
	Configuration: 'base.contributions.configuration',
};

export enum ConfigurationScope {
	APPLICATION = 1, MACHINE = 2, WINDOW = 3, RESOURCE = 4, LANGUAGE_OVERRIDABLE = 5, MACHINE_OVERRIDABLE = 6, APPLICATION_MACHINE = 7,
}

export interface IConfigurationPropertySchema extends JsonSchema {
	/** Searchable setting metadata; experimental and preview describe maturity, not enablement. */
	readonly tags?: readonly string[];
	readonly policy?: ConfigurationPolicy;
	readonly scope?: ConfigurationScope;
	readonly included?: boolean;
	readonly ashBinding?: { readonly readCommand: string; readonly writeCommand: string; readonly property: string; };
	readonly ashSetting?: IConfigurationSettingSchema;
	readonly agentsWindow?: { readonly default: JsonValue; readonly readOnly?: boolean; };
}

interface IConfigurationSettingSchemaBase {
	/** False omits automatic catalog listing; host layouts can still resolve the key explicitly. */
	readonly included?: boolean;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
}

export interface IBooleanConfigurationSettingSchema extends IConfigurationSettingSchemaBase {
	readonly valueType: 'boolean';
}

export interface INumberConfigurationSettingSchema extends IConfigurationSettingSchemaBase {
	readonly valueType: 'number';
	readonly minimum: number;
	readonly maximum: number;
}

export interface ISelectConfigurationSettingSchema<T extends string | boolean = string> extends IConfigurationSettingSchemaBase {
	readonly valueType: 'select';
	readonly options: readonly { readonly value: T; readonly label: string; }[];
}

export interface ITextConfigurationSettingSchema extends IConfigurationSettingSchemaBase {
	readonly valueType: 'text';
	readonly placeholder: string;
}

export interface IStringMapConfigurationSettingSchema extends IConfigurationSettingSchemaBase {
	readonly valueType: 'stringMap';
	readonly structuredValues?: boolean;
	readonly keyLabel: string;
	readonly valueLabel: string;
	readonly addLabel: string;
	readonly removeLabel: string;
	readonly incompleteMessage: string;
	readonly duplicateMessage: string;
}

export type IConfigurationSettingSchema = IBooleanConfigurationSettingSchema | INumberConfigurationSettingSchema | ISelectConfigurationSettingSchema<string | boolean> | ITextConfigurationSettingSchema | IStringMapConfigurationSettingSchema;

export type ConfigurationSettingSchemaFor<T> =
	[T] extends [boolean] ? IBooleanConfigurationSettingSchema
	: [T] extends [number] ? INumberConfigurationSettingSchema
	: [T] extends [string] ? ISelectConfigurationSettingSchema<T & string> | ITextConfigurationSettingSchema
	: [T] extends [string | boolean] ? ISelectConfigurationSettingSchema<T & (string | boolean)>
	: [T] extends [Record<string, unknown>] ? IStringMapConfigurationSettingSchema
	: never;

export interface IExtensionInfo {
	readonly id: string;
	readonly displayName?: string;
}

export interface IRegisteredConfiguration<T = unknown> {
	readonly tags?: readonly string[];
	readonly policy?: ConfigurationPolicy;
	readonly key: string;
	/** Catalog identity supplied by the extension owner, never inferred from a setting key. */
	readonly source?: IExtensionInfo;
	/** Declared section identity and label retained for Settings navigation. */
	readonly section?: { readonly id?: string; readonly title?: string; };
	readonly defaultValue: T;
	readonly parse: (value: unknown) => T;
	readonly serialize: (value: T) => unknown;
	readonly setting?: IConfigurationSettingSchema;
	readonly extensionBinding?: { readonly readCommand: string; readonly writeCommand: string; readonly property: string; };
	readonly scope?: ConfigurationScope;
	readonly schema?: JsonSchema;
	readonly agentsWindow?: { readonly default: T; readonly readOnly?: boolean; };
}

export interface IConfigurationKeyDefinition<T> {
	readonly tags?: readonly string[];
	readonly policy?: ConfigurationPolicy;
	readonly key: string;
	readonly defaultValue: T;
	readonly parse: (value: unknown) => T;
	readonly serialize?: (value: T) => unknown;
	readonly setting?: ConfigurationSettingSchemaFor<T>;
	readonly scope?: ConfigurationScope;
	readonly schema?: JsonSchema;
	/** Window defaults affect resolution only; the user document remains shared. */
	readonly agentsWindow?: { readonly default: T; readonly readOnly?: boolean; };
}

export interface IConfigurationRegistry {
	readonly onDidUpdateConfiguration: Event<{ properties: ReadonlySet<string>; defaultsOverrides?: boolean; }>;
	updateConfigurations(configurations: { add: IConfigurationNode[]; remove: IConfigurationNode[]; }): void;
	deltaConfiguration(delta: IConfigurationDelta): void;
	getConfigurationDefaultsOverrides(): Map<string, IConfigurationDefaultOverrideValue>;
	registerConfiguration<T>(definition: IConfigurationKeyDefinition<T>): string;
	getConfigurations(): readonly string[];
	getRegisteredConfigurations(): readonly IRegisteredConfiguration[];
	getConfiguration(key: string): IRegisteredConfiguration | undefined;
	owns(key: string): boolean;
}

export interface IConfigurationDefaults {
	readonly overrides: Readonly<Record<string, unknown>>;
	readonly source?: IExtensionInfo;
}

export interface IConfigurationDefaultOverrideValue {
	readonly value: unknown;
}

export interface IConfigurationDelta {
	readonly addedConfigurations?: IConfigurationNode[];
	readonly removedConfigurations?: IConfigurationNode[];
	readonly addedDefaults?: IConfigurationDefaults[];
	readonly removedDefaults?: IConfigurationDefaults[];
}

export interface IConfigurationNode {
	readonly extensionInfo?: IExtensionInfo;
	readonly id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly properties?: Readonly<Record<string, IConfigurationPropertySchema>>;
	readonly allOf?: readonly IConfigurationNode[];
	readonly scope?: ConfigurationScope;
}

/**
 * Registry of static Desktop keys and catalog-scoped extension schemas.
 *
 * Configuration services resolve and validate the canonical settings document
 * against these definitions; extension withdrawal leaves the document intact.
 */
export class ConfigurationRegistry implements IConfigurationRegistry {
	private readonly configurations = new Map<string, IRegisteredConfiguration>();
	private readonly nodes = new Map<IConfigurationNode, readonly string[]>();
	private defaults: IConfigurationDefaults[] = [];
	private changeEmitter: Emitter<{ properties: ReadonlySet<string>; }> | undefined;
	// The registry belongs to the realm. A temporary test registry's event channel
	// belongs to its consumers and releases when its last subscription ends.
	public readonly onDidUpdateConfiguration: IConfigurationRegistry['onDidUpdateConfiguration'] = (listener, thisArgs, disposables) => {
		const emitter: Emitter<{ properties: ReadonlySet<string>; }> = this.changeEmitter ??= new Emitter({ onDidRemoveLastListener: () => { this.changeEmitter = undefined; emitter.dispose(); } });
		return emitter.event(listener, thisArgs, disposables);
	};

	public updateConfigurations({ add, remove }: { add: IConfigurationNode[]; remove: IConfigurationNode[]; }): void {
		this.deltaConfiguration({ addedConfigurations: add, removedConfigurations: remove });
	}

	public deltaConfiguration(delta: IConfigurationDelta): void {
		const add = delta.addedConfigurations ?? [];
		const remove = delta.removedConfigurations ?? [];
		const next = new Map(this.configurations);
		const nodes = new Map(this.nodes);
		const properties = new Set<string>();
		for (const node of remove) {
			for (const key of nodes.get(node) ?? []) { next.delete(key); properties.add(key); }
			nodes.delete(node);
		}
		for (const node of add) {
			if (nodes.has(node)) continue;
			const keys: string[] = [];
			const visit = (node: IConfigurationNode, inheritedScope?: ConfigurationScope, source = node.extensionInfo, inheritedSection?: IRegisteredConfiguration['section']): void => {
				const section = node.id || node.title ? Object.freeze({ id: node.id, title: node.title }) : inheritedSection;
				for (const [key, schema] of Object.entries(node.properties ?? {})) {
					if (schema.included === false) continue;
					if (!isConfigurationKey(key) || next.has(key)) throw new TypeError(localize('configuration.contributedKey', "Invalid or duplicate contributed setting '{0}'.", key));
					const parse = (value: unknown): JsonValue => {
						const normalized = validateJsonValue(value);
						if (validateJsonSchema(parseJsonDocument(JSON.stringify(normalized)), schema).length) throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", key));
						return normalized;
					};
					const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
					const defaultValue = schema.default === undefined ? (type === 'string' ? '' : type === 'boolean' ? false : type === 'number' || type === 'integer' ? 0 : type === 'array' ? [] : type === 'object' ? {} : null) : schema.default;
					next.set(key, Object.freeze({
						key, source, section, defaultValue: parse(defaultValue), parse, serialize: parse, schema,
						tags: registeredTags(schema.tags),
						policy: registeredPolicy(schema.policy, defaultValue, next.values()),
						setting: schema.ashSetting, extensionBinding: schema.ashBinding,
						scope: schema.scope ?? node.scope ?? inheritedScope ?? ConfigurationScope.WINDOW,
						agentsWindow: schema.agentsWindow ? Object.freeze({ ...schema.agentsWindow, default: parse(schema.agentsWindow.default) }) : undefined,
					}));
					keys.push(key); properties.add(key);
				}
				for (const child of node.allOf ?? []) visit(child, node.scope ?? inheritedScope, source, section);
			};
			visit(node);
			nodes.set(node, keys);
		}
		const defaults = this.defaults.filter(entry => !delta.removedDefaults?.includes(entry));
		defaults.push(...(delta.addedDefaults ?? []));
		// Schemas and extension defaults become visible together, after the entire
		// candidate is valid. A rejected extension update keeps the live snapshot.
		configurationDefaultOverrides(next, defaults);
		for (const entry of [...(delta.addedDefaults ?? []), ...(delta.removedDefaults ?? [])]) {
			for (const [key, value] of Object.entries(entry.overrides)) {
				properties.add(key);
				if (overrideIdentifiersFromKey(key).length) {
					for (const property of Object.keys(value as Record<string, unknown>)) properties.add(property);
				}
			}
		}
		// Validate the complete replacement before withdrawing active registrations.
		this.configurations.clear();
		for (const [key, value] of next) this.configurations.set(key, value);
		this.nodes.clear();
		for (const [node, keys] of nodes) this.nodes.set(node, keys);
		this.defaults = defaults;
		if (properties.size) this.changeEmitter?.fire({ properties });
	}

	public getConfigurationDefaultsOverrides(): Map<string, IConfigurationDefaultOverrideValue> {
		return configurationDefaultOverrides(this.configurations, this.defaults);
	}

	registerConfiguration<T>(
		definition: IConfigurationKeyDefinition<T>,
	): string {
		if (!isConfigurationKey(definition.key)) {
			throw new TypeError(`Invalid configuration key: ${definition.key}`);
		}
		if (this.configurations.has(definition.key)) {
			throw new Error(
				`Configuration key is already registered: ${definition.key}`,
			);
		}
		const configuration: IRegisteredConfiguration<T> = Object.freeze({
			tags: registeredTags(definition.tags),
			policy: registeredPolicy(definition.policy, definition.defaultValue, this.configurations.values()),
			key: definition.key,
			scope: definition.scope,
			schema: definition.schema,
			defaultValue: definition.defaultValue,
			parse: definition.parse,
			serialize: definition.serialize ?? ((value: T) => value),
			setting: definition.setting as IConfigurationSettingSchema | undefined,
			agentsWindow: definition.agentsWindow ? Object.freeze({ ...definition.agentsWindow, default: definition.parse(definition.agentsWindow.default) }) : undefined,
		});
		this.configurations.set(definition.key, configuration as IRegisteredConfiguration);
		this.changeEmitter?.fire({ properties: new Set([definition.key]) });
		return definition.key;
	}

	getConfigurations(): readonly string[] {
		return [...this.configurations.keys()];
	}

	getRegisteredConfigurations(): readonly IRegisteredConfiguration[] {
		return [...this.configurations.values()];
	}

	getConfiguration(key: string): IRegisteredConfiguration | undefined {
		return this.configurations.get(key);
	}

	owns(key: string): boolean {
		return this.configurations.has(key);
	}
}

function configurationDefaultOverrides(configurations: ReadonlyMap<string, IRegisteredConfiguration>, defaults: readonly IConfigurationDefaults[]): Map<string, IConfigurationDefaultOverrideValue> {
	const values: Record<string, unknown> = {};
	for (const entry of defaults) {
		for (const [key, candidate] of Object.entries(entry.overrides)) {
			const language = overrideIdentifiersFromKey(key).length > 0;
			const properties = language ? candidate : { [key]: candidate };
			if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", key));
			const parsed: Record<string, unknown> = {};
			for (const [property, value] of Object.entries(properties)) {
				if (!isConfigurationKey(property)) throw new TypeError(localize('configuration.contributedKey', "Invalid or duplicate contributed setting '{0}'.", property));
				const setting = configurations.get(property);
				// Contributions may precede the setting's registration or target an
				// unsupported setting. Resolution includes only registered contracts.
				if (!setting) continue;
				if (language && setting.scope !== undefined && setting.scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE) continue;
				parsed[property] = structuredClone(setting.parse(value));
			}
			merge(values, language ? { [key]: parsed } : parsed, true);
		}
	}
	return new Map(Object.entries(values).map(([key, value]) => [key, { value }]));
}

/** Own a snapshot so contributors cannot silently change searchable metadata after registration. */
function registeredTags(tags: readonly string[] | undefined): readonly string[] | undefined {
	if (tags === undefined) return undefined;
	if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
		throw new TypeError('Configuration tags must be non-empty strings');
	}
	return Object.freeze([...new Set(tags)]);
}

Registry.add(Extensions.Configuration, new ConfigurationRegistry());

function isConfigurationKey(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9./-]{0,127}$/.test(value);
}

function registeredPolicy(value: unknown, defaultValue: unknown, existing: Iterable<IRegisteredConfiguration>): IRegisteredConfiguration['policy'] {
	if (value === undefined) return undefined;
	const policy = value as Partial<NonNullable<IRegisteredConfiguration['policy']>> | null;
	if (!policy || typeof policy.name !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(policy.name)
		|| policy.minimumVersion !== undefined && typeof policy.minimumVersion !== 'string'
		|| !['string', 'boolean', 'number'].includes(typeof defaultValue)
		|| [...existing].some(setting => setting.policy?.name === policy.name)) {
		throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", 'policy'));
	}
	if (policy.value !== undefined && typeof policy.value !== 'function') throw new TypeError('Invalid account policy mapping');
	const managedSettings: Record<string, IManagedSettingPolicyDefinition> = {};
	if (policy.managedSettings !== undefined) {
		if (!policy.managedSettings || typeof policy.managedSettings !== 'object' || Array.isArray(policy.managedSettings) || Object.keys(policy.managedSettings).length > 128) throw new TypeError('Invalid managed setting definitions');
		for (const [path, definition] of Object.entries(policy.managedSettings)) {
			if (!/^[A-Za-z][A-Za-z0-9._-]{0,255}$/.test(path) || !definition || !['string', 'number', 'boolean'].includes(definition.type)) throw new TypeError('Invalid managed setting definition');
			Object.defineProperty(managedSettings, path, { value: Object.freeze({ type: definition.type }), enumerable: true });
		}
	}
	return Object.freeze({
		name: policy.name,
		...(policy.minimumVersion === undefined ? {} : { minimumVersion: policy.minimumVersion }),
		...(policy.value === undefined ? {} : { value: policy.value }),
		...(policy.managedSettings === undefined ? {} : { managedSettings: Object.freeze(managedSettings) }),
	});
}

/** Identifiers are normalized at the settings-input boundary, before building a model. */
export function overrideIdentifiersFromKey(key: string): string[] {
	if (!key.startsWith('[')) return [];
	const parts = [...key.matchAll(/\[([A-Za-z0-9][A-Za-z0-9+_.-]{0,127})\]/gu)];
	if (parts.length === 0 || parts.map(part => part[0]).join('') !== key) {
		throw new TypeError(`invalid configuration override key: ${key}`);
	}
	return [...new Set(parts.map(part => part[1]!))];
}

export function keyFromOverrideIdentifiers(identifiers: string[]): string {
	const key = identifiers.map(identifier => `[${identifier}]`).join('');
	if (identifiers.length === 0 || overrideIdentifiersFromKey(key).length !== identifiers.length) {
		throw new TypeError('Configuration override identifiers must be non-empty and unique');
	}
	return key;
}
