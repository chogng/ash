import { DocumentTypes } from '../../services/documentEditor/common/documentTypes.js';
import { parseExtensionManifest } from '../../services/extensions/common/extensionManifest.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { createDocumentEditorPane } from '../../contrib/documentEditor/browser/editorProfile.js';
import { match } from '../../../base/common/glob.js';
import { basename } from '../../../base/common/resources.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
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
	private readonly reservedPackages = new Set<string>();

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
		const catalog = await this.packages.list('cached', { includeDisabled: true });
		if (epoch !== this.epoch || snapshot.generation < this.generation || this.isDisposed) return;
		for (const owner of catalog.extensions) {
			const reservationKey = `${owner.id}/${owner.manifestSha256}`;
			if (owner.sourceKind !== 'builtIn' || this.reservedPackages.has(reservationKey) || !owner.manifestJson) continue;
			const raw = JSON.parse(owner.manifestJson);
			if (raw.ashRuntime?.kind !== 'rust') continue;
			const manifest = parseExtensionManifest(owner.manifestJson, owner);
			const types = manifest.contributes.customEditors.filter(editor => editor.priority === 'default').flatMap(editor => {
				const extensions = editor.selector.flatMap(selector => selector.filenamePattern && /^\*\.[A-Za-z0-9-]+$/u.test(selector.filenamePattern) ? [selector.filenamePattern.slice(1).toLowerCase()] : []);
				return [...new Set(editor.selector.flatMap(selector => selector.mimeType ? [selector.mimeType] : []))].map(contentType => ({ contentType, extensions }));
			});
			if (types.length) {
				this._register(DocumentTypes.reserveTypes(types));
				this.reservedPackages.add(reservationKey);
			}
		}
		const active = new Set<string>();
		const pending: Promise<void>[] = [];
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'dataChannel' || registration.channelId !== 'editor.client.v1') continue;
				const key = `${runtime.id}\0${registration.registrationId}`;
				active.add(key);
				const identity = JSON.stringify([runtime.id, runtime.version, runtime.packageDigest, runtime.incarnation, runtime.activationGeneration, registration]);
				const current = this.registrations.get(key);
				if (current?.identity === identity) {
					pending.push(current.pending);
					continue;
				}
				this.registrations.deleteAndDispose(key);
				const lifetime = new DisposableStore();
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				const operation = this.register(runtime, registration.registrationId, lifetime, controller.signal);
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

	private async register(runtime: ExtensionHostRuntime, registrationId: string, lifetime: DisposableStore, signal: AbortSignal): Promise<void> {
		try {
			const catalog = await this.packages.list('cached');
			signal.throwIfAborted();
			const owner = catalog.extensions.find(entry => entry.id === runtime.id && entry.version === runtime.version && entry.sourceKind === 'builtIn');
			if (!owner) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
			const value = await this.api.invoke({
				extensionId: runtime.id, registrationId, incarnation: runtime.incarnation!, activationGeneration: runtime.activationGeneration,
				operation: 'receiveData', payload: { operation: 'describe', language: getNLSLanguage() }, deadlineUnixMillis: Date.now() + this.timeout,
			}, signal);
			signal.throwIfAborted();
			const { clientModule, clientDigest, editors } = parseContribution(value);
			// Register only after the entire declaration is valid. No static factory supplies a fallback.
			const descriptors = editors.map((editor): IEditorPaneDescriptor => {
				const resolveDocumentProfile = async () => {
					signal.throwIfAborted();
					const latest = await this.packages.list('cached');
					const admitted = latest.extensions.find(entry => entry.id === owner.id
						&& entry.version === owner.version
						&& entry.sourceKind === 'builtIn'
						&& entry.packageSha256 === owner.packageSha256);
					if (!admitted) throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
					const component = await this.loadModule(owner.name, clientModule, clientDigest);
					signal.throwIfAborted();
					if (component.packageId !== owner.id || component.packageVersion !== owner.version) {
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

/** This is a domain payload on the existing typed channel, not a second transport protocol. */
function parseContribution(value: JsonValue): ClientEditorContribution {
	const object = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client editor declaration');
		return value as Readonly<Record<string, JsonValue>>;
	};
	const text = (value: JsonValue | undefined, limit: number): string => {
		if (typeof value !== 'string' || !value || value.length > limit || /[\p{Cc}]/u.test(value)) throw new TypeError('Invalid client editor text');
		return value;
	};
	const input = object(value);
	if (input.version !== 1 || Object.keys(input).sort().join(',') !== 'clientDigest,clientModule,editors,version') throw new TypeError('Unsupported client editor contract');
	const clientModule = text(input.clientModule, 512);
	const clientDigest = text(input.clientDigest, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(clientDigest)) throw new TypeError('Invalid client editor digest');
	if (/[\\:\0]/u.test(clientModule) || clientModule.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('Client editor module must belong to its package');
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
