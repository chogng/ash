import type { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';
import { SessionScopedPromptsService } from './sessionScopedPromptsService.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';

/** Commands without an explicit Session follow the selected conversation's host. */
export class SessionsPromptsService extends Disposable implements IPromptsService {
	private readonly listeners = this._register(new DisposableStore());
	private readonly skillsChanged = this._register(new Emitter<void>());
	readonly onDidChangeSkills = this.skillsChanged.event;
	private readonly hooksChanged = this._register(new Emitter<void>());
	readonly onDidChangeHooks = this.hooksChanged.event;
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {
		super();
		this._register(scopes.onDidChange(() => { this.skillsChanged.fire(); this.hooksChanged.fire(); }));
		this._register(scopes.onDidChangeScopes(() => this.bind()));
		this.bind();
	}
	private bind(): void {
		this.listeners.clear();
		for (const scope of this.scopes.getScopes()) {
			this.listeners.add(scope.services.prompts.onDidChangeSkills(() => this.skillsChanged.fire()));
			this.listeners.add(scope.services.prompts.onDidChangeHooks(() => this.hooksChanged.fire()));
		}
	}
	getHooks(...args: Parameters<IPromptsService['getHooks']>): ReturnType<IPromptsService['getHooks']> { return new SessionScopedPromptsService(this.scopes.getScope(args[1])).getHooks(...args); }
	findAgentSkills(...args: Parameters<IPromptsService['findAgentSkills']>): ReturnType<IPromptsService['findAgentSkills']> { return new SessionScopedPromptsService(this.scopes.getScope(args[1])).findAgentSkills(...args); }
	readSkillManagement(...args: Parameters<IPromptsService['readSkillManagement']>): ReturnType<IPromptsService['readSkillManagement']> { return new SessionScopedPromptsService(this.scopes.getScope(args[0])).readSkillManagement(...args); }
	setSkillEnablement(...args: Parameters<IPromptsService['setSkillEnablement']>): ReturnType<IPromptsService['setSkillEnablement']> { return new SessionScopedPromptsService(this.scopes.getScope(args[3])).setSkillEnablement(...args); }
	registerSkillSource(rootReference: string): Promise<void> { return new SessionScopedPromptsService(this.scopes.getScope()).registerSkillSource(rootReference); }
	parseNew(...args: Parameters<IPromptsService['parseNew']>): ReturnType<IPromptsService['parseNew']> { return new SessionScopedPromptsService(this.scopes.getScope()).parseNew(...args); }
}
