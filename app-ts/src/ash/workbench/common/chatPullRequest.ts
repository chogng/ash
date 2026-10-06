import { Lxicon } from '../../base/common/lxicons.js';
import { themeColorFromId, type ThemeIcon } from '../../base/common/themables.js';

export type ChatPullRequestState = 'open' | 'closed' | 'merged' | 'draft';

export interface IPullRequestIconStatus {
	readonly hasMergeConflicts?: boolean;
	readonly hasFailingChecks?: boolean;
	readonly hasUnresolvedComments?: boolean;
}

const stateIcons: Record<ChatPullRequestState, ThemeIcon> = {
	open: { id: Lxicon.gitPullRequest.id, color: themeColorFromId('charts.green') },
	closed: { id: Lxicon.gitPullRequestClosed.id, color: themeColorFromId('charts.red') },
	merged: { id: Lxicon.gitPullRequestDone.id, color: themeColorFromId('charts.purple') },
	draft: { id: Lxicon.gitPullRequestDraft.id, color: themeColorFromId('descriptionForeground') },
};

/** Live review problems refine open PRs; draft and terminal states retain their own identity. */
export function computePullRequestIcon(state: ChatPullRequestState, status?: IPullRequestIconStatus): ThemeIcon {
	let icon = stateIcons[state];
	if (state === 'open' && status) {
		if (status.hasMergeConflicts || status.hasFailingChecks) {
			icon = { id: Lxicon.gitPullRequestError.id, color: themeColorFromId('charts.orange') };
		} else if (status.hasUnresolvedComments) {
			icon = { id: Lxicon.gitPullRequestComment.id, color: themeColorFromId('charts.green') };
		}
	}
	return { id: icon.id, color: themeColorFromId(icon.color!.id) };
}

/** Keeps the first icon on ties so a refresh does not change the representative PR. */
export function getHighestPriorityPullRequestIcon(icons: Iterable<ThemeIcon | undefined>): ThemeIcon | undefined {
	const priorities = new Map([
		[Lxicon.gitPullRequestError.id, 6],
		[Lxicon.gitPullRequestComment.id, 5],
		[Lxicon.gitPullRequest.id, 4],
		[Lxicon.gitPullRequestDraft.id, 3],
		[Lxicon.gitPullRequestDone.id, 2],
		[Lxicon.gitPullRequestClosed.id, 1],
	]);
	let result: ThemeIcon | undefined;
	let highest = -1;
	for (const icon of icons) {
		if (!icon) {
			continue;
		}
		const priority = priorities.get(icon.id) ?? 0;
		if (priority > highest) {
			result = icon;
			highest = priority;
		}
	}
	return result;
}
