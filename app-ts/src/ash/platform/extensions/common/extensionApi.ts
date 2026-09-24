export type ExtensionCatalogReload = "cached" | "refresh";
export type ExtensionSourceKind = "builtIn" | "plugin" | "marketplace" | "user";
export type ExtensionDiagnosticCode = "sourceUnavailable" | "invalidManifest" | "duplicateExtension" | "pathEscapesRoot" | "resourceNotFound" | "resourceTooLarge";

export interface ExtensionDescriptor {
	readonly id: string;
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly displayName: string;
	readonly sourceKind: ExtensionSourceKind;
	readonly manifestJson: string;
	readonly manifestSha256: string;
	readonly packageSha256: string;
}

export interface ExtensionDiagnostic {
	readonly source: string;
	readonly subject: string | undefined;
	readonly code: ExtensionDiagnosticCode;
	readonly message: string;
}

export interface ExtensionCatalog {
	readonly generation: number;
	readonly extensions: readonly ExtensionDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface ExtensionResourceRequest {
	readonly generation: number;
	readonly extensionId: string;
	readonly path: string;
}

interface ExtensionResourceMetadata {
	readonly resourceId: string;
	readonly mimeType: string;
	readonly size: number;
	readonly sha256: string;
}

interface ExtensionResourceChunk {
	readonly resourceId: string;
	readonly offset: number;
	readonly dataBase64: string;
	readonly decodedLength: number;
	readonly eof: boolean;
}

export const MAX_EXTENSION_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Renderer-facing capability for reading static, Rust-validated extension resources. */
export interface IExtensionApi {
	list(reload: ExtensionCatalogReload): Promise<ExtensionCatalog>;
	readResource(request: ExtensionResourceRequest): Promise<Uint8Array>;
}

export function normalizeExtensionCatalog(value: unknown): ExtensionCatalog {
	const catalog = record(value, "extension catalog");
	return Object.freeze({
		generation: nonNegativeSafeInteger(catalog.generation, "extension catalog generation"),
		extensions: Object.freeze(array(catalog.extensions, "extensions").map(normalizeExtension)),
		diagnostics: Object.freeze(array(catalog.diagnostics, "diagnostics").map(normalizeDiagnostic)),
	});
}

/** Validates the exact resource envelope returned by `extensions/resource/open`. */
export function normalizeExtensionResourceOpenResult(value: unknown): ExtensionResourceMetadata {
	const result = exactRecord(value, "extension resource result", ["resource"]);
	const resource = exactRecord(result.resource, "extension resource metadata", ["mimeType", "resourceId", "sha256", "size"]);
	const sha256 = sha256Digest(resource.sha256, "extension resource digest");
	return Object.freeze({
		resourceId: boundedSingleLineText(resource.resourceId, "extension resource ID", 256),
		mimeType: boundedSingleLineText(resource.mimeType, "extension resource MIME type", 256),
		size: boundedNonNegativeSafeInteger(resource.size, "extension resource size", MAX_EXTENSION_RESOURCE_BYTES),
		sha256,
	});
}

/** Validates one exact connection-owned resource chunk before it is decoded. */
export function normalizeExtensionResourceChunk(value: unknown): ExtensionResourceChunk {
	const chunk = exactRecord(value, "extension resource chunk", ["dataBase64", "decodedLength", "eof", "offset", "resourceId"]);
	if (typeof chunk.eof !== "boolean") throw new TypeError("extension resource chunk EOF marker is invalid");
	return Object.freeze({
		resourceId: boundedSingleLineText(chunk.resourceId, "extension resource chunk ID", 256),
		offset: nonNegativeSafeInteger(chunk.offset, "extension resource chunk offset"),
		dataBase64: boundedSingleLineText(chunk.dataBase64, "extension resource chunk data", 512 * 1024),
		decodedLength: boundedNonNegativeSafeInteger(chunk.decodedLength, "extension resource chunk decoded length", 262_144),
		eof: chunk.eof,
	});
}

/** Verifies that assembled bytes still match the host resource identity. */
export async function verifyExtensionResourceDigest(bytes: Uint8Array, expectedSha256: string): Promise<void> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
	const actual = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
	if (actual !== expectedSha256) throw new Error("Extension resource digest does not match its metadata");
}

function normalizeExtension(value: unknown): ExtensionDescriptor {
	const extension = record(value, "extension");
	return Object.freeze({
		id: boundedText(extension.id, "extension id", 160),
		name: boundedText(extension.name, "extension name", 256),
		publisher: boundedText(extension.publisher, "extension publisher", 256),
		version: boundedText(extension.version, "extension version", 256),
		displayName: boundedText(extension.displayName, "extension display name", 256),
		sourceKind: stringEnum(extension.sourceKind, "extension source kind", ["builtIn", "plugin", "marketplace", "user"] as const),
		manifestJson: boundedText(extension.manifestJson, "extension manifest", 4 * 1024 * 1024),
		manifestSha256: sha256Digest(extension.manifestSha256, "extension manifest digest"),
		packageSha256: sha256Digest(extension.packageSha256, "extension package digest"),
	});
}

function normalizeDiagnostic(value: unknown): ExtensionDiagnostic {
	const diagnostic = record(value, "extension diagnostic");
	return Object.freeze({
		source: boundedText(diagnostic.source, "extension diagnostic source", 64),
		subject: diagnostic.subject === null ? undefined : boundedText(diagnostic.subject, "extension diagnostic subject", 256),
		code: stringEnum(diagnostic.code, "extension diagnostic code", ["sourceUnavailable", "invalidManifest", "duplicateExtension", "pathEscapesRoot", "resourceNotFound", "resourceTooLarge"] as const),
		message: boundedText(diagnostic.message, "extension diagnostic message", 512),
	});
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(value: unknown, owner: string, keys: readonly string[]): Record<string, unknown> {
	const result = record(value, owner);
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${owner} has an invalid shape`);
	return result;
}

function array(value: unknown, owner: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedSingleLineText(value: unknown, owner: string, maximum: number): string {
	const result = boundedText(value, owner, maximum);
	if (/[\r\n]/u.test(result)) throw new TypeError(`${owner} is invalid`);
	return result;
}

function sha256Digest(value: unknown, owner: string): string {
	const result = boundedText(value, owner, 128);
	if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${owner} is invalid`);
	return result;
}

function stringEnum<const T extends readonly string[]>(value: unknown, owner: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function nonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${owner} is invalid`);
	return value as number;
}

function boundedNonNegativeSafeInteger(value: unknown, owner: string, maximum: number): number {
	const result = nonNegativeSafeInteger(value, owner);
	if (result > maximum) throw new TypeError(`${owner} is invalid`);
	return result;
}
