import { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IExtensionResourceLoaderService } from '../../extensionResourceLoader/common/extensionResourceLoader.js';

export type ExtensionCatalogReload = 'cached' | 'refresh';
export const IExtensionApi = createServiceIdentifier<IExtensionApi>('extensionCatalogApi');
export type ExtensionSourceKind = 'builtIn' | 'plugin' | 'registry' | 'user';
export type ExtensionDiagnosticCode =
	| 'sourceUnavailable'
	| 'invalidManifest'
	| 'duplicateExtension'
	| 'pathEscapesRoot'
	| 'resourceNotFound'
	| 'resourceTooLarge';

/** Backend admission for an exact, verified first-party client package. Manifest text cannot grant this. */
export interface ExtensionRendererClient {
	readonly runtimeId: string;
	readonly apiVersion: 1;
	readonly entry: string;
	readonly digest: string;
	readonly style: string;
	readonly styleDigest: string;
	readonly sourceDigest: string;
}

export interface ExtensionDescriptor {
	readonly id: string;
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly displayName: string;
	readonly sourceKind: ExtensionSourceKind;
	readonly extensionLocation?: string;
	readonly targetPlatform?: string;
	readonly manifestJson: string;
	readonly manifestSha256: string;
	readonly packageSha256: string;
	readonly rendererClient?: ExtensionRendererClient;
	/** Backend-attested executable owner when Plugin and catalog digest domains differ. */
	readonly runtimeBinding?: { readonly runtimeId: string; readonly packageDigest: string };
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

export const MAX_EXTENSION_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Client package metadata and resources, with host validation for installed external packages. */
export interface IExtensionApi {
	readonly onDidChange?: Event<void>;
	/** Management may include disabled packages; activation consumers use the default enabled view. */
	list(reload: ExtensionCatalogReload, options?: { readonly includeDisabled?: boolean }): Promise<ExtensionCatalog>;
	readonly resources: IExtensionResourceLoaderService;
}

export function normalizeExtensionCatalog(value: unknown): ExtensionCatalog {
	const catalog = record(value, 'extension catalog');
	return Object.freeze({
		generation: nonNegativeSafeInteger(catalog.generation, 'extension catalog generation'),
		extensions: Object.freeze(array(catalog.extensions, 'extensions').map(normalizeExtension)),
		diagnostics: Object.freeze(array(catalog.diagnostics, 'diagnostics').map(normalizeDiagnostic)),
	});
}

function normalizeExtension(value: unknown): ExtensionDescriptor {
	const extension = record(value, 'extension');
	const extensionLocation =
		extension.extensionLocation === undefined
			? undefined
			: boundedText(extension.extensionLocation, 'extension location', 32768);
	if (extensionLocation !== undefined) {
		const location = URI.parse(extensionLocation);
		if (
			location.scheme !== 'file' ||
			!location.path.startsWith('/') ||
			location.query ||
			location.fragment ||
			location.path.includes('\0')
		)
			throw new TypeError('extension location is invalid');
	}
	const targetPlatform =
		extension.targetPlatform === undefined
			? undefined
			: boundedText(extension.targetPlatform, 'extension target platform', 128);
	if (targetPlatform !== undefined && !/^[a-z0-9]+-[a-z0-9_]+$/.test(targetPlatform))
		throw new TypeError('extension target platform is invalid');
	const sourceKind = stringEnum(extension.sourceKind, 'extension source kind', [
		'builtIn',
		'plugin',
		'registry',
		'user',
	] as const);
	let runtimeBinding: ExtensionDescriptor['runtimeBinding'];
	if (extension.runtimeBinding !== undefined) {
		if (sourceKind !== 'plugin') throw new TypeError('extension runtime binding requires a Plugin source');
		const binding = record(extension.runtimeBinding, 'extension runtime binding');
		if (Object.keys(binding).some(key => key !== 'runtimeId' && key !== 'packageDigest'))
			throw new TypeError('extension runtime binding has an unknown field');
		const runtimeId = boundedText(binding.runtimeId, 'extension runtime id', 256);
		if (/[\u0000-\u001f\u007f]/.test(runtimeId)) throw new TypeError('extension runtime id is invalid');
		runtimeBinding = Object.freeze({
			runtimeId,
			packageDigest: sha256Digest(binding.packageDigest, 'extension runtime package digest'),
		});
	}
	return Object.freeze({
		id: boundedText(extension.id, 'extension id', 160),
		name: boundedText(extension.name, 'extension name', 256),
		publisher: boundedText(extension.publisher, 'extension publisher', 256),
		version: boundedText(extension.version, 'extension version', 256),
		displayName: boundedText(extension.displayName, 'extension display name', 256),
		sourceKind,
		...(runtimeBinding === undefined ? {} : { runtimeBinding }),
		...(extensionLocation === undefined ? {} : { extensionLocation }),
		...(targetPlatform === undefined ? {} : { targetPlatform }),
		manifestJson: boundedText(extension.manifestJson, 'extension manifest', 4 * 1024 * 1024),
		manifestSha256: sha256Digest(extension.manifestSha256, 'extension manifest digest'),
		packageSha256: sha256Digest(extension.packageSha256, 'extension package digest'),
		...(extension.rendererClient === undefined || extension.rendererClient === null
			? {}
			: { rendererClient: normalizeRendererClient(extension.rendererClient) }),
	});
}

function normalizeRendererClient(value: unknown): ExtensionRendererClient {
	const client = record(value, 'renderer client admission');
	if (client.apiVersion !== 1) throw new TypeError('Unsupported renderer client API');
	const path = (value: unknown): string => {
		const result = boundedText(value, 'renderer client resource', 1024);
		if (/[\\:\0]/u.test(result) || result.split('/').some(part => !part || part === '.' || part === '..'))
			throw new TypeError('Invalid renderer client resource');
		return result;
	};
	return Object.freeze({
		runtimeId: boundedText(client.runtimeId, 'renderer client runtime', 1024),
		apiVersion: 1,
		entry: path(client.entry),
		digest: sha256Digest(client.digest, 'renderer client digest'),
		style: path(client.style),
		styleDigest: sha256Digest(client.styleDigest, 'renderer client style digest'),
		sourceDigest: sha256Digest(client.sourceDigest, 'renderer client source digest'),
	});
}

function normalizeDiagnostic(value: unknown): ExtensionDiagnostic {
	const diagnostic = record(value, 'extension diagnostic');
	return Object.freeze({
		source: boundedText(diagnostic.source, 'extension diagnostic source', 64),
		subject:
			diagnostic.subject === null
				? undefined
				: boundedText(diagnostic.subject, 'extension diagnostic subject', 256),
		code: stringEnum(diagnostic.code, 'extension diagnostic code', [
			'sourceUnavailable',
			'invalidManifest',
			'duplicateExtension',
			'pathEscapesRoot',
			'resourceNotFound',
			'resourceTooLarge',
		] as const),
		message: boundedText(diagnostic.message, 'extension diagnostic message', 512),
	});
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, owner: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
		throw new TypeError(`${owner} is invalid`);
	return value;
}

function sha256Digest(value: unknown, owner: string): string {
	const result = boundedText(value, owner, 128);
	if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${owner} is invalid`);
	return result;
}

function stringEnum<const T extends readonly string[]>(value: unknown, owner: string, values: T): T[number] {
	if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function nonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${owner} is invalid`);
	return value as number;
}
