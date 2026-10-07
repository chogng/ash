import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import type { Event } from '../../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { SkillDescriptor, SkillIdentity } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { ParsedPromptFile } from '../promptFileParser.js';

/** Discovered metadata plus a revision-pinned readable URI, without a private host path. */
export interface IAgentSkill extends SkillDescriptor {
	readonly uri: URI;
	readonly name: string;
}

export interface SkillManagementSnapshot {
	readonly revision: number;
	readonly catalog: { readonly generation: number; readonly skills: readonly IAgentSkill[]; };
	readonly diagnostics: readonly { readonly source: string; readonly subject: string | undefined; readonly message: string; }[];
}

/** Current production Prompt operations; other upstream Prompt types are not implemented yet. */
export interface IPromptsService extends IDisposable {
	readonly onDidChangeSkills: Event<void>;
	findAgentSkills(token: CancellationToken, sessionId?: string): Promise<readonly IAgentSkill[]>;
	readSkillManagement(sessionId?: string): Promise<SkillManagementSnapshot>;
	setSkillEnablement(skillId: SkillIdentity, enabled: boolean, expectedRevision: number, sessionId?: string): Promise<void>;
	parseNew(uri: URI, token: CancellationToken): Promise<ParsedPromptFile>;
}

export const IPromptsService = createServiceIdentifier<IPromptsService>('IPromptsService');
