import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { canceled } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { type SessionRuntimeRequest, type SessionRuntimeResult } from '../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../nls.js';
import { IDevContainerAgentHostService } from '../../../../common/devContainerAgentHostService.js';
import type { SessionExecutionTarget } from '../../../../services/sessions/common/session.js';

export class DevContainerAgentHostService extends Disposable implements IDevContainerAgentHostService {
	declare readonly _serviceBrand: undefined;
	private readonly preparations = new Map<string, {
		readonly promise: Promise<SessionExecutionTarget>;
		readonly cancellation: CancellationTokenSource;
		waiters: number;
		settled: boolean;
	}>();

	constructor(@IAgentSessionService private readonly sessions: IAgentSessionService) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.preparations.values()) entry.cancellation.dispose(true);
			this.preparations.clear();
		}));
	}
	private async invoke(request: SessionRuntimeRequest, token: CancellationToken): Promise<SessionRuntimeResult> {
		if (this.isDisposed || token.isCancellationRequested) { throw canceled(); }
		if (!this.sessions.invokeRuntime) { throw new Error(localize('sessions.devContainer.unavailable', 'The Dev Container Provider is unavailable.')); }
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const result = await raceCancellationError(this.sessions.invokeRuntime('ash.dev-containers', request, controller.signal), token);
			if (this.isDisposed || token.isCancellationRequested) { throw canceled(); }
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
		if (this.isDisposed || token.isCancellationRequested) throw canceled();
		if (!this.sessions.invokeRuntime) return false;
		const result = await this.invoke({ workspace, operation: 'probe' }, token);
		return result.type === 'availability' && result.available;
	}
	async connect(workspace: string, token: CancellationToken): Promise<SessionExecutionTarget> {
		if (this.isDisposed || token.isCancellationRequested) throw canceled();
		let entry = this.preparations.get(workspace);
		if (!entry) {
			const cancellation = new CancellationTokenSource();
			const promise = this.prepare(workspace, cancellation.token);
			entry = { promise, cancellation, waiters: 0, settled: false };
			this.preparations.set(workspace, entry);
			const owned = entry;
			const finish = (): void => {
				owned.settled = true;
				cancellation.dispose();
				if (this.preparations.get(workspace) === owned) this.preparations.delete(workspace);
			};
			void promise.then(finish, finish);
		}
		entry.waiters++;
		try {
			const target = await raceCancellationError(entry.promise, token);
			if (this.isDisposed || token.isCancellationRequested) throw canceled();
			return target;
		} finally {
			entry.waiters--;
			if (!entry.settled && entry.waiters === 0) {
				// Cancellation belongs to the shared operation only after its final caller leaves.
				if (this.preparations.get(workspace) === entry) this.preparations.delete(workspace);
				entry.cancellation.cancel();
			}
		}
	}

	private async prepare(workspace: string, token: CancellationToken): Promise<SessionExecutionTarget> {
		const result = await this.invoke({ workspace, operation: 'prepare' }, token);
		if (result.type !== 'target' || result.target.type !== 'provider' || result.target.providerId !== 'ash.dev-containers') {
			throw new Error(localize('sessions.devContainer.invalidTarget', 'The Dev Container Provider returned an invalid execution target.'));
		}
		return result.target;
	}
	async stopContainer(workspace: string, token: CancellationToken): Promise<void> { await this.invoke({ workspace, operation: 'stop' }, token); }
	async removeContainer(workspace: string, token: CancellationToken): Promise<void> { await this.invoke({ workspace, operation: 'remove' }, token); }
}
