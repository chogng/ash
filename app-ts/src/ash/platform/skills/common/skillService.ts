import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { ISkillApi, SkillCatalog, SkillIdentity } from './skillApi.js';

export interface SkillManagementSnapshot {
	readonly revision: number;
	readonly catalog: SkillCatalog;
	readonly diagnostics: readonly { readonly source: string; readonly subject: string | undefined; readonly message: string }[];
}

export interface ISkillService extends ISkillApi {
	read(): Promise<SkillManagementSnapshot>;
	setEnabled(skillId: SkillIdentity, enabled: boolean, expectedRevision: number): Promise<void>;
}

export const ISkillService = createServiceIdentifier<ISkillService>('skillService');
export const OPEN_SKILLS_COMMAND_ID = 'ash.skills.open';
