import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IRendererHostService, type IRendererHost } from '../../renderer/common/rendererHost.js';
import {
	AMBIENT_AGENT_HOST_AUTHORITY,
	agentHostConnectionAddress,
	type IAgentHostConnectionInfo,
	type IAgentHostConnectionsService,
} from '../common/agentHostConnectionsService.js';
import type { AppServerConnectionState } from '../common/appServerApi.js';

/** Projects one selected window host and its runtime endpoint registry without owning another connection table. */
export class AgentHostConnectionsService extends Disposable implements IAgentHostConnectionsService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeConnections = this.changed.event;
	private ambientState: AppServerConnectionState = 'starting';
	private ambientRevision = 0;

	constructor(@IRendererHostService private readonly renderer: IRendererHost) {
		super();
		const subscription = renderer.appServer.onConnectionState(state => {
			this.ambientRevision++;
			this.ambientState = state;
			this.changed.fire();
		});
		this._register(toDisposable(() => subscription.dispose()));
		if (renderer.agentHosts) this._register(renderer.agentHosts.onDidChangeConnections(() => this.changed.fire()));
		const revision = this.ambientRevision;
		void renderer.appServer.getConnectionState().then(
			state => {
				if (this.isDisposed || revision !== this.ambientRevision) return;
				this.ambientState = state;
				this.changed.fire();
			},
			() => {
				if (this.isDisposed || revision !== this.ambientRevision) return;
				this.ambientState = 'crashed';
				this.changed.fire();
			},
		);
	}

	get connections(): readonly IAgentHostConnectionInfo[] {
		return [
			{
				id: AMBIENT_AGENT_HOST_AUTHORITY,
				authority: AMBIENT_AGENT_HOST_AUTHORITY,
				address: undefined,
				name: localize({ bundle: 'ash.workbench', key: 'agentHosts.currentWindow' }, 'Current Window'),
				isAmbient: true,
				state: this.ambientState,
				connection: this.renderer,
				remoteConnection: undefined,
			},
			...(this.renderer.agentHosts?.connections ?? []).map(entry => {
				const address = agentHostConnectionAddress(entry.connection);
				return {
					id: entry.id,
					authority: address,
					address,
					name: entry.connection.name,
					isAmbient: false,
					state: entry.state,
					connection: entry.host?.api,
					remoteConnection: entry.connection,
				};
			}),
		];
	}
}
