import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import type { EnvironmentEntry as EntryDto, ApprovalEnvironmentReadResult as ProfileDto, ApprovalEnvironmentScanResult as DraftDto } from '../../app-server/common/generated/index.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import { localize } from '../../../nls.js';
import type { IApprovalEnvironmentService, ReviewEnvironmentDraft, ReviewEnvironmentEntry, ReviewEnvironmentInput, ReviewEnvironmentModel, ReviewEnvironmentProfile, ReviewEnvironmentScanOptions, ReviewEnvironmentScope } from '../common/approvalEnvironmentService.js';

/** Mechanical transport adapter; profile state and source verification stay in the backend. */
export class AppServerApprovalEnvironmentService implements IApprovalEnvironmentService {
	constructor(private readonly client: AppServerProtocolClient) {}
	async read(scope: ReviewEnvironmentScope): Promise<ReviewEnvironmentProfile> {
		return profile(await this.client.request(APP_SERVER_METHODS['approval/environment/read'], { scope }).catch(explain));
	}
	async scan(scope: ReviewEnvironmentScope, operationId: string, options: ReviewEnvironmentScanOptions, model?: ReviewEnvironmentModel): Promise<ReviewEnvironmentDraft> {
		return draft(await this.client.request(APP_SERVER_METHODS['approval/environment/scan'], { scope, operationId, options, model }).catch(explain));
	}
	async cancel(operationId: string): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['approval/environment/cancel'], { operationId }).catch(explain);
	}
	async save(scope: ReviewEnvironmentScope, commandId: string, expectedRevision: number, entries: readonly ReviewEnvironmentInput[], draftId?: string): Promise<ReviewEnvironmentProfile> {
		return profile(await this.client.request(APP_SERVER_METHODS['approval/environment/save'], { scope, commandId, expectedRevision, entries: entries.map(entry => ({ ...entry })), draftId }).catch(explain));
	}
}
function entry(value: EntryDto): ReviewEnvironmentEntry {
	return { id: value.id, kind: value.kind, title: value.title, content: value.content, accepted: value.accepted, current: value.current, source: { id: value.source.id, kind: value.source.kind, label: value.source.label, revision: value.source.revision } };
}
function profile(value: ProfileDto): ReviewEnvironmentProfile { return { root: value.root, revision: value.profile.revision, entries: value.profile.entries.map(entry) }; }
function draft(value: DraftDto): ReviewEnvironmentDraft { return { root: value.root, id: value.draft.id, baseRevision: value.draft.baseRevision, entries: value.draft.entries.map(entry) }; }
function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'ApprovalEnvironmentConflict': throw new Error(localize('approvalEnvironment.conflict', 'The profile or its sources changed. Rescan before saving. Your current draft is still open.'));
			case 'ApprovalEnvironmentUnavailable': throw new Error(localize('approvalEnvironment.unavailable', 'Review environment preparation or the selected model is unavailable.'));
			case 'ApprovalEnvironmentOperationFailed': throw new Error(localize('approvalEnvironment.failed', 'Review environment preparation failed. Check source access and model configuration.'));
			case 'InvalidParams': throw new Error(localize('approvalEnvironment.invalid', 'Check the selected project, source, title, and description. Descriptions must be short and contain no credentials.'));
		}
	}
	throw error;
}
