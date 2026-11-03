import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { localize } from '../../../nls.js';
import { ParsedPromptFile, PromptBody, PromptHeader } from '../../../workbench/contrib/chat/common/promptSyntax/promptFileParser.js';
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
	async findAgentSkills(...[token, sessionId]: Parameters<IPromptsService['findAgentSkills']>): ReturnType<IPromptsService['findAgentSkills']> {
		this.scope.assertCurrent();
		const skills = await this.scope.services.prompts.findAgentSkills(token, sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
		this.scope.assertCurrent();
		return skills.map(skill => ({ ...skill, uri: this.wrapResource(skill.uri), providerId: this.scope.providerId }));
	}
	async resolveSkill(...args: Parameters<IPromptsService['resolveSkill']>): ReturnType<IPromptsService['resolveSkill']> {
		throwIfCancelled(args[1]);
		this.scope.assertCurrent();
		const resource = this.unwrapResource(args[0]);
		if (!resource) return undefined;
		const skill = await this.scope.services.prompts.resolveSkill(resource, args[1]);
		this.scope.assertCurrent();
		return skill && { ...skill, uri: this.wrapResource(skill.uri), providerId: this.scope.providerId };
	}
	async readSkillManagement(...[sessionId]: Parameters<IPromptsService['readSkillManagement']>): ReturnType<IPromptsService['readSkillManagement']> {
		this.scope.assertCurrent();
		const snapshot = await this.scope.services.prompts.readSkillManagement(sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
		this.scope.assertCurrent();
		return { ...snapshot, catalog: { ...snapshot.catalog, skills: snapshot.catalog.skills.map(skill => ({ ...skill, uri: this.wrapResource(skill.uri), providerId: this.scope.providerId })) } };
	}
	setSkillEnablement(...[skillId, enabled, revision, sessionId]: Parameters<IPromptsService['setSkillEnablement']>): ReturnType<IPromptsService['setSkillEnablement']> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.setSkillEnablement(skillId, enabled, revision, sessionId === undefined ? undefined : this.scope.backendIdentity(sessionId));
	}
	registerSkillSource(rootReference: string): Promise<void> {
		this.scope.assertCurrent();
		return this.scope.services.prompts.registerSkillSource(rootReference);
	}
	async parseNew(...args: Parameters<IPromptsService['parseNew']>): ReturnType<IPromptsService['parseNew']> {
		throwIfCancelled(args[1]);
		this.scope.assertCurrent();
		const resource = this.unwrapResource(args[0]);
		if (!resource) throw new ReferenceError(localize('prompt.resource.unavailable', 'This Skill resource is unavailable on its original host. Reopen it from Skills.'));
		const parsed = await this.scope.services.prompts.parseNew(resource, args[1]);
		this.scope.assertCurrent();
		// Rebind syntax coordinates to the public host-qualified address. The body
		// must keep that address when resolving relative package resources.
		return new ParsedPromptFile(args[0], parsed.content,
			parsed.header && new PromptHeader(parsed.header.range, args[0], parsed.header.attributes, parsed.header.errors),
			parsed.body && new PromptBody(parsed.body.range, parsed.content, args[0], parsed.body.offset));
	}

	static getResourceProvider(resource: URI): string | undefined { return this.resourceContext(resource)?.providerId; }

	private wrapResource(resource: URI): URI {
		return resource.with({ query: JSON.stringify({ providerId: this.scope.providerId, resource: resource.toString() }) });
	}

	private unwrapResource(resource: URI): URI | undefined {
		const context = SessionScopedPromptsService.resourceContext(resource);
		if (!context || context.providerId !== this.scope.providerId) return undefined;
		const prefix = `/${context.resource.path.split('/')[1]}/`;
		if (!resource.path.startsWith(prefix)) return undefined;
		return context.resource.with({ path: resource.path, fragment: resource.fragment });
	}

	private static resourceContext(resource: URI): { readonly providerId: string; readonly resource: URI; } | undefined {
		if (resource.scheme !== Schemas.internal || resource.authority !== 'skill' || resource.query.length > 8192) return undefined;
		try {
			const value = JSON.parse(resource.query) as unknown;
			if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
			const context = value as Record<string, unknown>;
			if (Object.keys(context).sort().join(',') !== 'providerId,resource' || typeof context.providerId !== 'string' || !context.providerId
				|| typeof context.resource !== 'string') return undefined;
			const target = URI.parse(context.resource, true);
			if (target.scheme !== Schemas.internal || target.authority !== 'skill' || !/^\/[^/]+\/.+/u.test(target.path)) return undefined;
			return { providerId: context.providerId, resource: target };
		} catch { return undefined; }
	}
	dispose(): void { }
	[Symbol.dispose](): void { this.dispose(); }
}
