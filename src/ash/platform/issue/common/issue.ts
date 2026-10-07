import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface IssueReporterContext {
	readonly reportIssueUrl: string;
	readonly version: string;
	readonly os: string;
	readonly arch: string;
}

export interface ISimilarIssue {
	readonly html_url: string;
	readonly title: string;
	readonly state: string;
}

export interface CreatedIssue extends ISimilarIssue {
	readonly number: number;
}

export type IssueReporterErrorCode = 'authenticationRequired' | 'permissionDenied' | 'rateLimited' | 'unavailable' | 'invalidInput' | 'submissionUncertain' | 'operationFailed';

export class IssueReporterError extends Error {
	constructor(readonly code: IssueReporterErrorCode) { super(code); this.name = 'IssueReporterError'; }
}

/** Product reporting operations. The host owns the target, network policy and credentials. */
export interface IIssueReporterService {
	read(): Promise<IssueReporterContext>;
	searchGitHubIssues(title: string, signal: AbortSignal): Promise<readonly ISimilarIssue[]>;
	submitIssue(title: string, body: string): Promise<CreatedIssue>;
}

export const IIssueReporterService = createServiceIdentifier<IIssueReporterService>('issueReporterService');
