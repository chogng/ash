import type { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import type { ISessionProviderScope } from './sessionProviderScopeService.js';

/** A conversation borrows one host's Prompt catalog and only sends backend Session IDs. */
export class SessionScopedPromptsService implements IPromptsService {
	readonly onDidChangeSkills;
	readonly onDidChangeHooks;
	constructor(private readonly scope: ISessionProviderScope) {
		this.onDidChangeSkills = scope.services.prompts.onDidChangeSkills;
		this.onDidChangeHooks = scope.services.prompts.onDidChangeHooks;
	}
	getHooks(...[token, sessionId]: Parameters<IPromptsService['getHooks']>): ReturnType<IPromptsService['getHooks']> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.getHooks(token, sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
	}
	findAgentSkills(...[token, sessionId]: Parameters<IPromptsService['findAgentSkills']>): ReturnType<IPromptsService['findAgentSkills']> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.findAgentSkills(token, sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
	}
	readSkillManagement(...[sessionId]: Parameters<IPromptsService['readSkillManagement']>): ReturnType<IPromptsService['readSkillManagement']> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.readSkillManagement(sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
	}
	setSkillEnablement(...[skillId, enabled, revision, sessionId]: Parameters<IPromptsService['setSkillEnablement']>): ReturnType<IPromptsService['setSkillEnablement']> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.setSkillEnablement(skillId, enabled, revision, sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
	}
	parseNew(...args: Parameters<IPromptsService['parseNew']>): ReturnType<IPromptsService['parseNew']> {
		this.scope.assertCurrent(); return this.scope.services.prompts.parseNew(...args);
	}
	dispose(): void { }
	[Symbol.dispose](): void { this.dispose(); }
}
