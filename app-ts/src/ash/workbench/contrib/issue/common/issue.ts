import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { CreatedIssue, IssueReporterContext, ISimilarIssue } from '../../../../platform/issue/common/issue.js';

export enum IssueType { Bug, PerformanceIssue, FeatureRequest }

export interface IssueReporterData {
	readonly issueType?: IssueType;
	readonly issueTitle?: string;
	readonly issueBody?: string;
}

export interface IssueReporterState {
	readonly context?: IssueReporterContext;
	readonly issueType: IssueType;
	readonly issueTitle: string;
	readonly issueBody: string;
	readonly includeSystemInfo: boolean;
	readonly includeExtensions: boolean;
	readonly systemInfo: string;
	readonly extensionInfo: string;
	readonly loading: boolean;
	readonly searching: boolean;
	readonly submitting: boolean;
	readonly similarIssues: readonly ISimilarIssue[];
	readonly searchedTitle?: string;
	readonly createdIssue?: CreatedIssue;
	readonly error?: string;
}

export interface IIssueFormService {
	readonly onDidChange: Event<IssueReporterState>;
	readonly state: IssueReporterState;
	initialize(data: IssueReporterData): Promise<void>;
	update(data: Partial<Pick<IssueReporterState, 'issueType' | 'issueTitle' | 'issueBody' | 'includeSystemInfo' | 'includeExtensions'>>): void;
	searchGitHubIssues(): Promise<void>;
	cancelSearch(): void;
	reset(): void;
	submitIssue(): Promise<void>;
	serialize(): string;
}

export interface IWorkbenchIssueService {
	openReporter(dataOverrides?: Partial<IssueReporterData>): Promise<void>;
}

export const IIssueFormService = createServiceIdentifier<IIssueFormService>('issueFormService');
export const IWorkbenchIssueService = createServiceIdentifier<IWorkbenchIssueService>('workbenchIssueService');
