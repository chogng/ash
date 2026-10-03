import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ReviewEnvironmentScope = { readonly type: 'directory'; readonly root: string } | { readonly type: 'thread'; readonly threadId: string };
export interface ReviewEnvironmentModel { readonly provider: string; readonly model: string; readonly connection?: string }
export type ReviewEnvironmentEntryKind = 'fact' | 'target';
export type ReviewEnvironmentSourceKind = 'projectFile' | 'recentCommand' | 'shellHistory' | 'otherRepository' | 'manual';
export interface ReviewEnvironmentCommandSource { readonly sessionId: string; readonly threadId: string; readonly turnId: string; readonly sequence: number; readonly recordedAtUnixMs: number }
export interface ReviewEnvironmentCommandEvidence { readonly occurrences: number; readonly sessionCount: number; readonly samples: readonly ReviewEnvironmentCommandSource[] }
export interface ReviewEnvironmentHistoryOptions { readonly sessions: number; readonly commandsPerSession: number; readonly days: number | null }
export interface ReviewEnvironmentHistoryCoverage { readonly sessionsAvailable: number; readonly sessionsScanned: number; readonly commandsAvailable: number; readonly commandsScanned: number; readonly factsAvailable: number; readonly factsIncluded: number }
export interface ReviewEnvironmentSource { readonly id: string; readonly kind: ReviewEnvironmentSourceKind; readonly label: string; readonly revision: string; readonly command?: ReviewEnvironmentCommandEvidence }
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
export interface ReviewEnvironmentProfile { readonly scanOptions: ReviewEnvironmentScanOptions; readonly root: string; readonly revision: number; readonly entries: readonly ReviewEnvironmentEntry[] }
export interface ReviewEnvironmentDraft { readonly history?: ReviewEnvironmentHistoryCoverage; readonly root: string; readonly id: string; readonly baseRevision: number; readonly entries: readonly ReviewEnvironmentEntry[] }
export interface ReviewEnvironmentScanOptions { readonly history: ReviewEnvironmentHistoryOptions; readonly recentCommands: boolean; readonly shellHistory: boolean; readonly otherRepositories: boolean; readonly summarizeWithModel: boolean }

/** Project facts and confirmed target descriptions are background; policy rules own authorization. */
export interface IApprovalEnvironmentService {
	read(scope: ReviewEnvironmentScope): Promise<ReviewEnvironmentProfile>;
	scan(scope: ReviewEnvironmentScope, operationId: string, options: ReviewEnvironmentScanOptions, model?: ReviewEnvironmentModel): Promise<ReviewEnvironmentDraft>;
	cancel(operationId: string): Promise<void>;
	save(scope: ReviewEnvironmentScope, commandId: string, expectedRevision: number, entries: readonly ReviewEnvironmentInput[], draftId?: string): Promise<ReviewEnvironmentProfile>;
}
export const IApprovalEnvironmentService = createServiceIdentifier<IApprovalEnvironmentService>('approvalEnvironmentService');
