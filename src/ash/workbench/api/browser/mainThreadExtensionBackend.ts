import { IProgressService, ProgressLocation, type IProgressOptions } from '../../../platform/progress/common/progress.js';
import { AppServerRemoteError } from '../../../platform/agentHost/common/appServerError.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { IExtensionBackendApi } from '../../../platform/agentHost/common/extensionBackendApi.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionClientSource, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { Emitter } from '../../../base/common/event.js';
import { raceCancellationError, RunOnceScheduler } from '../../../base/common/async.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IEditorPart } from '../../browser/parts/editor/editorPart.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../editor/browser/editorBrowser.js';
import { dirname } from '../../../base/common/resources.js';

/** Routes package-declared capabilities without exposing the client's backend connection. */
export class MainThreadExtensionBackend extends Disposable {
	private readonly changed = this._register(new Emitter<string | undefined>());
	private readonly stopped = new AbortController();
	private sequence = 0;
	private resetAfter = 0;
	private editorChangedAfter = 0;
	private editorFoldersChangedAfter = 0;
	private discardedThrough = 0;
	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
	private readonly events: { sequence: number; event: JsonValue; method: string }[] = [];
	constructor(
		@IExtensionApi
		private readonly extensions: IExtensionApi,
		@IExtensionBackendApi
		private readonly backend: IExtensionBackendApi,
		@IAppServerApi
		private readonly connection: IAppServerApi,
		@IServerEventApi
		events: IServerEventApi,
		@IWorkspaceContextService
		private readonly workspace: IWorkspaceContextService,
		@IConfigurationService configuration: IConfigurationService,
		@IProgressService private readonly progress: IProgressService,
		@IEditorPart private readonly editors: IEditorPart,
		@ICodeEditorService codeEditors: ICodeEditorService,
	) {
		super();
		const listener = events.subscribe(event => {
			this.events.push({
				sequence: ++this.sequence,
				event: normalizeExtensionHostPayload(event),
				method: event.method,
			});
			if (this.events.length > 256) {
				this.discardedThrough = this.events.shift()!.sequence;
			}
			this.changed.fire(event.method);
		});
		this._register(toDisposable(() => listener.dispose()));
		const invalidateDiscovery = () => {
			this.resetAfter = ++this.sequence;
			this.changed.fire(undefined);
		};
		const connectionChanged = connection.onConnectionState(invalidateDiscovery);
		this._register(toDisposable(() => connectionChanged.dispose()));
		this._register(workspace.onDidChangeWorkspace(invalidateDiscovery));
		this._register(configuration.onDidChangeConfiguration(invalidateDiscovery));
		// Cursor and text changes wake blame without invalidating repository discovery.
		// Coalesce typing/selection bursts; never serialize a document merely to signal it.
		const editorChanged = this._register(
			new RunOnceScheduler(() => {
				this.editorChangedAfter = ++this.sequence;
				this.changed.fire(undefined);
			}, 75),
		);
		const editorFolders = () => new Set(editors.groups.flatMap(group => group.inputs.map(input => dirname(input.resource).with({ query: '', fragment: '' }).toString())));
		let previousFolders = editorFolders();
		this._register(
			editors.onDidChangeEditors(event => {
				if (event.kind === 'groupChanged' && event.event.kind === 'editorStateChanged') return;
				const folders = editorFolders();
				// Separate editor discovery inputs from workspace/configuration resets.
				// Providers can skip discovery for files inside repositories they already own.
				if (folders.size !== previousFolders.size || [...folders].some(folder => !previousFolders.has(folder))) {
					previousFolders = folders;
					this.editorFoldersChangedAfter = ++this.sequence;
					this.changed.fire(undefined);
				} else {
					editorChanged.schedule();
				}
			}),
		);
		const trackEditor = (editor: ICodeEditor) => {
			const listeners = new DisposableStore();
			this.editorListeners.set(editor, listeners);
			const changed = () => {
				if (editor.getModel()?.uri.toString() === this.editors.activeGroup?.activeInput?.resource.toString()) editorChanged.schedule();
			};
			listeners.add(editor.onDidChangeCursorPosition(changed));
			listeners.add(editor.onDidChangeModelContent(changed));
			listeners.add(editor.onDidChangeModel(changed));
		};
		for (const editor of codeEditors.listCodeEditors()) trackEditor(editor);
		this._register(codeEditors.onCodeEditorAdd(trackEditor));
		this._register(codeEditors.onCodeEditorRemove(editor => this.editorListeners.deleteAndDispose(editor)));
		this._register(toDisposable(() => this.stopped.abort()));
	}
	public async handle(
		source: ExtensionClientSource,
		capability: string,
		method: string | undefined,
		params: JsonValue,
		after: number,
		signal: AbortSignal,
		progressOptions?: Pick<IProgressOptions, 'title' | 'cancellable'>,
		waitForChange = false,
	): Promise<JsonValue> {
		const catalog = await this.extensions.list('cached');
		signal.throwIfAborted();
		const descriptor = catalog.extensions.find(extension => extension.id === source.extensionId);
		// These routes are product grants. An installed package cannot grant itself protocol access.
		if (!descriptor || descriptor.sourceKind !== 'builtIn') {
			throw new Error('Extension backend capability is not authorized');
		}
		const manifest = JSON.parse(descriptor.manifestJson);
		const grant = manifest.ashFrontend?.capabilities?.[capability];
		if (!grant || typeof grant !== 'object') {
			throw new Error('Extension backend capability is not declared');
		}
		if (method === undefined) {
			if (waitForChange) await this.waitForStateChange(after, grant.notifications ?? [], signal);
			const state = await this.connection.getConnectionState();
			signal.throwIfAborted();
			return normalizeExtensionHostPayload({
				sequence: this.sequence,
				connection: state,
				generation: this.connection.connectionGeneration,
				reset: after < this.resetAfter || after < this.discardedThrough,
				editorFoldersChanged: after < this.editorFoldersChangedAfter,
				events: this.events.filter(entry => entry.sequence > after && grant.notifications?.includes(entry.method)).map(entry => entry.event),
				folders: this.workspace.getWorkspace().folders.map(folder => ({ id: folder.id, name: folder.name, uri: folder.uri.toString() })),
			});
		}
		const route = grant.methods?.[method];
		if (!route || typeof route.route !== 'string') {
			throw new Error('Extension backend method is not authorized');
		}
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			throw new TypeError('Extension backend parameters must be an object');
		}
		if (Array.isArray(route.fields) && Object.keys(params).some(key => !route.fields.includes(key))) {
			throw new TypeError('Extension backend parameters exceed their capability');
		}
		const operationId = (params as Record<string, JsonValue>).operationId;
		const cancellable = typeof route.cancellationRoute === 'string' && typeof operationId === 'string';
		if (progressOptions && (typeof progressOptions.title !== 'string' || progressOptions.title.length > 2048 || (progressOptions.cancellable && !cancellable)))
			throw new TypeError('Invalid backend progress contract');
		let cancellation: Promise<unknown> | undefined;
		const cancel = (): void => {
			if (!cancellable || cancellation) return;
			// Cancellation retains the original operation until its terminal response. Only
			// this admitted operation ID is sent; retirement cannot launch another mutation.
			cancellation = this.backend.request(route.cancellationRoute, { operationId }, AbortSignal.timeout(5000));
			void cancellation.catch(() => undefined);
		};
		const execute = async (): Promise<JsonValue> => {
			signal.addEventListener('abort', cancel, { once: true });
			let result: JsonValue;
			try {
				signal.throwIfAborted();
				result = await this.backend.request(route.route, params, cancellable ? new AbortController().signal : signal);
				signal.throwIfAborted();
			} catch (error) {
				signal.throwIfAborted();
				return {
					backendError: {
						name: error instanceof AppServerRemoteError ? error.errorName : 'Unavailable',
						message: error instanceof Error ? error.message : String(error),
					},
				};
			} finally {
				signal.removeEventListener('abort', cancel);
				await cancellation?.catch(() => undefined);
			}
			if (!Array.isArray(route.resultFields)) {
				return result;
			}
			if (!result || typeof result !== 'object' || Array.isArray(result)) {
				throw new TypeError('Extension backend result must be an object');
			}
			return Object.fromEntries(route.resultFields.map((field: string) => [field, (result as Record<string, JsonValue>)[field] ?? null]));
		};
		return progressOptions
			? this.progress.withProgress(
					{
						location: ProgressLocation.Notification,
						title: progressOptions.title,
						cancellable: progressOptions.cancellable,
					},
					execute,
					cancel,
				)
			: execute();
	}

	private async waitForStateChange(after: number, notifications: readonly string[], signal: AbortSignal): Promise<void> {
		let finish!: () => void;
		const waiting = new Promise<void>(resolve => {
			finish = resolve;
		});
		const listener = this.changed.event(method => {
			if (method === undefined || notifications.includes(method)) finish();
		});
		// Renew before the SDK's 30-second request deadline. Actual backend and editor
		// changes wake immediately; idle windows no longer run a discovery/blame tick.
		const timer = setTimeout(finish, 20_000);
		try {
			// Subscribe before checking the retained history so no notification can
			// fall between the caller's last sequence and the start of its wait.
			if (
				after < this.resetAfter ||
				after < this.editorChangedAfter ||
				after < this.editorFoldersChangedAfter ||
				after < this.discardedThrough ||
				this.events.some(entry => entry.sequence > after && notifications.includes(entry.method))
			)
				return;
			await raceCancellationError(waiting, AbortSignal.any([signal, this.stopped.signal]));
		} finally {
			clearTimeout(timer);
			listener.dispose();
		}
	}
}
