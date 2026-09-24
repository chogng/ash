import { type JsonValue, validateJsonValue } from "../../../base/common/jsonValue.js";
import { parseJsonc } from '../../../base/common/jsonc.js';

export const CONFIGURATION_READ_CHANNEL = "ash:configuration:read";
export const CONFIGURATION_UPDATE_CHANNEL = "ash:configuration:update";
export const CONFIGURATION_CHANGED_CHANNEL = "ash:configuration:changed";

export type ConfigurationValue = JsonValue;

export interface IConfigurationOverrideValues {
	readonly key: string;
	readonly identifiers: readonly string[];
	readonly values: Readonly<Record<string, ConfigurationValue>>;
}

/** Versioned Desktop configuration persisted by the host. */
export interface IConfigurationDocument {
	readonly version: 1;
	readonly source: string;
}

/** One host-authoritative configuration snapshot. */
export interface IConfigurationSnapshot {
	readonly revision: number;
	readonly document: IConfigurationDocument;
}

/** Compare-and-swap update used to avoid overwriting a newer snapshot. */
export interface IConfigurationUpdateRequest {
	readonly expectedRevision: number;
	readonly document: IConfigurationDocument;
}

export interface IConfigurationSubscription {
	dispose(): void;
}

/** Narrow context-bridge capability for Desktop configuration transport. */
export interface IConfigurationApi {
	read(): Promise<unknown>;
	update(request: IConfigurationUpdateRequest): Promise<unknown>;
	onDidChange(listener: (snapshot: unknown) => void): IConfigurationSubscription;
}

export function emptyConfigurationDocument(): IConfigurationDocument {
	return { version: 1, source: '{}\n' };
}

/** Validates an untrusted persisted configuration document. */
export function validateConfigurationDocument(value: unknown): IConfigurationDocument {
	const document = exactRecord(value, ['source', 'version']);
	if (document.version !== 1) throw new Error("configuration version must be 1");
	if (typeof document.source !== 'string') throw new Error('configuration source must be text');
	if (document.source.length > 4 * 1024 * 1024) throw new Error('configuration source is too large');
	configurationValues({ version: 1, source: document.source });
	return { version: 1, source: document.source };
}

/** Parses the canonical JSONC source into a validated configuration-value projection. */
export function configurationValues(document: IConfigurationDocument): Readonly<Record<string, ConfigurationValue>> {
	const parsed = parseJsonc(document.source, 'configuration source');
	return validateConfigurationValues(parsed).values;
}

export function configurationOverrideValues(document: IConfigurationDocument): readonly IConfigurationOverrideValues[] {
	const parsed = parseJsonc(document.source, 'configuration source');
	return validateConfigurationValues(parsed).overrides;
}

function validateConfigurationValues(value: unknown): { readonly values: Readonly<Record<string, ConfigurationValue>>; readonly overrides: readonly IConfigurationOverrideValues[] } {
	const values = record(value, 'configuration source');
	const validated: Record<string, ConfigurationValue> = {};
	const overrides: IConfigurationOverrideValues[] = [];
	for (const [key, candidate] of Object.entries(values)) {
		const identifiers = overrideIdentifiersFromKey(key);
		if (identifiers) {
			const overrideValues = record(candidate, `configuration source.${key}`);
			const validatedOverride: Record<string, ConfigurationValue> = {};
			for (const [overrideKey, overrideValue] of Object.entries(overrideValues)) {
				assertConfigurationKey(overrideKey);
				validatedOverride[overrideKey] = validateJsonValue(overrideValue, { path: `configuration source.${key}.${overrideKey}` });
			}
			overrides.push(Object.freeze({ key, identifiers: Object.freeze(identifiers), values: Object.freeze(validatedOverride) }));
			continue;
		}
		assertConfigurationKey(key);
		validated[key] = validateJsonValue(candidate, { path: `configuration source.${key}` });
	}
	return Object.freeze({ values: Object.freeze(validated), overrides: Object.freeze(overrides) });
}

export function overrideIdentifiersFromKey(key: string): string[] | undefined {
	if (!key.startsWith('[')) return undefined;
	const identifiers: string[] = [];
	let offset = 0;
	while (offset < key.length) {
		if (key.charCodeAt(offset) !== 91) throw new Error(`invalid configuration override key: ${key}`);
		const end = key.indexOf(']', offset + 1);
		if (end < 0) throw new Error(`invalid configuration override key: ${key}`);
		const identifier = key.slice(offset + 1, end);
		if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/u.test(identifier)) throw new Error(`invalid configuration override identifier: ${identifier}`);
		if (!identifiers.includes(identifier)) identifiers.push(identifier);
		offset = end + 1;
	}
	if (identifiers.length === 0) throw new Error(`invalid configuration override key: ${key}`);
	return identifiers;
}

export function overrideKeyFromIdentifiers(identifiers: readonly string[]): string {
	if (identifiers.length === 0) throw new RangeError('Configuration override identifiers must not be empty');
	const key = identifiers.map(identifier => `[${identifier}]`).join('');
	const normalized = overrideIdentifiersFromKey(key)!;
	if (normalized.length !== identifiers.length) throw new RangeError('Configuration override identifiers must be unique');
	return key;
}

function assertConfigurationKey(key: string): void {
	if (!/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(key)) throw new Error(`invalid configuration key: ${key}`);
}

export function validateConfigurationSnapshot(value: unknown): IConfigurationSnapshot {
	const snapshot = exactRecord(value, ["document", "revision"]);
	return { revision: nonNegativeSafeInteger(snapshot.revision, "revision"), document: validateConfigurationDocument(snapshot.document) };
}

export function validateConfigurationUpdateRequest(value: unknown): IConfigurationUpdateRequest {
	const request = exactRecord(value, ["document", "expectedRevision"]);
	return { expectedRevision: nonNegativeSafeInteger(request.expectedRevision, "expectedRevision"), document: validateConfigurationDocument(request.document) };
}

export function validateConfigurationRead(value: unknown): undefined {
	if (value !== undefined) throw new Error("configuration read does not accept parameters");
	return undefined;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	const result = record(value, "configuration");
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`configuration object must contain exactly: ${expected.join(", ")}`);
	return result;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative safe integer`);
	return value as number;
}
