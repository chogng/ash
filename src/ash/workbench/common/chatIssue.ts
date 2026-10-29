import { Lxicon } from '../../base/common/lxicons.js';
import { themeColorFromId, type ThemeIcon } from '../../base/common/themables.js';
import type { GitHubIssue } from '../../platform/github/common/githubService.js';

/** Shared Issue status presentation; missing or newer closure reasons retain the closed state. */
export function computeIssueIcon(state: GitHubIssue['state'], stateReason: GitHubIssue['stateReason']): ThemeIcon {
	const isOpen = state === 'open';
	const isDiscarded = !isOpen && (stateReason === 'not_planned' || stateReason === 'duplicate');
	let color = 'charts.purple';
	if (isOpen) {
		color = 'charts.green';
	} else if (isDiscarded) {
		color = 'description.foreground';
	}
	return { id: isOpen ? Lxicon.issueOpened.id : Lxicon.issueClosed.id, color: themeColorFromId(color) };
}

/** Unresolved references keep a collection active until every Issue is known to be closed. */
export function computeAggregateIssueIcon(issues: readonly (Pick<GitHubIssue, 'state' | 'stateReason'> | undefined)[]): ThemeIcon {
	const hasActive = issues.length === 0 || issues.some(issue => issue?.state !== 'closed');
	if (hasActive) {
		return computeIssueIcon('open', undefined);
	}
	const hasCompleted = issues.some(issue => issue?.stateReason !== 'not_planned' && issue?.stateReason !== 'duplicate');
	return computeIssueIcon('closed', hasCompleted ? 'completed' : 'not_planned');
}
