import type { URI } from '../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { GitHubPullRequestReference } from '../../../../platform/github/common/githubService.js';
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
