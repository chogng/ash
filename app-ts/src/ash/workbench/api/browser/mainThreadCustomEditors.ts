import { match } from '../../../base/common/glob.js';
import { basename } from '../../../base/common/resources.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostCustomEditorRegistration, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { EditorPanes } from '../../browser/editor.js';
import { EditorPaneMatch } from '../../browser/parts/editor/editorPane.js';
import { WebviewEditor, type CustomTextEditorProvider } from '../../contrib/webviewPanel/browser/webviewEditor.js';
import '../../contrib/customEditor/browser/customEditorInputFactory.js';
import { CustomEditorInput } from '../../contrib/customEditor/browser/customEditorInput.js';

/** Connects one activated extension provider to the existing editor pane registry. */
export class MainThreadCustomEditors extends Disposable {
	private readonly providers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly identities = new Map<string, string>();
	constructor(
		private readonly timeout: number,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
	) {
		super();
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const viewTypes = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready') {
				continue;
			}
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'customTextEditor') {
					continue;
				}
				if (viewTypes.has(registration.viewType)) {
					throw new TypeError(`Duplicate custom editor '${registration.viewType}'`);
				}
				viewTypes.add(registration.viewType);
			}
		}
		const active = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) {
				continue;
			}
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'customTextEditor') {
					continue;
				}
				const key = JSON.stringify([runtime.id, runtime.activationGeneration, runtime.incarnation, registration.registrationId]);
				active.add(registration.viewType);
				if (this.identities.get(registration.viewType) === key) {
					continue;
				}
				// Release a retired provider before registering its replacement's view type.
				this.providers.deleteAndDispose(registration.viewType);
				const lifetime = new DisposableStore();
				this.providers.set(registration.viewType, lifetime);
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				lifetime.add(this.registerCustomTextEditorProvider(registration, async (operation, payload, signal) => {
					controller.signal.throwIfAborted();
					return this.api.invoke({
						extensionId: runtime.id,
						registrationId: registration.registrationId,
						activationGeneration: runtime.activationGeneration,
						incarnation: runtime.incarnation!,
						operation,
						payload,
						deadlineUnixMillis: Date.now() + this.timeout,
					}, AbortSignal.any([controller.signal, signal]));
				}));
				this.identities.set(registration.viewType, key);
			}
		}
		for (const key of this.providers.keys()) {
			if (!active.has(key)) {
				this.providers.deleteAndDispose(key);
				this.identities.delete(key);
			}
		}
	}

	public clear(): void {
		this.providers.clearAndDisposeAll();
		this.identities.clear();
	}

	public registerCustomTextEditorProvider(
		registration: ExtensionHostCustomEditorRegistration,
		invoke: (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>): IDisposable {
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
					const result = await invoke('resolveCustomTextEditor', { document }, signal);
					if (typeof result !== 'object' || result === null || Array.isArray(result) || !('html' in result) || typeof result.html !== 'string') {
						throw new TypeError('Custom editor provider must return HTML');
					}
					return result.html;
				},
			} satisfies CustomTextEditorProvider, options.onSave),
		});
	}
}
