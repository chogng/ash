import { Emitter } from '../../../base/common/event.js';
import { extUri } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IRemoteAgentHostService } from '../common/remoteAgentHostService.js';
import { AMBIENT_AGENT_HOST_AUTHORITY, agentHostConnectionAddress, type IAgentHostConnectionInfo, type IAgentHostConnectionsService } from '../common/agentHostConnectionsService.js';
import type { AppServerConnectionState } from '../common/appServerApi.js';
import { IAgentConnection } from '../common/agentService.js';
import { remoteAgentHostRoot } from '../common/remoteAgentHostService.js';

/** Projects one selected window host and its runtime endpoint registry without owning another connection table. */
export class AgentHostConnectionsService extends Disposable implements IAgentHostConnectionsService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeConnections = this.changed.event;
	private ambientState: AppServerConnectionState = 'starting';
	private ambientRevision = 0;

	constructor(
		@IAgentConnection private readonly renderer: IAgentConnection,
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
	) {
		super();
		const subscription = renderer.appServer.onConnectionState(state => {
			this.ambientRevision++;
			this.ambientState = state;
			this.changed.fire();
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(remoteHosts.onDidChangeConnections(() => this.changed.fire()));
		const revision = this.ambientRevision;
		void renderer.appServer.getConnectionState().then(state => {
			if (this.isDisposed || revision !== this.ambientRevision) return;
			this.ambientState = state;
			this.changed.fire();
		}, () => {
			if (this.isDisposed || revision !== this.ambientRevision) return;
			this.ambientState = 'crashed';
			this.changed.fire();
		});
	}

	public get ambientConnection(): IAgentConnection { return this.renderer; }

	public resolveConnection(resource: URI): IAgentHostConnectionInfo | undefined {
		const candidates = this.connections.flatMap(info => {
			if (!info.remoteConnection) { return []; }
			// Keep a connecting or recovering endpoint in the lookup so callers cannot
			// fall through to a different host while its domain ports are unavailable.
			const root = info.directory?.uri ?? remoteAgentHostRoot(info.remoteConnection, info.id);
			return root.scheme === resource.scheme && root.authority === resource.authority ? [{ info, root }] : [];
		});
		const containing = candidates.filter(candidate => extUri.isEqualOrParent(resource, candidate.root));
		const matches = containing.length ? containing : candidates;
		if (!matches.length) { return undefined; }
		const depth = Math.max(...matches.map(candidate => candidate.root.path.length));
		const owners = containing.length ? matches.filter(candidate => candidate.root.path.length === depth) : matches;
		if (owners.length !== 1) { throw new Error('Ambiguous Agent host resource identity'); }
		return owners[0]!.info;
	}

	get connections(): readonly IAgentHostConnectionInfo[] {
		return [{
			id: AMBIENT_AGENT_HOST_AUTHORITY, authority: AMBIENT_AGENT_HOST_AUTHORITY, address: undefined,
			name: localize({ bundle: 'ash.workbench', key: 'agentHosts.currentWindow' }, 'Current Window'),
			isAmbient: true, state: this.ambientState, connection: this.renderer, remoteConnection: undefined, directory: undefined,
		}, ...(this.remoteHosts.connections).map(entry => {
			const address = agentHostConnectionAddress(entry.connection);
			return { id: entry.id, authority: address, address, name: entry.connection.name, isAmbient: false, state: entry.state, connection: entry.host?.api, remoteConnection: entry.connection, directory: entry.host?.directory };
		})];
	}

}
