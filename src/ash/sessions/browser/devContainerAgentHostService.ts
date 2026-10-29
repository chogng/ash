import { CancellationToken } from '../../base/common/cancellation.js';
import { canceled } from '../../base/common/errors.js';
import { IAgentSessionService } from '../../platform/agentHost/common/agentService.js';
import { type SessionRuntimeRequest, type SessionRuntimeResult } from '../../platform/agentHost/common/agent.js';
import { localize } from '../../nls.js';
import { IDevContainerAgentHostService } from '../common/devContainerAgentHostService.js';
import type { SessionExecutionTarget } from '../services/sessions/common/session.js';

export class DevContainerAgentHostService implements IDevContainerAgentHostService {
	declare readonly _serviceBrand: undefined;
	constructor(@IAgentSessionService private readonly sessions: IAgentSessionService) { }
	private async invoke(request: SessionRuntimeRequest, token: CancellationToken): Promise<SessionRuntimeResult> {
		if (token.isCancellationRequested) { throw canceled(); }
		if (!this.sessions.invokeRuntime) { throw new Error(localize('sessions.devContainer.unavailable', 'The Dev Container Provider is unavailable.')); }
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const result = await this.sessions.invokeRuntime('ash.dev-containers', request, controller.signal);
			if (token.isCancellationRequested) { throw canceled(); }
			return result;
		} catch (error) {
			if (token.isCancellationRequested) { throw canceled(); }
			throw error;
		}
	}
	async getTargets(token: CancellationToken): Promise<readonly SessionExecutionTarget[]> {
		const result = await this.invoke({ operation: 'list' }, token);
		return result.type === 'targets' ? result.targets.filter(target => target.type === 'provider' && target.providerId === 'ash.dev-containers') : [];
	}
	async isAvailable(workspace: string, token: CancellationToken): Promise<boolean> {
		const result = await this.invoke({ workspace, operation: 'probe' }, token);
		return result.type === 'availability' && result.available;
	}
	async connect(workspace: string, token: CancellationToken): Promise<SessionExecutionTarget> {
		const result = await this.invoke({ workspace, operation: 'prepare' }, token);
		if (result.type !== 'target' || result.target.type !== 'provider' || result.target.providerId !== 'ash.dev-containers') {
			throw new Error(localize('sessions.devContainer.invalidTarget', 'The Dev Container Provider returned an invalid execution target.'));
		}
		return result.target;
	}
	async stopContainer(workspace: string, token: CancellationToken): Promise<void> { await this.invoke({ workspace, operation: 'stop' }, token); }
	async removeContainer(workspace: string, token: CancellationToken): Promise<void> { await this.invoke({ workspace, operation: 'remove' }, token); }
}
