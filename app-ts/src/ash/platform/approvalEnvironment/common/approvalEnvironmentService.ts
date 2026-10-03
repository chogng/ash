import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ReviewEnvironmentScope = { readonly type: 'directory'; readonly root: string } | { readonly type: 'thread'; readonly threadId: string };
export interface ReviewEnvironmentModel { readonly provider: string; readonly model: string; readonly connection?: string }
export type ReviewEnvironmentEntryKind = 'fact' | 'target';
export type ReviewEnvironmentSourceKind = 'projectFile' | 'recentCommand' | 'shellHistory' | 'otherRepository' | 'manual';
export interface ReviewEnvironmentSource { readonly id: string; readonly kind: ReviewEnvironmentSourceKind; readonly label: string; readonly revision: string }
export interface ReviewEnvironmentEntry {
	readonly id: string;
	readonly kind: ReviewEnvironmentEntryKind;
	readonly title: string;
	readonly content: string;
	readonly source: ReviewEnvironmentSource;
	readonly accepted: boolean;
	readonly current: boolean;
}
export interface ReviewEnvironmentInput { readonly id: string; readonly kind: ReviewEnvironmentEntryKind; readonly title: string; readonly content: string; readonly sourceId?: string }
export interface ReviewEnvironmentProfile { readonly root: string; readonly revision: number; readonly entries: readonly ReviewEnvironmentEntry[] }
export interface ReviewEnvironmentDraft { readonly root: string; readonly id: string; readonly baseRevision: number; readonly entries: readonly ReviewEnvironmentEntry[] }
export interface ReviewEnvironmentScanOptions { readonly recentCommands: boolean; readonly shellHistory: boolean; readonly otherRepositories: boolean; readonly summarizeWithModel: boolean }

/** Project facts and confirmed target descriptions are background; policy rules own authorization. */
export interface IApprovalEnvironmentService {
	read(scope: ReviewEnvironmentScope): Promise<ReviewEnvironmentProfile>;
	scan(scope: ReviewEnvironmentScope, operationId: string, options: ReviewEnvironmentScanOptions, model?: ReviewEnvironmentModel): Promise<ReviewEnvironmentDraft>;
	cancel(operationId: string): Promise<void>;
	save(scope: ReviewEnvironmentScope, commandId: string, expectedRevision: number, entries: readonly ReviewEnvironmentInput[], draftId?: string): Promise<ReviewEnvironmentProfile>;
}
export const IApprovalEnvironmentService = createServiceIdentifier<IApprovalEnvironmentService>('approvalEnvironmentService');
