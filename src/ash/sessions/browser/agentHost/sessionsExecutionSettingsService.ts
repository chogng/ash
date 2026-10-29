import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import type { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';

/** Backend defaults belong to the host selected by the conversation, independently of directory trust. */
export class SessionsExecutionSettingsService extends Disposable implements IAgentExecutionSettingsService {
	private readonly listeners = this._register(new DisposableStore());
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {
		super();
		this._register(scopes.onDidChange(() => this.changed.fire()));
		this._register(scopes.onDidChangeScopes(() => this.bind()));
		this.bind();
	}
	private bind(): void {
		this.listeners.clear();
		for (const scope of this.scopes.getScopes())
			this.listeners.add(scope.services.execution.onDidChange(() => this.changed.fire()));
	}
	read(): ReturnType<IAgentExecutionSettingsService['read']> {
		const scope = this.scopes.getScope();
		scope.assertCurrent();
		return scope.services.execution.read();
	}
	configure(...args: Parameters<IAgentExecutionSettingsService['configure']>): Promise<void> {
		const scope = this.scopes.getScope();
		scope.assertCurrent();
		return scope.services.execution.configure(...args);
	}
}
