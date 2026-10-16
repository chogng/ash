import { IProgressService, type ProgressOptions } from '../../../platform/progress/common/progress.js';
import { AppServerRemoteError } from '../../../platform/agentHost/common/appServerError.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { IExtensionBackendApi } from '../../../platform/agentHost/common/extensionBackendApi.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionClientSource, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { Emitter } from '../../../base/common/event.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
/** Routes package-declared capabilities without exposing the client's backend connection. */
export class MainThreadExtensionBackend extends Disposable {
	private readonly changed = this._register(new Emitter<string | undefined>());
	private readonly stopped = new AbortController();
	private sequence = 0;
	private resetAfter = 0;
	private readonly events: {
		sequence: number;
		event: JsonValue;
		method: string;
	}[] = [];
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
		@IProgressService private readonly progress?: IProgressService) {
		super();
		const listener = events.subscribe(event => {
			this.events.push({ sequence: ++this.sequence, event: normalizeExtensionHostPayload(event), method: event.method });
			if (this.events.length > 256) {
				this.events.shift();
			}
			this.changed.fire(event.method);
		});
		this._register(toDisposable(() => listener.dispose()));
		const connectionChanged = connection.onConnectionState(() => this.changed.fire(undefined));
		this._register(toDisposable(() => connectionChanged.dispose()));
		this._register(workspace.onDidChangeWorkspace(() => this.changed.fire(undefined)));
		this._register(configuration.onDidChangeConfiguration(() => {
			// Client settings have their own owner and no server notification payload.
			// Invalidate the subscription cursor so consumers reread that owner even
			// while frequent status events keep the subscription from reaching idle.
			this.resetAfter = ++this.sequence;
			this.changed.fire(undefined);
		}));
		this._register(toDisposable(() => this.stopped.abort()));
	}
	public async handle(source: ExtensionClientSource, capability: string, method: string | undefined, params: JsonValue, after: number, signal: AbortSignal, progressOptions?: ProgressOptions, waitForChange = false): Promise<JsonValue> {
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
				sequence: this.sequence, connection: state, generation: this.connection.connectionGeneration,
				reset: after < this.resetAfter || after < (this.events[0]?.sequence ?? this.sequence + 1) - 1,
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
		if (progressOptions && (!this.progress || typeof progressOptions.title !== 'string' || progressOptions.title.length > 2048 || progressOptions.cancellable && !cancellable)) throw new TypeError('Invalid backend progress contract');
		using progress = progressOptions ? this.progress!.startProgress(progressOptions) : undefined;
		let cancellation: Promise<unknown> | undefined;
		const cancel = (): void => {
			if (!cancellable || cancellation) return;
			// Cancellation retains the original operation until its terminal response. Only
			// this admitted operation ID is sent; retirement cannot launch another mutation.
			cancellation = this.backend.request(route.cancellationRoute, { operationId }, AbortSignal.timeout(5000));
			void cancellation.catch(() => undefined);
		};
		signal.addEventListener('abort', cancel, { once: true });
		progress?.signal.addEventListener('abort', cancel, { once: true });
		signal.throwIfAborted();
		let result: JsonValue;
		try {
			result = await this.backend.request(route.route, params, cancellable ? new AbortController().signal : signal);
			signal.throwIfAborted();
		} catch (error) {
			signal.throwIfAborted();
			return { backendError: { name: error instanceof AppServerRemoteError ? error.errorName : 'Unavailable', message: error instanceof Error ? error.message : String(error) } };
		} finally {
			signal.removeEventListener('abort', cancel);
			progress?.signal.removeEventListener('abort', cancel);
			await cancellation?.catch(() => undefined);
		}
		if (!Array.isArray(route.resultFields)) {
			return result;
		}
		if (!result || typeof result !== 'object' || Array.isArray(result)) {
			throw new TypeError('Extension backend result must be an object');
		}
		return Object.fromEntries(route.resultFields.map((field: string) => [field, (result as Record<string, JsonValue>)[field] ?? null]));
	}

	private async waitForStateChange(after: number, notifications: readonly string[], signal: AbortSignal): Promise<void> {
		let finish!: () => void;
		const waiting = new Promise<void>(resolve => { finish = resolve; });
		const listener = this.changed.event(method => { if (method === undefined || notifications.includes(method)) finish(); });
		// Preserve an idle tick for editor-owned facts such as blame's active editor,
		// while repository notifications wake the subscription immediately.
		const timer = setTimeout(finish, 500);
		try {
			// Subscribe before checking the retained history so no notification can
			// fall between the caller's last sequence and the start of its wait.
			if (after < this.resetAfter || after < (this.events[0]?.sequence ?? this.sequence + 1) - 1
				|| this.events.some(entry => entry.sequence > after && notifications.includes(entry.method))) return;
			await raceCancellationError(waiting, AbortSignal.any([signal, this.stopped.signal]));
		} finally {
			clearTimeout(timer);
			listener.dispose();
		}
	}
}
