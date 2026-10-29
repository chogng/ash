import type { URI } from '../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { GitHubPullRequestReference, GitHubIssueReference, GitHubIssue } from '../../../../platform/github/common/githubService.js';
import type { ChatPullRequestState, IPullRequestIconStatus } from '../../../../workbench/common/chatPullRequest.js';
import { localize } from '../../../../nls.js';

/** A manually attached or branch-associated PR resolved for the Session. */
export interface IResolvedSessionPullRequest {
	readonly uri: URI;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly state: ChatPullRequestState | 'unavailable';
	readonly status: IPullRequestIconStatus;
	readonly icon: ThemeIcon;
	readonly recordedReference?: GitHubPullRequestReference;
}

/** Exposes every attention reason in text even when the icon represents only the highest priority. */
export function getPullRequestLabel(request: IResolvedSessionPullRequest): string {
	const states: Record<IResolvedSessionPullRequest['state'], string> = {
		open: localize('github.status.open', 'Open'),
		draft: localize('github.status.draft', 'Draft'),
		closed: localize('github.status.closed', 'Closed'),
		merged: localize('github.status.merged', 'Merged'),
		unavailable: localize('sessions.github.unavailable', 'Status unavailable'),
	};
	const labels = [`${request.owner}/${request.repo} #${request.number}`];
	if (request.title) {
		labels.push(request.title);
	}
	labels.push(states[request.state]);
	if (request.status.hasMergeConflicts) {
		labels.push(localize('sessions.github.conflicts', 'Merge conflicts'));
	}
	if (request.status.hasFailingChecks) {
		labels.push(localize('github.checks.failure', 'Checks failed'));
	}
	if (request.status.hasUnresolvedComments) {
		labels.push(localize('sessions.github.comments', 'Unresolved review comments'));
	}
	return labels.join(' · ');
}

/** The saved identity stays removable when GitHub cannot supply its live status. */
export interface IResolvedSessionIssue {
	readonly reference: GitHubIssueReference;
	readonly uri: URI;
	readonly issue: Pick<GitHubIssue, 'title' | 'state' | 'stateReason'> | undefined;
}

export function getIssueLabel(entry: IResolvedSessionIssue): string {
	const { repository, number } = entry.reference;
	let state = localize('sessions.github.unavailable', 'Status unavailable');
	if (entry.issue?.state === 'open') {
		state = localize('github.status.open', 'Open');
	} else if (entry.issue?.state === 'closed') {
		state = localize('sessions.github.issueCompleted', 'Completed');
		if (entry.issue.stateReason === 'not_planned') {
			state = localize('sessions.github.issueNotPlanned', 'Not planned');
		} else if (entry.issue.stateReason === 'duplicate') {
			state = localize('sessions.github.issueDuplicate', 'Duplicate');
		}
	}
	return [`${repository.host}/${repository.owner}/${repository.name} #${number}`, entry.issue?.title, state].filter(Boolean).join(' · ');
}
