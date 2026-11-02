import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { isRecord } from '../../../../base/common/types.js';
import { IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from '../../../../platform/extensions/common/extensionHostApi.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentHostCanvasCollection } from '../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import type { ICanvasOwner } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { MainThreadCanvases } from '../../../../workbench/api/browser/mainThreadCanvases.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { parseSessionIdentity, sessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { remoteAgentHostProviderId } from '../../providers/remoteAgentHost/browser/remoteAgentHostSessionsProvider.js';
import { getNLSLanguage } from '../../../../nls.js';

/** Borrows each connection's runtime; native presentation and membership stay window-owned. */
export class RemoteCanvasHostContribution extends Disposable {
	private readonly scopes = this._register(new DisposableMap<string, RemoteCanvasHost>());
	constructor(@IAgentHostConnectionsService hosts: IAgentHostConnectionsService, @IInstantiationService instantiation: IInstantiationService) {
		super();
		const update = () => {
			const admitted = hosts.connections.filter(info => !info.isAmbient && info.connection?.browserHost && info.remoteConnection && info.directory);
			const desired = new Set(admitted.map(info => info.id));
			for (const id of this.scopes.keys()) { if (!desired.has(id)) { this.scopes.deleteAndDispose(id); } }
			for (const info of admitted) { if (!this.scopes.has(info.id)) { this.scopes.set(info.id, instantiation.createInstance(RemoteCanvasHost, info)); } }
		};
		this._register(hosts.onDidChangeConnections(update));
		update();
	}
}

class RemoteCanvasHost extends Disposable {
	private revision = 0;
	private snapshot: ExtensionHostFleetSnapshot | undefined;
	private activation: Promise<void> | undefined;
	private startup: Promise<void> | undefined;
	private readonly binding: MainThreadCanvases;
	constructor(info: IAgentHostConnectionInfo,
		@IInstantiationService instantiation: IInstantiationService,
		@IAgentHostCanvasCollection collection: IAgentHostCanvasCollection,
		@IPlaywrightService playwright: IPlaywrightService,
		@IConfigurationService configuration: IConfigurationService,
		@IBrowserViewWorkbenchService browsers: IBrowserViewWorkbenchService,
		@ILogService log: ILogService,
	) {
		super();
		const api = info.connection!;
		const providerId = remoteAgentHostProviderId(info);
		const frontend = (id: string) => sessionIdentity(providerId, id, 'local-agent-host');
		const backend = (id: string) => parseSessionIdentity(id, 'local-agent-host').backendSessionId;
		const scope = this._register(instantiation.createChild());
		scope.registerInstance(IExtensionHostApi, api.extensionHost);
		this.binding = this._register(scope.createInstance(MainThreadCanvases, {
			timeout: 30_000, providerId,
			backendOwner: (owner: ICanvasOwner) => ({ sessionId: backend(owner.session.path.slice(1)), threadId: backend(owner.chat.path.slice(1)) })
		}));
		const initialization = () => ({
			language: getNLSLanguage(), workspaceFolders: [{ uri: info.directory!.uri.toString(), name: info.name, index: 0 }], workspaceName: info.name,
			workspaceFile: null, configurationValues: configuration.getValue<Readonly<Record<string, unknown>>>() ?? {}, configurationData: configuration.getConfigurationData()
		});
		const clientHandler = api.extensionHost.registerClientHandler(async (operation, signal, source) => {
			signal.throwIfAborted();
			if (!isRecord(operation)) { throw new TypeError('Invalid remote Canvas callback'); }
			if (operation.operation === 'readInitialization') { return { result: 'initialization', initialization: initialization() }; }
			if (operation.operation === 'editorOperation' && isRecord(operation.payload) && operation.payload.method === 'canvasChanged') {
				await this.binding.handleChange(operation.payload, source);
				return { result: 'value', value: null };
			}
			throw new Error('Remote Canvas callback is unavailable');
		});
		this._register(toDisposable(() => clientHandler.dispose()));
		const accept = (snapshot: ExtensionHostFleetSnapshot, revision: number) => {
			if (this.isDisposed || revision !== this.revision || this.snapshot && snapshot.generation < this.snapshot.generation) { return; }
			this.snapshot = snapshot; this.binding.update(snapshot);
		};
		const refresh = async () => {
			const revision = this.revision;
			const startup = this.startup;
			if (!startup) { return; }
			await startup;
			if (this.isDisposed || revision !== this.revision) { return; }
			if (await api.extensionHost.isAvailable()) { accept(await api.extensionHost.list(), revision); }
		};
		const activate = (): Promise<void> => {
			if (this.activation) { return this.activation; }
			const pending = this.activation = (async () => {
				const revision = this.revision;
				if (!await api.extensionHost.isAvailable()) { throw new Error('CanvasProviderUnavailable'); }
				// The runtime is forked once per connection generation; catalog refreshes borrow that fleet.
				await (this.startup ??= api.extensionHost.start({}).then(snapshot => accept(snapshot, revision)));
				if (this.isDisposed || revision !== this.revision) { return; }
				let snapshot = await api.extensionHost.list();
				for (const extension of snapshot.extensions) {
					if (extension.lifecycle !== 'dormant' || !extension.activation?.events.includes('onDemand:dataChannel')) { continue; }
					if (this.isDisposed || revision !== this.revision) { return; }
					snapshot = await api.extensionHost.activateByEvent({
						extensionId: extension.id, activationGeneration: extension.activationGeneration,
						event: { type: 'capability', capability: 'dataChannel' }, initialization: initialization()
					});
				}
				accept(snapshot, revision);
			})().finally(() => { if (this.activation === pending) { this.activation = undefined; } });
			return pending;
		};
		this._register(collection.registerHost(providerId, activate, owner => browsers.resolveNetwork({ type: 'agent', sessionId: owner.chat.path.slice(1) })));
		this._register(api.browserHost!.register(playwright, configuration, {
			listCanvases: (sessionId, threadId, signal) => collection.listCanvases(frontend(sessionId), frontend(threadId), signal, providerId),
			openCanvasSource: (request, signal) => collection.openCanvasSource({ ...request, sessionId: frontend(request.sessionId), threadId: frontend(request.threadId) }, signal, providerId),
			closeCanvasSource: (threadId, targetId, signal) => collection.closeCanvasSource(frontend(threadId), targetId, signal, providerId),
			acceptCanvasOpen: (request, state, source) => collection.acceptCanvasOpen({ ...request, sessionId: frontend(request.sessionId), threadId: frontend(request.threadId) }, state, source, providerId),
		}, {
			providerId, toFrontendIdentity: frontend, toBackendIdentity: id => {
				const parsed = parseSessionIdentity(id, 'local-agent-host');
				return parsed.providerId === providerId ? parsed.backendSessionId : undefined;
			}
		}, owner => browsers.resolveNetwork(owner)));
		const report = (error: unknown) => { if (!this.isDisposed && !isCancellationError(error)) { log.error('canvas', 'Remote Canvas host failed', error); } };
		const changed = api.extensionHost.onDidChange(() => { void refresh().catch(report); });
		this._register(toDisposable(() => changed.dispose()));
		const connection = api.extensionHost.onConnectionState(state => {
			this.revision++; this.snapshot = undefined; this.activation = undefined; this.startup = undefined;
			this.binding.clear();
			if (state === 'ready') { void activate().catch(report); }
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => { this.revision++; this.binding.clear(); }));
		void activate().catch(report);
	}
}
