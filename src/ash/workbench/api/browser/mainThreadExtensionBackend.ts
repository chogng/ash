import { IProgressService, type ProgressOptions } from '../../../platform/progress/common/progress.js';
import { AppServerRemoteError } from '../../../platform/agentHost/common/appServerError.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { IExtensionBackendApi } from '../../../platform/agentHost/common/extensionBackendApi.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionClientSource, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
/** Routes package-declared capabilities without exposing the client's backend connection. */
export class MainThreadExtensionBackend extends Disposable {
	private sequence = 0;
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
		@IProgressService private readonly progress?: IProgressService) {
		super();
		const listener = events.subscribe(event => {
			this.events.push({ sequence: ++this.sequence, event: normalizeExtensionHostPayload(event), method: event.method });
			if (this.events.length > 256) {
				this.events.shift();
			}
		});
		this._register(toDisposable(() => listener.dispose()));
	}
	public async handle(source: ExtensionClientSource, capability: string, method: string | undefined, params: JsonValue, after: number, signal: AbortSignal, progressOptions?: ProgressOptions): Promise<JsonValue> {
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
			const state = await this.connection.getConnectionState();
			signal.throwIfAborted();
			return normalizeExtensionHostPayload({
				sequence: this.sequence, connection: state, generation: this.connection.connectionGeneration,
				reset: after < (this.events[0]?.sequence ?? this.sequence + 1) - 1,
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
}
