import { EditorExtensionsRegistry } from '../../../editor/browser/editorExtensions.js';
import { DocumentTypes } from '../../services/documentEditor/common/documentTypes.js';
import { parseExtensionManifest } from '../../services/extensions/common/extensionManifest.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { createDocumentEditorPane } from '../../contrib/documentEditor/browser/editorProfile.js';
import { match } from '../../../base/common/glob.js';
import { basename } from '../../../base/common/resources.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IExtensionApi, type ExtensionDescriptor } from '../../../platform/extensions/common/extensionApi.js';
import { EditorPanes, type IEditorPaneDescriptor } from '../../browser/editor.js';
import { EditorPaneMatch } from '../../browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../common/editor.js';
import type { ExtensionEditorModuleLoader } from '../../services/extensions/browser/extensionEditor.js';

interface ClientEditor {
	readonly editorId: string;
	readonly displayName: string;
	readonly selectors: readonly string[];
	readonly documentType: string;
	readonly contentType: string;
}

interface ClientEditorContribution {
	readonly clientModule: string;
	readonly clientDigest: string;
	readonly editors: readonly ClientEditor[];
}

interface RegistrationScope extends DisposableStore {
	readonly identity: string;
	readonly pending: Promise<void>;
}

/** Projects a live Rust capability into the shared editor registry. Sessions is only a consumer. */
export class MainThreadClientEditors extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, RegistrationScope>());
	private generation = 0;
	private epoch = 0;
	private readonly reservedPackages = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		private readonly timeout: number,
		private readonly loadModule: ExtensionEditorModuleLoader,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IExtensionApi private readonly packages: IExtensionApi,
	) {
		super();
	}

	public async update(snapshot: ExtensionHostFleetSnapshot): Promise<void> {
		this.assertNotDisposed();
		if (snapshot.generation < this.generation) return;
		this.generation = snapshot.generation;
		const epoch = this.epoch;
		const [catalog, enabledCatalog] = await Promise.all([
			this.packages.list('cached', { includeDisabled: true }),
			this.packages.list('cached'),
		]);
		if (epoch !== this.epoch || snapshot.generation < this.generation || this.isDisposed) return;
		const reservations = new Set<string>();
		for (const owner of catalog.extensions) {
			const reservationKey = `${owner.id}/${owner.manifestSha256}`;
			if (!owner.manifestJson) continue;
			reservations.add(reservationKey);
			if (this.reservedPackages.has(reservationKey)) continue;
			const raw = JSON.parse(owner.manifestJson);
			if (raw.ashRuntime?.kind !== 'rust') continue;
			const manifest = parseExtensionManifest(owner.manifestJson, owner);
			const types = manifest.contributes.customEditors.filter(editor => editor.priority === 'default').flatMap(editor => {
				const extensions = editor.selector.flatMap(selector => selector.filenamePattern && /^\*\.[A-Za-z0-9-]+$/u.test(selector.filenamePattern) ? [selector.filenamePattern.slice(1).toLowerCase()] : []);
				return [...new Set(editor.selector.flatMap(selector => selector.mimeType ? [selector.mimeType] : []))].map(contentType => ({ contentType, extensions }));
			});
			if (types.length) {
				this.reservedPackages.set(reservationKey, DocumentTypes.reserveTypes(types));
			}
		}
		for (const key of this.reservedPackages.keys()) {
			if (!reservations.has(key)) this.reservedPackages.deleteAndDispose(key);
		}
		const active = new Set<string>();
		const pending: Promise<void>[] = [];
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'dataChannel' || !['editor.client.v1', 'editor.contributions.v1'].includes(registration.channelId)) continue;
				const key = `${runtime.id}\0${registration.registrationId}`;
				active.add(key);
				const owner = findRuntimePackage(enabledCatalog.extensions, runtime);
				const identity = JSON.stringify([runtime.id, runtime.version, runtime.packageDigest, runtime.incarnation, runtime.activationGeneration, registration, owner?.packageSha256, owner?.manifestSha256, owner?.rendererClient]);
				const current = this.registrations.get(key);
				if (current?.identity === identity) {
					pending.push(current.pending);
					continue;
				}
				this.registrations.deleteAndDispose(key);
				const lifetime = new DisposableStore();
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				const operation = this.register(runtime, registration.registrationId, registration.channelId === 'editor.client.v1' ? 'document' : 'contributions', lifetime, controller.signal);
				const scope = Object.assign(lifetime, { identity, pending: operation });
				this.registrations.set(key, scope);
				pending.push(operation);
			}
		}
		for (const key of this.registrations.keys()) {
			if (!active.has(key)) this.registrations.deleteAndDispose(key);
		}
		try {
			await Promise.all(pending);
		} catch (error) {
			// A temporary catalog/read failure may retry with the same live process identity.
			for (const [key, scope] of this.registrations) {
				if (scope.isDisposed) this.registrations.deleteAndDispose(key);
			}
			throw error;
		}
	}

	public clear(): void {
		this.epoch++;
		this.generation = 0;
		this.registrations.clearAndDisposeAll();
	}

	private async register(runtime: ExtensionHostRuntime, registrationId: string, kind: 'document' | 'contributions', lifetime: DisposableStore, signal: AbortSignal): Promise<void> {
		try {
			const catalog = await this.packages.list('cached');
			signal.throwIfAborted();
			const owner = findRuntimePackage(catalog.extensions, runtime);
			if (!owner) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
			const value = await this.api.invoke({
				extensionId: runtime.id, registrationId, incarnation: runtime.incarnation!, activationGeneration: runtime.activationGeneration,
				operation: 'receiveData', payload: { operation: 'describe', language: getNLSLanguage() }, deadlineUnixMillis: Date.now() + this.timeout,
			}, signal);
			signal.throwIfAborted();
			const { clientModule, clientDigest, editors } = parseContribution(value, kind);
			let loaded: ReturnType<ExtensionEditorModuleLoader> | undefined;
			const admittedPackage = async () => {
				signal.throwIfAborted();
				const latest = await this.packages.list('cached');
				const admitted = latest.extensions.find(entry => entry.id === owner.id
					&& entry.version === owner.version
					&& entry.sourceKind === owner.sourceKind
					&& entry.manifestSha256 === owner.manifestSha256
					&& entry.packageSha256 === owner.packageSha256
					&& JSON.stringify(entry.rendererClient) === JSON.stringify(owner.rendererClient));
				signal.throwIfAborted();
				if (!admitted) throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				return { admitted, generation: latest.generation };
			};
			const resolveComponent = async () => {
				const { admitted, generation } = await admittedPackage();
				if (!loaded) {
					loaded = this.loadModule({
						package: admitted, generation, entry: clientModule,
						expectedDigest: clientDigest, resources: this.packages.resources, signal,
						assertCurrent: async () => { await admittedPackage(); },
					}).catch(error => { loaded = undefined; throw error; });
				}
				const component = await loaded;
				signal.throwIfAborted();
				if (component.packageId !== owner.id || component.packageVersion !== owner.version) {
					throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
				}
				return component;
			};
			if (kind === 'contributions') {
				const declared = parseExtensionManifest(owner.manifestJson, owner).contributes.editorFeatures;
				if (!declared?.some(feature => feature.target === 'text')) throw new TypeError('Editor features were not declared by their package');
				const component = await resolveComponent();
				if (!('getEditorFeatures' in component) || typeof component.getEditorFeatures !== 'function') {
					throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
				}
				lifetime.add(EditorExtensionsRegistry.registerEditorFeatures(component.getEditorFeatures()));
				return;
			}
			// Register only after the entire declaration is valid. No static factory supplies a fallback.
			const descriptors = editors.map((editor): IEditorPaneDescriptor => {
				const resolveDocumentProfile = async () => {
					const component = await resolveComponent();
					if (!('getEditorProfile' in component) || typeof component.getEditorProfile !== 'function') {
						throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
					}
					const profile = component.getEditorProfile(editor.editorId);
					if (profile.id !== editor.documentType || profile.contentType !== editor.contentType) {
						throw new Error(localize('extensions.clientEditor.profileMismatch', 'The editor profile does not match its extension declaration.'));
					}
					return { ...profile, editorId: editor.editorId };
				};
				return {
					id: editor.editorId,
					name: editor.displayName,
					documentType: {
						id: editor.documentType, contentType: editor.contentType,
						extensions: editor.selectors.filter(pattern => /^\*\.[A-Za-z0-9-]+$/u.test(pattern)).map(pattern => pattern.slice(1).toLowerCase()),
					},
					canOpen: input => {
						if (isResourceDiffEditorInput(input)) return EditorPaneMatch.None;
						const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
						const matches = editor.selectors.some(pattern => {
							const path = pattern.includes('/') ? input.resource.path : basename(input.resource);
							return match(pattern.toLowerCase(), path.toLowerCase());
						}) || mediaType === editor.contentType;
						return matches ? EditorPaneMatch.Default : EditorPaneMatch.None;
					},
					resolveDocumentProfile,
					create: async options => createDocumentEditorPane(await resolveDocumentProfile(), options, signal, `${owner.id}@${owner.version}/${clientDigest}/${editor.documentType}`),
				};
			});
			lifetime.add(EditorPanes.registerEditorPanes(descriptors));
		} catch (error) {
			const cancelled = signal.aborted;
			lifetime.dispose();
			if (!cancelled) throw error;
		}
	}
}

