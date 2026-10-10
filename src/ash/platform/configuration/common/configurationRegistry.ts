import { validateJsonSchema, type JsonSchema } from '../../../base/common/jsonSchema.js';
import { parseJsonDocument } from '../../../base/common/json.js';
import { validateJsonValue } from '../../../base/common/jsonValue.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import type { JsonValue } from '../../../base/common/jsonValue.js';
import { Registry } from '../../registry/common/platform.js';

export const Extensions = {
	Configuration: 'base.contributions.configuration',
};

export enum ConfigurationScope {
	APPLICATION = 1, MACHINE = 2, WINDOW = 3, RESOURCE = 4, LANGUAGE_OVERRIDABLE = 5, MACHINE_OVERRIDABLE = 6, APPLICATION_MACHINE = 7,
}

export interface IConfigurationPropertySchema extends JsonSchema {
	readonly scope?: ConfigurationScope;
	readonly included?: boolean;
	readonly agentsWindow?: { readonly default: JsonValue; readonly readOnly?: boolean; };
}

interface IConfigurationSettingSchemaBase {
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

export type IConfigurationSettingSchema = IBooleanConfigurationSettingSchema | INumberConfigurationSettingSchema | ISelectConfigurationSettingSchema | ITextConfigurationSettingSchema | IStringMapConfigurationSettingSchema;

export type ConfigurationSettingSchemaFor<T> =
	[T] extends [boolean] ? IBooleanConfigurationSettingSchema
	: [T] extends [number] ? INumberConfigurationSettingSchema
	: [T] extends [string] ? ISelectConfigurationSettingSchema<T & string> | ITextConfigurationSettingSchema
	: [T] extends [string | boolean] ? ISelectConfigurationSettingSchema<T & (string | boolean)>
	: [T] extends [Record<string, unknown>] ? IStringMapConfigurationSettingSchema
	: never;

export interface IRegisteredConfiguration<T = unknown> {
	readonly key: string;
	readonly defaultValue: T;
	readonly parse: (value: unknown) => T;
	readonly serialize: (value: T) => unknown;
	readonly setting?: IConfigurationSettingSchema;
	readonly scope?: ConfigurationScope;
	readonly schema?: JsonSchema;
	readonly agentsWindow?: { readonly default: T; readonly readOnly?: boolean; };
}

export interface IConfigurationKeyDefinition<T> {
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
	registerConfiguration<T>(definition: IConfigurationKeyDefinition<T>): string;
	getConfigurations(): readonly string[];
	getRegisteredConfigurations(): readonly IRegisteredConfiguration[];
	getConfiguration(key: string): IRegisteredConfiguration | undefined;
	owns(key: string): boolean;
}

export interface IConfigurationNode {
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
	private changeEmitter: Emitter<{ properties: ReadonlySet<string>; }> | undefined;
	// The registry belongs to the realm. A temporary test registry's event channel
	// belongs to its consumers and releases when its last subscription ends.
	public readonly onDidUpdateConfiguration: IConfigurationRegistry['onDidUpdateConfiguration'] = (listener, thisArgs, disposables) => {
		const emitter: Emitter<{ properties: ReadonlySet<string>; }> = this.changeEmitter ??= new Emitter({ onDidRemoveLastListener: () => { this.changeEmitter = undefined; emitter.dispose(); } });
		return emitter.event(listener, thisArgs, disposables);
	};

	public updateConfigurations({ add, remove }: { add: IConfigurationNode[]; remove: IConfigurationNode[]; }): void {
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
			const visit = (node: IConfigurationNode, inheritedScope?: ConfigurationScope): void => {
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
					next.set(key, Object.freeze({ key, defaultValue: parse(defaultValue), parse, serialize: parse, schema, scope: schema.scope ?? node.scope ?? inheritedScope ?? ConfigurationScope.WINDOW }));
					keys.push(key); properties.add(key);
				}
				for (const child of node.allOf ?? []) visit(child, node.scope ?? inheritedScope);
			};
			visit(node);
			nodes.set(node, keys);
		}
		// Validate the complete replacement before withdrawing active registrations.
		this.configurations.clear();
		for (const [key, value] of next) this.configurations.set(key, value);
		this.nodes.clear();
		for (const [node, keys] of nodes) this.nodes.set(node, keys);
		if (properties.size) this.changeEmitter?.fire({ properties });
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

Registry.add(Extensions.Configuration, new ConfigurationRegistry());

function isConfigurationKey(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(value);
}
