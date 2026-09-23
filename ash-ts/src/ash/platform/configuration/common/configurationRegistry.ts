import type { JsonSchema } from '../../../base/common/jsonSchema.js';
import { Registry } from '../../registry/common/platform.js';

export const Extensions = {
	Configuration: 'base.contributions.configuration',
};

export interface IConfigurationPropertySchema extends JsonSchema {
	readonly scope?: string;
	readonly included?: boolean;
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
	readonly options: readonly { readonly value: T; readonly label: string }[];
}

export interface ITextConfigurationSettingSchema extends IConfigurationSettingSchemaBase {
	readonly valueType: 'text';
	readonly placeholder: string;
}

export type IConfigurationSettingSchema = IBooleanConfigurationSettingSchema | INumberConfigurationSettingSchema | ISelectConfigurationSettingSchema | ITextConfigurationSettingSchema;

export type ConfigurationSettingSchemaFor<T> =
	[T] extends [boolean] ? IBooleanConfigurationSettingSchema
		: [T] extends [number] ? INumberConfigurationSettingSchema
			: [T] extends [string] ? ISelectConfigurationSettingSchema<T & string> | ITextConfigurationSettingSchema
				: [T] extends [string | boolean] ? ISelectConfigurationSettingSchema<T & (string | boolean)>
				: never;

export interface IRegisteredConfiguration<T = unknown> {
	readonly key: string;
	readonly defaultValue: T;
	readonly parse: (value: unknown) => T;
	readonly serialize: (value: T) => unknown;
	readonly setting?: IConfigurationSettingSchema;
}

export interface IConfigurationKeyDefinition<T> {
	readonly key: string;
	readonly defaultValue: T;
	readonly parse: (value: unknown) => T;
	readonly serialize?: (value: T) => unknown;
	readonly setting?: ConfigurationSettingSchemaFor<T>;
}

export interface IConfigurationRegistry {
	registerConfiguration<T>(definition: IConfigurationKeyDefinition<T>): string;
	getConfigurations(): readonly string[];
	getRegisteredConfigurations(): readonly IRegisteredConfiguration[];
	getConfiguration(key: string): IRegisteredConfiguration | undefined;
	owns(key: string): boolean;
}

/**
 * Registry of statically declared Desktop configuration keys.
 *
 * Keys are registered once for the current JavaScript realm. Configuration
 * services use the registry to validate complete persisted snapshots.
 */
export class ConfigurationRegistry implements IConfigurationRegistry {
	private readonly configurations = new Map<string, IRegisteredConfiguration>();

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
			defaultValue: definition.defaultValue,
			parse: definition.parse,
			serialize: definition.serialize ?? ((value: T) => value),
			setting: definition.setting as IConfigurationSettingSchema | undefined,
		});
		this.configurations.set(definition.key, configuration as IRegisteredConfiguration);
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