/** Installed clients are bound to backend-verified admission and the exact live package digest. */
function findRuntimePackage(packages: readonly ExtensionDescriptor[], runtime: ExtensionHostRuntime): ExtensionDescriptor | undefined {
	return packages.find(owner => owner.version === runtime.version && (owner.sourceKind === 'builtIn'
		? owner.id === runtime.id
		: owner.rendererClient?.runtimeId === runtime.id && owner.packageSha256 === runtime.packageDigest));
}

/** This is a domain payload on the existing typed channel, not a second transport protocol. */
function parseContribution(value: JsonValue, kind: 'document' | 'contributions'): ClientEditorContribution {
	const object = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client editor declaration');
		return value as Readonly<Record<string, JsonValue>>;
	};
	const text = (value: JsonValue | undefined, limit: number): string => {
		if (typeof value !== 'string' || !value || value.length > limit || /[\p{Cc}]/u.test(value)) throw new TypeError('Invalid client editor text');
		return value;
	};
	const input = object(value);
	const fields = kind === 'document' ? 'clientDigest,clientModule,editors,version' : 'clientDigest,clientModule,version';
	if (input.version !== 1 || Object.keys(input).sort().join(',') !== fields) throw new TypeError('Unsupported client editor contract');
	const clientModule = text(input.clientModule, 512);
	const clientDigest = text(input.clientDigest, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(clientDigest)) throw new TypeError('Invalid client editor digest');
	if (/[\\:\0]/u.test(clientModule) || clientModule.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('Client editor module must belong to its package');
	if (kind === 'contributions') return { clientModule, clientDigest, editors: [] };
	if (!Array.isArray(input.editors) || !input.editors.length || input.editors.length > 32) throw new TypeError('Invalid client editor declarations');
	const ids = new Set<string>();
	const editors = input.editors.map(value => {
		const entry = object(value);
		if (Object.keys(entry).sort().join(',') !== 'contentType,displayName,documentType,editorId,selectors') throw new TypeError('Invalid client editor fields');
		const editorId = text(entry.editorId, 256);
		if (ids.has(editorId)) throw new TypeError('Duplicate client editor');
		ids.add(editorId);
		if (!Array.isArray(entry.selectors) || entry.selectors.length > 64) throw new TypeError('Invalid client editor selectors');
		return {
			editorId, displayName: text(entry.displayName, 512), documentType: text(entry.documentType, 256),
			contentType: text(entry.contentType, 256), selectors: entry.selectors.map(value => text(value, 512)),
		};
	});
	return { clientModule, clientDigest, editors };
}
