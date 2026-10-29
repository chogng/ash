import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import type { ExtensionCustomEditorContribution } from '../../services/extensions/common/extensionManifest.js';
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
import { EditorPane, EditorPaneMatch } from '../../browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../common/editor.js';
import type { ExtensionEditorModuleLoader } from '../../services/extensions/browser/extensionEditor.js';

interface ClientEditor {
	readonly editorId: string;
	readonly displayName: string;
	readonly selectors: readonly string[];
	readonly documentType?: string;
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

/** Projects live Rust capabilities admitted by this window's package catalog into its editor registry. */
export class MainThreadClientEditors extends Disposable {
	private readonly dormantEditors = this._register(new DisposableMap<string, IDisposable & { readonly identity: string }>());
	private readonly registrations = this._register(new DisposableMap<string, RegistrationScope>());
	private generation = 0;
	private epoch = 0;
	private readonly reservedPackages = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		private readonly timeout: number,
		private readonly loadModule: ExtensionEditorModuleLoader,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IExtensionApi private readonly packages: IExtensionApi,
		@IExtensionService private readonly extensions: IExtensionService,
	) {
		super();
	}

	public async update(snapshot: ExtensionHostFleetSnapshot): Promise<void> {
		this.assertNotDisposed();
		if (snapshot.generation < this.generation) return;
		this.generation = snapshot.generation;
		const epoch = this.epoch;
		const [catalog, enabledCatalog] = await Promise.all([this.packages.list('cached', { includeDisabled: true }), this.packages.list('cached')]);
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
			const types = manifest.contributes.customEditors
				.filter(editor => editor.priority === 'default')
				.flatMap(editor => {
					const extensions = editor.selector.flatMap(selector =>
						selector.filenamePattern && /^\*\.[A-Za-z0-9-]+$/u.test(selector.filenamePattern) ? [selector.filenamePattern.slice(1).toLowerCase()] : [],
					);
					return [...new Set(editor.selector.flatMap(selector => (selector.mimeType ? [selector.mimeType] : [])))].map(contentType => ({ contentType, extensions }));
				});
			if (types.length) {
				this.reservedPackages.set(reservationKey, DocumentTypes.reserveTypes(types));
			}
		}
		for (const key of this.reservedPackages.keys()) {
			if (!reservations.has(key)) this.reservedPackages.deleteAndDispose(key);
		}
		const dormant = new Set<string>();
		const declarations = this.extensions.getExtensionPointContributions<readonly ExtensionCustomEditorContribution[]>('customEditors');
		for (const runtime of snapshot.extensions) {
			if (!['dormant', 'starting', 'handshaking'].includes(runtime.lifecycle) || !runtime.activation?.events.includes('onDemand:dataChannel')) {
				continue;
			}
			const owner = findRuntimePackage(enabledCatalog.extensions, runtime);
			if (!owner?.rendererClient) continue;
			const editors = declarations.find(entry => entry.description.id === owner.id)?.value;
			if (!editors?.length) continue;
			dormant.add(runtime.id);
			const identity = JSON.stringify([runtime.activationGeneration, owner.packageSha256, owner.manifestSha256, owner.rendererClient]);
			if (this.dormantEditors.get(runtime.id)?.identity === identity) continue;
			this.dormantEditors.deleteAndDispose(runtime.id);
			const registration = this.registerDormantEditors(runtime, owner, editors);
			this.dormantEditors.set(
				runtime.id,
				Object.assign(
					toDisposable(() => registration.dispose()),
					{ identity },
				),
			);
		}
		// Withdraw declarations before ready registrations publish those same editor IDs.
		for (const key of this.dormantEditors.keys()) {
			if (!dormant.has(key)) {
				this.dormantEditors.deleteAndDispose(key);
			}
		}
		const active = new Set<string>();
		const pending: Promise<void>[] = [];
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			// The backend fleet can serve sibling windows. An absent local package must not
			// activate a renderer or make an otherwise healthy window report a provider failure.
			if (!catalog.extensions.some(owner => owner.id === runtime.id || owner.rendererClient?.runtimeId === runtime.id)) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'dataChannel' || !['editor.client.v1', 'editor.resource.v1'].includes(registration.channelId)) continue;
				const key = `${runtime.id}\0${registration.registrationId}`;
				active.add(key);
				const owner = findRuntimePackage(enabledCatalog.extensions, runtime);
				const identity = clientEditorIdentity(runtime, registration, owner);
				const current = this.registrations.get(key);
				if (current?.identity === identity) {
					pending.push(current.pending);
					continue;
				}
				this.registrations.deleteAndDispose(key);
				const lifetime = new DisposableStore();
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				const kind = registration.channelId === 'editor.client.v1' ? 'document' : 'resource';
				const operation = this.register(runtime, registration.registrationId, kind, lifetime, controller.signal);
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
		this.dormantEditors.clearAndDisposeAll();
	}

	private registerDormantEditors(runtime: ExtensionHostRuntime, owner: ExtensionDescriptor, editors: readonly ExtensionCustomEditorContribution[]): IDisposable {
		const epoch = this.epoch;
		const descriptors = editors.map((editor): IEditorPaneDescriptor => {
			const resolve = async (): Promise<IEditorPaneDescriptor> => {
				this.assertNotDisposed();
				if (epoch !== this.epoch) {
					throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				}
				const activated = await this.api.activateByEvent({
					extensionId: runtime.id,
					activationGeneration: runtime.activationGeneration,
					event: { type: 'capability', capability: 'dataChannel' },
				});
				if (epoch !== this.epoch || this.isDisposed) {
					throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				}
				const current = activated.extensions.find(
					entry => entry.id === runtime.id && entry.activationGeneration === runtime.activationGeneration && entry.packageDigest === runtime.packageDigest && entry.lifecycle === 'ready',
				);
				if (!current) {
					throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
				}
				await this.update(activated);
				if (epoch !== this.epoch || this.isDisposed) {
					throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				}
				const channel = current.registrations.find(registration => registration.kind === 'dataChannel' && ['editor.client.v1', 'editor.resource.v1'].includes(registration.channelId));
				const scope = channel && this.registrations.get(`${current.id}\0${channel.registrationId}`);
				if (!channel || !scope || scope.identity !== clientEditorIdentity(current, channel, owner)) {
					throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				}
				const actual = EditorPanes.getEditorPanes().find(entry => entry.id === editor.viewType && entry !== descriptor);
				if (!actual) {
					throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
				}
				return actual;
			};
			const contentType = editor.selector.find(selector => selector.mimeType)?.mimeType;
			const descriptor: IEditorPaneDescriptor = {
				id: editor.viewType,
				name: editor.displayName,
				...(editor.documentType && contentType
					? {
							documentType: {
								id: editor.documentType,
								contentType,
								extensions: editor.selector.flatMap(selector =>
									selector.filenamePattern && /^\*\.[A-Za-z0-9-]+$/u.test(selector.filenamePattern) ? [selector.filenamePattern.slice(1).toLowerCase()] : [],
								),
							},
							resolveDocumentProfile: async () => {
								const actual = await resolve();
								if (!actual.resolveDocumentProfile) {
									throw new TypeError(localize('extensions.clientEditor.profileMismatch', 'The editor profile does not match its extension declaration.'));
								}
								return actual.resolveDocumentProfile();
							},
						}
					: { resourceEditor: true }),
				canOpen: input => {
					if (isResourceDiffEditorInput(input)) return EditorPaneMatch.None;
					const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
					const matches = editor.selector.some(
						selector =>
							(selector.filenamePattern &&
								match(selector.filenamePattern.toLowerCase(), (selector.filenamePattern.includes('/') ? input.resource.path : basename(input.resource)).toLowerCase())) ||
							(selector.mimeType && selector.mimeType === mediaType),
					);
					return !matches ? EditorPaneMatch.None : editor.priority === 'default' ? EditorPaneMatch.Default : EditorPaneMatch.Optional;
				},
				create: async options => (await resolve()).create(options),
			};
			return descriptor;
		});
		return EditorPanes.registerEditorPanes(descriptors);
	}

	private async register(runtime: ExtensionHostRuntime, registrationId: string, kind: 'document' | 'resource', lifetime: DisposableStore, signal: AbortSignal): Promise<void> {
		try {
			const catalog = await this.packages.list('cached');
			signal.throwIfAborted();
			const owner = findRuntimePackage(catalog.extensions, runtime);
			if (!owner) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
			const value = await this.api.invoke(
				{
					extensionId: runtime.id,
					registrationId,
					incarnation: runtime.incarnation!,
					activationGeneration: runtime.activationGeneration,
					operation: 'receiveData',
					payload: { operation: 'describe', language: getNLSLanguage() },
					deadlineUnixMillis: Date.now() + this.timeout,
				},
				signal,
			);
			signal.throwIfAborted();
			const { clientModule, clientDigest, editors } = parseContribution(value, kind);
			let loaded: ReturnType<ExtensionEditorModuleLoader> | undefined;
			const admittedPackage = async () => {
				signal.throwIfAborted();
				const latest = await this.packages.list('cached');
				const admitted = latest.extensions.find(
					entry =>
						entry.id === owner.id &&
						entry.version === owner.version &&
						entry.sourceKind === owner.sourceKind &&
						entry.manifestSha256 === owner.manifestSha256 &&
						entry.packageSha256 === owner.packageSha256 &&
						JSON.stringify(entry.rendererClient) === JSON.stringify(owner.rendererClient),
				);
				signal.throwIfAborted();
				if (!admitted) throw new Error(localize('extensions.clientEditor.packageRetired', 'The editor extension package has retired.'));
				return { admitted, generation: latest.generation };
			};
			const resolveComponent = async () => {
				const { admitted, generation } = await admittedPackage();
				if (!loaded) {
					loaded = this.loadModule({
						package: admitted,
						generation,
						entry: clientModule,
						expectedDigest: clientDigest,
						resources: this.packages.resources,
						signal,
						assertCurrent: async () => {
							await admittedPackage();
						},
					}).catch(error => {
						loaded = undefined;
						throw error;
					});
				}
				const component = await loaded;
				signal.throwIfAborted();
				if (component.packageId !== owner.id || component.packageVersion !== owner.version) {
					throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
				}
				return component;
			};
			if (kind === 'resource') {
				const declared = parseExtensionManifest(owner.manifestJson, owner).contributes.customEditors;
				const descriptors = editors.map((editor): IEditorPaneDescriptor => {
					const declaration = declared.find(entry => entry.viewType === editor.editorId);
					if (
						!declaration ||
						declaration.priority !== 'default' ||
						!editor.selectors.every(pattern => declaration.selector.some(selector => selector.filenamePattern === pattern)) ||
						!declaration.selector.some(selector => selector.mimeType === editor.contentType)
					)
						throw new TypeError(localize('extensions.clientEditor.resourceDeclarationMismatch', 'The resource editor does not match its package declaration.'));
					return {
						id: editor.editorId,
						name: editor.displayName,
						resourceEditor: true,
						canOpen: input => {
							if (isResourceDiffEditorInput(input)) return EditorPaneMatch.None;
							return input.contentType?.split(';', 1)[0].trim().toLowerCase() === editor.contentType ||
								editor.selectors.some(pattern => match(pattern.toLowerCase(), (pattern.includes('/') ? input.resource.path : basename(input.resource)).toLowerCase()))
								? EditorPaneMatch.Default
								: EditorPaneMatch.None;
						},
						create: async options => {
							const component = await resolveComponent();
							if (!('getResourceEditor' in component) || typeof component.getResourceEditor !== 'function')
								throw new TypeError(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
							if (!options.instantiationService) throw new Error('Resource editor requires the Workbench instantiation service');
							const Constructor = component.getResourceEditor(editor.editorId, (constructor, ...args) => {
								signal.throwIfAborted();
								return options.instantiationService!.createInstance(constructor, ...args);
							});
							if (typeof Constructor !== 'function') throw new TypeError('Invalid resource editor constructor');
							const pane = options.instantiationService.createInstance(Constructor, signal);
							if (!(pane instanceof EditorPane)) throw new TypeError(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
							if (pane.id !== editor.editorId) {
								pane.dispose();
								throw new TypeError(localize('extensions.clientEditor.resourceDeclarationMismatch', 'The resource editor does not match its package declaration.'));
							}
							return pane;
						},
					};
				});
				lifetime.add(EditorPanes.registerEditorPanes(descriptors));
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
					return {
						...profile,
						editorId: editor.editorId,
						create: () => {
							signal.throwIfAborted();
							const configuration = profile.create();
							const formats = configuration.artifactFormats;
							if (formats !== undefined) {
								if (!Array.isArray(formats) || formats.length > 16) throw new TypeError('Invalid document artifact formats');
								const ids = new Set<string>();
								for (const format of formats) {
									if (
										!format ||
										typeof format.id !== 'string' ||
										!/^[a-z][a-z0-9-]{0,39}$/.test(format.id) ||
										ids.has(format.id) ||
										typeof format.extension !== 'string' ||
										!/^[a-z0-9]{1,12}$/.test(format.extension) ||
										typeof format.label !== 'string' ||
										!format.label ||
										format.label.length > 200 ||
										typeof format.mimeType !== 'string' ||
										!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(format.mimeType) ||
										typeof format.canImport !== 'boolean'
									)
										throw new TypeError('Invalid document artifact format');
									ids.add(format.id);
								}
							}
							const importBinary = configuration.importBinary;
							if ((importBinary !== undefined && typeof importBinary !== 'function') || (formats?.some(format => format.canImport) && !importBinary))
								throw new TypeError('Invalid document artifact importer');
							return {
								...configuration,
								artifactFormats: formats?.map(format => Object.freeze({ ...format })),
								importBinary: importBinary
									? async (bytes: Uint8Array, format: string, ownerDocument: Document, requestSignal: AbortSignal) => {
											const lifetime = AbortSignal.any([signal, requestSignal]);
											lifetime.throwIfAborted();
											const document = await importBinary.call(configuration, bytes, format, ownerDocument, lifetime);
											lifetime.throwIfAborted();
											return document;
										}
									: undefined,
							};
						},
					};
				};
				return {
					id: editor.editorId,
					name: editor.displayName,
					documentType: {
						id: editor.documentType!,
						contentType: editor.contentType,
						extensions: editor.selectors.filter(pattern => /^\*\.[A-Za-z0-9-]+$/u.test(pattern)).map(pattern => pattern.slice(1).toLowerCase()),
					},
					canOpen: input => {
						if (isResourceDiffEditorInput(input)) return EditorPaneMatch.None;
						const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
						const matches =
							editor.selectors.some(pattern => {
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
	return packages.find(
		owner =>
			owner.version === runtime.version &&
			(owner.sourceKind === 'builtIn' ? owner.id === runtime.id : owner.rendererClient?.runtimeId === runtime.id && owner.packageSha256 === runtime.packageDigest),
	);
}

/** This is a domain payload on the existing typed channel, not a second transport protocol. */
function parseContribution(value: JsonValue, kind: 'document' | 'resource'): ClientEditorContribution {
	const object = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client editor declaration');
		return value as Readonly<Record<string, JsonValue>>;
	};
	const text = (value: JsonValue | undefined, limit: number): string => {
		if (typeof value !== 'string' || !value || value.length > limit || /[\p{Cc}]/u.test(value)) throw new TypeError('Invalid client editor text');
		return value;
	};
	const input = object(value);
	const fields = 'clientDigest,clientModule,editors,version';
	if (input.version !== 1 || Object.keys(input).sort().join(',') !== fields) throw new TypeError('Unsupported client editor contract');
	const clientModule = text(input.clientModule, 512);
	const clientDigest = text(input.clientDigest, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(clientDigest)) throw new TypeError('Invalid client editor digest');
	if (/[\\:\0]/u.test(clientModule) || clientModule.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('Client editor module must belong to its package');
	if (!Array.isArray(input.editors) || !input.editors.length || input.editors.length > 32) throw new TypeError('Invalid client editor declarations');
	const ids = new Set<string>();
	const editors = input.editors.map(value => {
		const entry = object(value);
		if (Object.keys(entry).sort().join(',') !== (kind === 'document' ? 'contentType,displayName,documentType,editorId,selectors' : 'contentType,displayName,editorId,selectors'))
			throw new TypeError('Invalid client editor fields');
		const editorId = text(entry.editorId, 256);
		if (ids.has(editorId)) throw new TypeError('Duplicate client editor');
		ids.add(editorId);
		if (!Array.isArray(entry.selectors) || entry.selectors.length > 64) throw new TypeError('Invalid client editor selectors');
		return {
			editorId,
			displayName: text(entry.displayName, 512),
			...(kind === 'document' ? { documentType: text(entry.documentType, 256) } : {}),
			contentType: text(entry.contentType, 256),
			selectors: entry.selectors.map(value => text(value, 512)),
		};
	});
	return { clientModule, clientDigest, editors };
}

function clientEditorIdentity(runtime: ExtensionHostRuntime, registration: ExtensionHostRuntime['registrations'][number], owner: ExtensionDescriptor | undefined): string {
	return JSON.stringify([
		runtime.id,
		runtime.version,
		runtime.packageDigest,
		runtime.incarnation,
		runtime.activationGeneration,
		registration,
		owner?.packageSha256,
		owner?.manifestSha256,
		owner?.rendererClient,
	]);
}
