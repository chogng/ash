import { localize } from '../../../../../../nls.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import type { Event } from '../../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { HookSource, SkillDescriptor, SkillIdentity } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { ParsedPromptFile } from '../promptFileParser.js';

/** Discovered metadata plus a revision-pinned readable URI, without a private host path. */
export interface IAgentSkill extends SkillDescriptor {
	readonly uri: URI;
	readonly name: string;
}

export interface SkillManagementSnapshot {
	readonly revision: number;
	readonly catalog: { readonly generation: number; readonly skills: readonly IAgentSkill[] };
	readonly diagnostics: readonly {
		readonly source: string;
		readonly subject: string | undefined;
		readonly message: string;
	}[];
}

/** Current production Prompt operations; other upstream Prompt types are not implemented yet. */
export interface IPromptsService extends IDisposable {
	readonly onDidChangeSkills: Event<void>;
	readonly onDidChangeHooks: Event<void>;
	/** Reads authoritative TOML declarations, including disabled and legacy Hooks. */
	getHooks(token: CancellationToken, sessionId?: string): Promise<readonly HookSource[]>;
	findAgentSkills(token: CancellationToken, sessionId?: string): Promise<readonly IAgentSkill[]>;
	/** Refreshes metadata with one bounded retry when that refresh invalidates its own response. */
	readSkillManagement(sessionId?: string): Promise<SkillManagementSnapshot>;
	/** Uses the displayed backend revision, with no automatic mutation retry on conflict. */
	setSkillEnablement(skillId: SkillIdentity, enabled: boolean, expectedRevision: number, sessionId?: string): Promise<void>;
	/** Adds a saved collection to the backend catalog without maintaining another source list. */
	registerSkillSource(rootReference: string): Promise<void>;
	parseNew(uri: URI, token: CancellationToken): Promise<ParsedPromptFile>;
}

export const IPromptsService = createServiceIdentifier<IPromptsService>('IPromptsService');

/** A rejected write leaves the backend configuration unchanged; the caller must refresh before retry. */
export class SkillManagementConflictError extends Error {
	constructor(public readonly expectedRevision: number) {
		super(localize('prompt.management.conflict', 'Skill settings changed in another window or on disk. Refresh Skills and review the current state before trying again.'));
		this.name = 'SkillManagementConflictError';
	}
}
