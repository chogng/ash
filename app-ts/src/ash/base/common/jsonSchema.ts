import { type JsonDocument, type JsonValueNode } from './json.js';
import type { JsonValue } from './jsonValue.js';

export type JsonSchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';

export interface JsonSchema {
	readonly id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly markdownDescription?: string;
	readonly type?: JsonSchemaType | readonly JsonSchemaType[];
	readonly default?: JsonValue;
	readonly enum?: readonly JsonValue[];
	readonly enumDescriptions?: readonly string[];
	readonly markdownEnumDescriptions?: readonly string[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly patternProperties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | JsonSchema;
	readonly items?: JsonSchema | readonly JsonSchema[];
	readonly additionalItems?: boolean | JsonSchema;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly uniqueItems?: boolean;
	readonly minProperties?: number;
	readonly maxProperties?: number;
	readonly anyOf?: readonly JsonSchema[];
	readonly allOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
	readonly not?: JsonSchema;
	readonly $ref?: string;
	readonly format?: string;
	readonly examples?: readonly JsonValue[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	/** Backward-compatible aliases used by older Ash schemas. */
	readonly minimumLength?: number;
	readonly maximumLength?: number;
	readonly pattern?: string;
	readonly defaultSnippets?: readonly JsonSchemaSnippet[];
	readonly tags?: readonly string[];
	readonly deprecationMessage?: string;
	readonly markdownDeprecationMessage?: string;
	readonly errorMessage?: string;
	readonly patternErrorMessage?: string;
	readonly doNotSuggest?: boolean;
	readonly secret?: boolean;
	readonly allowComments?: boolean;
	readonly allowTrailingCommas?: boolean;
	readonly experiment?: JsonValue;
	readonly agentsWindow?: JsonValue;
	readonly included?: boolean;
	readonly restricted?: boolean;
}

/** JSON snippets supplied by settings providers such as font pickers. */
export interface JsonSchemaSnippet {
	readonly label?: string;
	readonly description?: string;
	readonly body?: JsonValue;
	readonly bodyText?: string;
}

export interface IJSONSchemaSnippet extends JsonSchemaSnippet { }

export interface JsonSchemaIssue {
	readonly message: string;
	readonly offset: number;
	readonly length: number;
}

/** Resolves a nested schema using object-property and array-index path segments. */
export function jsonSchemaAtPath(schema: JsonSchema | undefined, path: readonly (string | number)[]): JsonSchema | undefined {
	let current = schema;
	for (const segment of path) {
		if (!current) return undefined;
		if (typeof segment === 'number') {
			if (isSchemaTuple(current.items)) {
				const itemSchema = current.items[segment] ?? current.additionalItems;
				current = typeof itemSchema === 'object' ? itemSchema : undefined;
			} else {
				current = current.items;
			}
			continue;
		}
		current = current.properties?.[segment] ?? (typeof current.additionalProperties === 'object' ? current.additionalProperties : undefined);
	}
	return current;
}

/** Validates a parsed JSON document against the supported structural schema vocabulary. */
export function validateJsonSchema(document: JsonDocument, schema: JsonSchema | undefined): readonly JsonSchemaIssue[] {
	if (!document.root || !schema) return Object.freeze([]);
	const issues: JsonSchemaIssue[] = [];
	validateNode(document.root, schema, issues);
	return Object.freeze(issues);
}

function validateNode(node: JsonValueNode, schema: JsonSchema, issues: JsonSchemaIssue[]): void {
	if (schema.anyOf && !schema.anyOf.some(candidate => matchesSchema(node, candidate))) {
		issues.push(issue('Value does not match any permitted schema', node));
		return;
	}
	if (schema.oneOf && schema.oneOf.filter(candidate => matchesSchema(node, candidate)).length !== 1) {
		issues.push(issue('Value must match exactly one permitted schema', node));
		return;
	}
	for (const candidate of schema.allOf ?? []) validateNode(node, candidate, issues);
	if (schema.not && matchesSchema(node, schema.not)) {
		issues.push(issue('Value matches a forbidden schema', node));
		return;
	}
	const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types && !types.some(type => nodeMatchesType(node, type))) {
		issues.push(issue(`Expected ${types.join(' or ')}`, node));
		return;
	}
	if (schema.enum && !schema.enum.some(candidate => equalJson(candidate, nodeValue(node)))) {
		issues.push(issue('Value is not one of the permitted values', node));
	}
	if (node.type === 'number') {
		if (schema.minimum !== undefined && node.value < schema.minimum) issues.push(issue(`Value must be at least ${schema.minimum}`, node));
		if (schema.maximum !== undefined && node.value > schema.maximum) issues.push(issue(`Value must be at most ${schema.maximum}`, node));
	}
	if (node.type === 'string') {
		const minimumLength = schema.minLength ?? schema.minimumLength;
		const maximumLength = schema.maxLength ?? schema.maximumLength;
		if (minimumLength !== undefined && node.value.length < minimumLength) issues.push(issue(`String must contain at least ${minimumLength} characters`, node));
		if (maximumLength !== undefined && node.value.length > maximumLength) issues.push(issue(`String must contain at most ${maximumLength} characters`, node));
		if (schema.pattern !== undefined) {
			try {
				if (!new RegExp(schema.pattern, 'u').test(node.value)) issues.push(issue('String does not match the required pattern', node));
			} catch {
				issues.push(issue('Schema contains an invalid regular expression', node));
			}
		}
	}
	if (node.type === 'array' && schema.items) {
		if (isSchemaTuple(schema.items)) {
			for (let index = 0; index < node.items.length; index++) {
				const itemSchema = schema.items[index] ?? schema.additionalItems;
				if (itemSchema && typeof itemSchema !== 'boolean') validateNode(node.items[index], itemSchema, issues);
			}
		} else {
			for (const item of node.items) validateNode(item, schema.items, issues);
		}
	}
	if (node.type === 'array') {
		if (schema.minItems !== undefined && node.items.length < schema.minItems) issues.push(issue(`Array must contain at least ${schema.minItems} items`, node));
		if (schema.maxItems !== undefined && node.items.length > schema.maxItems) issues.push(issue(`Array must contain at most ${schema.maxItems} items`, node));
		if (schema.uniqueItems && new Set(node.items.map(nodeValue).map(value => JSON.stringify(value))).size !== node.items.length) issues.push(issue('Array items must be unique', node));
	}
	if (node.type !== 'object') return;
	if (schema.minProperties !== undefined && node.properties.length < schema.minProperties) issues.push(issue(`Object must contain at least ${schema.minProperties} properties`, node));
	if (schema.maxProperties !== undefined && node.properties.length > schema.maxProperties) issues.push(issue(`Object must contain at most ${schema.maxProperties} properties`, node));
	const seen = new Set<string>();
	for (const property of node.properties) {
		if (seen.has(property.key)) issues.push(issue(`Duplicate property '${property.key}'`, property.keyNode));
		seen.add(property.key);
		if (!property.valueNode) continue;
		const propertySchema = schema.properties?.[property.key];
		if (propertySchema) {
			validateNode(property.valueNode, propertySchema, issues);
			continue;
		}
		if (schema.additionalProperties === false) issues.push(issue(`Property '${property.key}' is not permitted`, property.keyNode));
		if (typeof schema.additionalProperties === 'object') validateNode(property.valueNode, schema.additionalProperties, issues);
	}
	for (const required of schema.required ?? []) {
		if (!seen.has(required)) issues.push(issue(`Required property '${required}' is missing`, node));
	}
}

function matchesSchema(node: JsonValueNode, schema: JsonSchema): boolean {
	const issues: JsonSchemaIssue[] = [];
	validateNode(node, schema, issues);
	return issues.length === 0;
}

function isSchemaTuple(items: JsonSchema['items']): items is readonly JsonSchema[] {
	return Array.isArray(items);
}

function nodeMatchesType(node: JsonValueNode, type: JsonSchemaType): boolean {
	if (type === 'integer') return node.type === 'number' && Number.isInteger(node.value);
	return node.type === type;
}

function nodeValue(node: JsonValueNode): JsonValue {
	switch (node.type) {
		case 'string': return node.value;
		case 'number': return node.value;
		case 'boolean': return node.value;
		case 'null': return null;
		case 'array': return node.items.map(nodeValue);
		case 'object': {
			const value: Record<string, JsonValue> = {};
			for (const property of node.properties) {
				if (property.valueNode) Object.defineProperty(value, property.key, { value: nodeValue(property.valueNode), enumerable: true, configurable: true, writable: true });
			}
			return value;
		}
	}
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function issue(message: string, node: { readonly offset: number; readonly length: number }): JsonSchemaIssue {
	return Object.freeze({ message, offset: node.offset, length: Math.max(node.length, 1) });
}
