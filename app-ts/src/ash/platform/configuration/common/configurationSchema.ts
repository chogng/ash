import type { JsonSchema, JsonSchemaType } from '../../../base/common/jsonSchema.js';
import { validateJsonValue, type JsonValue } from '../../../base/common/jsonValue.js';
import { Registry } from '../../registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IConfigurationSettingSchema } from './configurationRegistry.js';

export const ConfigurationSchemaId = 'ash://schemas/user-configuration';

/** Projects registered typed configuration keys into the generic JSON schema vocabulary. */
export function createConfigurationSchema(registry: IConfigurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	for (const configuration of registry.getRegisteredConfigurations()) {
		const defaultValue = validateJsonValue(configuration.serialize(configuration.defaultValue), {
			path: `configuration default ${configuration.key}`,
		});
		properties[configuration.key] = configurationPropertySchema(defaultValue, configuration.setting);
	}
	return Object.freeze({
		id: ConfigurationSchemaId,
		title: 'Ash User Settings',
		type: 'object',
		properties: Object.freeze(properties),
		additionalProperties: true,
	});
}

function configurationPropertySchema(defaultValue: JsonValue, setting: IConfigurationSettingSchema | undefined): JsonSchema {
	const schema: {
		title?: string;
		description?: string;
		type: JsonSchemaType;
		default: JsonValue;
		minimum?: number;
		maximum?: number;
		enum?: readonly JsonValue[];
		enumDescriptions?: readonly string[];
	} = {
		type: jsonSchemaType(defaultValue),
		default: defaultValue,
	};
	if (!setting) return Object.freeze(schema);
	schema.title = setting.title;
	schema.description = setting.description;
	if (setting.valueType === 'number') {
		schema.minimum = setting.minimum;
		schema.maximum = setting.maximum;
	}
	if (setting.valueType === 'select') {
		schema.enum = Object.freeze([...setting.options.map(option => option.value)]);
		schema.enumDescriptions = Object.freeze([...setting.options.map(option => option.label)]);
	}
	return Object.freeze(schema);
}

function jsonSchemaType(value: JsonValue): JsonSchemaType {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	switch (typeof value) {
		case 'boolean': return 'boolean';
		case 'number': return 'number';
		case 'string': return 'string';
		case 'object': return 'object';
	}
}
