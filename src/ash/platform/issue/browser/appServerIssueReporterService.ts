import { CancellationError } from '../../../base/common/errors.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { IssueReporterError, type IIssueReporterService, type ISimilarIssue } from '../common/issue.js';

export class AppServerIssueReporterService implements IIssueReporterService {
	constructor(private readonly connection: AppServerProtocolClient) { }

	async read() {
		this.ensureAvailable();
		try { return { ...await appServerRequest(this.connection, 'issueReporter/read', {}) }; }
		catch (error) { throw reporterError(error); }
	}

	async searchGitHubIssues(title: string, signal: AbortSignal): Promise<readonly ISimilarIssue[]> {
		this.ensureAvailable();
		if (signal.aborted) { throw new CancellationError(); }
		const operationId = generateUuid();
		const result = appServerRequest(this.connection, 'issueReporter/search', { operationId, title });
		let cancellation: Promise<unknown> | undefined;
		const cancel = (): void => {
			cancellation = appServerRequest(this.connection, 'issueReporter/search/cancel', { operationId });
			void cancellation.catch(() => undefined);
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const response = await result;
			if (signal.aborted) { throw new CancellationError(); }
			return response.issues.map(issue => ({ html_url: issue.url, title: issue.title, state: issue.state }));
		} catch (error) { throw reporterError(error); }
		finally { signal.removeEventListener('abort', cancel); await cancellation; }
	}

	async submitIssue(title: string, body: string) {
		this.ensureAvailable();
		try {
			const issue = await appServerRequest(this.connection, 'issueReporter/submit', { title, body });
			return { number: issue.number, html_url: issue.url, title: issue.title, state: issue.state };
		} catch (error) { throw error instanceof AppServerRemoteError ? reporterError(error) : new IssueReporterError('submissionUncertain'); }
	}

	private ensureAvailable(): void {
		if (this.connection.state !== 'ready' || this.connection.capabilities?.contracts.issueReporter?.version !== 1) { throw new IssueReporterError('unavailable'); }
	}
}

export function createDisconnectedIssueReporterService(unavailable: UnavailableOperation): IIssueReporterService {
	return { read: () => unavailable('issueReporter/read'), searchGitHubIssues: () => unavailable('issueReporter/search'), submitIssue: () => unavailable('issueReporter/submit') };
}

function reporterError(error: unknown): unknown {
	if (!(error instanceof AppServerRemoteError)) { return error; }
	switch (error.errorName) {
		case 'RequestCancelled': return new CancellationError();
		case 'AccountAuthenticationRequired': return new IssueReporterError('authenticationRequired');
		case 'IssueReporterPermissionDenied': return new IssueReporterError('permissionDenied');
		case 'IssueReporterRateLimited': return new IssueReporterError('rateLimited');
		case 'AccountUnavailable': case 'IssueReporterUnavailable': return new IssueReporterError('unavailable');
		case 'InvalidParams': return new IssueReporterError('invalidInput');
		case 'IssueReporterSubmissionUncertain': return new IssueReporterError('submissionUncertain');
		default: return new IssueReporterError('operationFailed');
	}
}
