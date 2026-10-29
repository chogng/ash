import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IIssueReporterService, IssueReporterError, type IssueReporterContext } from '../../../../platform/issue/common/issue.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IssueType, type IIssueFormService, type IssueReporterData, type IssueReporterState } from '../common/issue.js';
import { IssueReporterModel } from './issueReporterModel.js';

export class IssueFormService extends Disposable implements IIssueFormService {
	private readonly model = this._register(new IssueReporterModel());
	readonly onDidChange = this.model.onDidChange;
	private initialization: Promise<void> | undefined;
	private search: AbortController | undefined;

	constructor(@IIssueReporterService private readonly backend: IIssueReporterService, @IExtensionService private readonly extensions: IExtensionService) {
		super();
	}

	get state(): IssueReporterState { return this.model.state; }

	async initialize(data: IssueReporterData): Promise<void> {
		this.update(data);
		if (this.state.context || this.initialization) { return this.initialization; }
		this.model.update({ loading: true, error: undefined });
		this.initialization = (async () => {
			try {
				const context = await this.backend.read();
				if (this.isDisposed) { return; }
				// Read the Workbench's catalog without restarting extension activation to collect diagnostics.
				const catalog = this.extensions.currentCatalog;
				const extensionInfo = [...catalog.extensions.map(extension => `${extension.id} ${extension.version}`), ...catalog.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)].join('\n') || localize('issue.noExtensions', 'No extensions installed.');
				const systemInfo = await this.readSystemInfo(context);
				if (this.isDisposed) { return; }
				this.model.update({ context, systemInfo, extensionInfo });
			} catch (error) { if (!this.isDisposed) { this.model.update({ error: errorMessage(error) }); } }
			finally { if (!this.isDisposed) { this.model.update({ loading: false }); } this.initialization = undefined; }
		})();
		return this.initialization;
	}

	protected async readSystemInfo(context: IssueReporterContext): Promise<string> {
		return localize('issue.serverSystem', 'App Server\nAsh: {0}\nOS: {1} ({2})\n\nBrowser: {3}', context.version, context.os, context.arch, navigator.userAgent);
	}

	update(data: Parameters<IIssueFormService['update']>[0]): void {
		if (this.state.submitting || this.state.createdIssue) { return; }
		if (data.issueType !== undefined && ![IssueType.Bug, IssueType.PerformanceIssue, IssueType.FeatureRequest].includes(data.issueType)) { throw new TypeError('Unknown issue type'); }
		if (data.issueTitle !== undefined && typeof data.issueTitle !== 'string' || data.issueBody !== undefined && typeof data.issueBody !== 'string') { throw new TypeError('Issue title and description must be text'); }
		if (data.issueTitle !== undefined && data.issueTitle !== this.state.issueTitle) {
			this.cancelSearch();
			this.model.update({ ...data, similarIssues: [], searchedTitle: undefined });
			return;
		}
		this.model.update(data);
	}

	async searchGitHubIssues(): Promise<void> {
		if (!this.state.context || this.state.searching || !this.state.issueTitle.trim()) { return; }
		const search = new AbortController();
		this.search = search;
		const title = this.state.issueTitle;
		this.model.update({ searching: true, error: undefined });
		try {
			const similarIssues = await this.backend.searchGitHubIssues(title, search.signal);
			if (!search.signal.aborted && title === this.state.issueTitle) { this.model.update({ similarIssues, searchedTitle: title }); }
		} catch (error) { if (!(error instanceof CancellationError)) { this.model.update({ error: errorMessage(error) }); } }
		finally { this.search = undefined; this.model.update({ searching: false }); }
	}

	cancelSearch(): void { this.search?.abort(); }
	reset(): void {
		if (this.state.submitting) { return; }
		this.cancelSearch();
		this.model.update({ issueType: IssueType.Bug, issueTitle: '', issueBody: '', includeSystemInfo: true, includeExtensions: true, similarIssues: [], searchedTitle: undefined, createdIssue: undefined, error: undefined });
	}
	serialize(): string { return this.model.serialize(); }

	async submitIssue(): Promise<void> {
		if (this.state.submitting || this.state.createdIssue) { return; }
		if (!this.state.context || !this.state.issueTitle.trim() || !this.state.issueBody.trim()) {
			this.model.update({ error: localize('issue.validation', 'Enter a title and description before submitting.') });
			return;
		}
		this.model.update({ submitting: true, error: undefined });
		try { this.model.update({ createdIssue: await this.backend.submitIssue(this.state.issueTitle, this.serialize()) }); }
		catch (error) { this.model.update({ error: errorMessage(error) }); }
		finally { this.model.update({ submitting: false }); }
	}

	override dispose(): void { this.cancelSearch(); super.dispose(); }
}

function errorMessage(error: unknown): string {
	if (error instanceof IssueReporterError) {
		switch (error.code) {
			case 'authenticationRequired': return localize('issue.authenticationRequired', 'Sign in to GitHub before submitting this report.');
			case 'permissionDenied': return localize('issue.permissionDenied', 'Your GitHub authorization needs permission to create issues in this repository.');
			case 'rateLimited': return localize('issue.rateLimited', 'GitHub rate limit reached. Try again later.');
			case 'unavailable': return localize('issue.unavailable', 'The product issue reporter is not configured.');
			case 'invalidInput': return localize('issue.invalidInput', 'The title must be at most 256 characters and the full report at most 65,536 characters.');
			case 'submissionUncertain': return localize('issue.submissionUncertain', 'GitHub may have created your issue. Check the repository before submitting again.');
			case 'operationFailed': return localize('issue.operationFailed', 'The GitHub request failed. Your report remains here.');
		}
	}
	return localize('issue.connectionFailed', 'Could not load the issue reporter. Check the App Server connection and try opening it again.');
}
