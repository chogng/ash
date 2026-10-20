import { localize } from '../../../nls.js';
import { match } from '../../../base/common/glob.js';
import { Event } from '../../../base/common/event.js';
import { basename } from '../../../base/common/resources.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import type { ExtensionCustomEditorContribution } from '../../services/extensions/common/extensionManifest.js';
import { IExtensionHostApi, type ExtensionHostRuntime, type ExtensionHostFleetSnapshot, type ExtensionHostCustomEditorRegistration, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { EditorPanes } from '../../browser/editor.js';
import { EditorPaneMatch } from '../../browser/parts/editor/editorPane.js';
import { WebviewEditor, type CustomTextEditorProvider } from '../../contrib/webviewPanel/browser/webviewEditor.js';
import '../../contrib/customEditor/browser/customEditorInputFactory.js';
import { CustomEditorInput } from '../../contrib/customEditor/browser/customEditorInput.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';

/** Connects one activated extension provider to the existing editor pane registry. */
export class MainThreadCustomEditors extends Disposable {
	private readonly providers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly bindings = new Map<string, {
		readonly identity: string;
		runtime: ExtensionHostRuntime;
		registration: ExtensionHostCustomEditorRegistration;
		incarnation: number | undefined;
	}>();
	constructor(
		private readonly timeout: number,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IExtensionApi private readonly packages: IExtensionApi,
		@IExtensionService private readonly extensions: IExtensionService,
	) {
		super();
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const declarations = this.extensions.getExtensionPointContributions<readonly ExtensionCustomEditorContribution[]>('customEditors');
		const entries = snapshot.extensions.flatMap(runtime => {
			if (runtime.lifecycle === 'ready' && runtime.incarnation !== undefined) {
				return runtime.registrations.flatMap(registration => registration.kind === 'customTextEditor' ? [{ runtime, registration }] : []);
			}
			if (!['dormant', 'starting', 'handshaking'].includes(runtime.lifecycle)) { return []; }
			return declarations.filter(owner => owner.description.id === runtime.id).flatMap(owner => owner.value.flatMap(editor => {
				if (editor.priority === 'explicit' || !runtime.activation?.events.includes(`onCapability:customEditor:${editor.viewType}`)) { return []; }
				const registration: ExtensionHostCustomEditorRegistration = {
					kind: 'customTextEditor', registrationId: `lazy:${editor.viewType}`, viewType: editor.viewType,
					displayName: editor.displayName, priority: editor.priority,
					selectors: editor.selector.flatMap(selector => selector.filenamePattern ? [selector.filenamePattern] : []),
				};
				return [{ runtime, registration }];
			}));
		});
		const active = new Set<string>();
		for (const { registration } of entries) {
			if (active.has(registration.viewType)) { throw new TypeError(`Duplicate custom editor '${registration.viewType}'`); }
			active.add(registration.viewType);
		}
		for (const { runtime, registration } of entries) {
			const identity = JSON.stringify([runtime.id, runtime.version, runtime.packageDigest, runtime.activationGeneration, registration.viewType]);
			const previous = this.bindings.get(registration.viewType);
			if (previous?.identity === identity && (previous.incarnation === undefined || previous.incarnation === runtime.incarnation)) {
				previous.runtime = runtime;
				previous.registration = registration;
				previous.incarnation = runtime.incarnation;
				continue;
			}
			this.providers.deleteAndDispose(registration.viewType);
			const lifetime = new DisposableStore();
			this.providers.set(registration.viewType, lifetime);
			const controller = new AbortController();
			lifetime.add(toDisposable(() => controller.abort()));
			const binding = { identity, runtime, registration, incarnation: runtime.incarnation };
			this.bindings.set(registration.viewType, binding);
			lifetime.add(this.registerCustomTextEditorProvider(registration, async (operation, payload, signal) => {
				const requestSignal = AbortSignal.any([controller.signal, signal]);
				requestSignal.throwIfAborted();
				if (binding.runtime.lifecycle !== 'ready') {
					const activated = await this.api.activateByEvent({
						extensionId: runtime.id, activationGeneration: runtime.activationGeneration,
						event: { type: 'capability', capability: `customEditor:${registration.viewType}` },
					});
					requestSignal.throwIfAborted();
					const current = activated.extensions.find(candidate => candidate.id === runtime.id && candidate.activationGeneration === runtime.activationGeneration && candidate.packageDigest === runtime.packageDigest && candidate.lifecycle === 'ready');
					const actual = current?.registrations.find(candidate => candidate.kind === 'customTextEditor' && candidate.viewType === registration.viewType);
					if (!current || actual?.kind !== 'customTextEditor') { throw new TypeError(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.')); }
					binding.runtime = current;
					binding.registration = actual;
					binding.incarnation = current.incarnation;
				}
				return this.api.invoke({
					extensionId: runtime.id, registrationId: binding.registration.registrationId,
					activationGeneration: binding.runtime.activationGeneration, incarnation: binding.runtime.incarnation!,
					operation, payload, deadlineUnixMillis: Date.now() + this.timeout,
				}, requestSignal);
			}, runtime));
		}
		for (const key of this.providers.keys()) {
			if (!active.has(key)) {
				this.providers.deleteAndDispose(key);
				this.bindings.delete(key);
			}
		}
	}

	public clear(): void {
		this.providers.clearAndDisposeAll();
		this.bindings.clear();
	}

	public registerCustomTextEditorProvider(
		registration: ExtensionHostCustomEditorRegistration,
		invoke: (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
		owner?: { readonly id: string; readonly version: string; }): IDisposable {
		const resourceCache = new Map<string, string>();
		let resourceGeneration: number | undefined;
		const readResource = async (value: JsonValue | undefined, signal: AbortSignal): Promise<string> => {
			if (typeof value !== 'string' || value.startsWith('blob:')) return readWebviewResource(value, resourceCache, signal);
			if (!owner || !value || /[\\:\0]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
				throw new TypeError('Custom editor resource must be a path in its own package');
			}
			const catalog = await this.packages.list('cached');
			const entry = catalog.extensions.find(entry => entry.id === owner.id && entry.version === owner.version);
			// Product Rust executables are bound by the launcher. Installed executable packages
			// will need their exact admitted package binding before using this resource path.
			if (entry?.sourceKind !== 'builtIn') throw new TypeError('Custom editor package is unavailable');
			if (resourceGeneration !== catalog.generation) { resourceCache.clear(); resourceGeneration = catalog.generation; }
			const key = `${catalog.generation}:${value}`;
			let text = resourceCache.get(key);
			if (text === undefined) {
				const bytes = await this.packages.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: owner.id, path: value });
				text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				if (resourceGeneration === catalog.generation) resourceCache.set(key, text);
			}
			signal.throwIfAborted();
			return text;
		};
		return EditorPanes.registerEditorPane({
			id: registration.viewType,
			name: registration.displayName,
			createInput: input => new CustomEditorInput(input, registration.viewType),
			canOpen: input => {
				const path = input.resource.path;
				const matches = registration.selectors.some(pattern => match(pattern.toLowerCase(), (pattern.includes('/') ? path : basename(input.resource)).toLowerCase()));
				const languageMatches = input.languageId !== undefined && registration.languageIds?.includes(input.languageId);
				if (!matches && !languageMatches) {
					return EditorPaneMatch.None;
				}
				return registration.priority === 'default' ? EditorPaneMatch.Default : EditorPaneMatch.Optional;
			},
			create: options => this.instantiation.createInstance(WebviewEditor, {
				viewType: registration.viewType,
				displayName: registration.displayName,
				render: async (document, signal) => {
					const result = await invoke('resolveCustomTextEditor', { document: { ...document } }, signal);
					if (typeof result !== 'object' || result === null || Array.isArray(result) || !('html' in result) || typeof result.html !== 'string') {
						throw new TypeError('Custom editor provider must return HTML');
					}
					let html = result.html;
					if ('resources' in result) {
						const resources = result.resources;
						if (!resources || typeof resources !== 'object' || Array.isArray(resources) || Object.keys(resources).sort().join(',') !== 'script,style') {
							throw new TypeError('Custom editor resources require a script and stylesheet');
						}
						const assets = resources as Readonly<Record<string, JsonValue>>;
						const [script, style] = await Promise.all([readResource(assets.script, signal), readResource(assets.style, signal)]);
						// Resource bytes execute only inside the opaque sandbox, outside the JSON edit channel.
						html = `<style>${style.replaceAll(/<\/style/gi, '<\\/style')}</style>${html}<script>${script.replaceAll(/<\/script/gi, '<\\/script')}</script>`;
					}
					const update = result.update;
					if ('editable' in result && typeof result.editable !== 'boolean') throw new TypeError('Custom editor editable policy must be boolean');
					const editable = 'editable' in result ? result.editable as boolean : undefined;
					// Readonly policy belongs to the editor model owner, including after configuration changes.
					return 'update' in result ? { html, editable, update: update && typeof update === 'object' && !Array.isArray(update) ? { ...update, readOnly: document.readOnly } : update } : { html, editable };
				},
				onDidChange: this.packages.onDidChange ?? Event.None,
			} satisfies CustomTextEditorProvider, options.onSave),
		});
	}
}

async function readWebviewResource(value: JsonValue | undefined, resources: Map<string, string>, signal: AbortSignal): Promise<string> {
	if (typeof value !== 'string' || !URL.canParse(value) || new URL(value).protocol !== 'blob:') {
		throw new TypeError('Custom editor resource must belong to its browser Worker');
	}
	signal.throwIfAborted();
	const cached = resources.get(value);
	if (cached !== undefined) return cached;
	const response = await fetch(value, { signal });
	if (!response.ok) throw new Error('Cannot load custom editor resource');
	const content = await response.text();
	if (content.length > 16 * 1024 * 1024) throw new RangeError('Custom editor resource is too large');
	resources.set(value, content);
	return content;
}
