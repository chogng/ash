import { localize } from '../../../../nls.js';
import type { GitHubCheckRun } from '../../../../platform/github/common/githubService.js';

const enum CICheckGroup {
	Running,
	Pending,
	Failed,
	Successful,
}

function isFailedConclusion(conclusion: string | null | undefined): boolean {
	return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'startup_failure';
}

function getCheckGroup(check: GitHubCheckRun): CICheckGroup {
	if (check.status === 'in_progress') { return CICheckGroup.Running; }
	if (check.status !== 'completed') { return CICheckGroup.Pending; }
	return isFailedConclusion(check.conclusion) ? CICheckGroup.Failed : CICheckGroup.Successful;
}

export function getCheckStateLabel(check: GitHubCheckRun): string {
	if (check.conclusion === 'cancelled') { return localize('sessions.changes.checkCancelled', 'Cancelled'); }
	if (check.conclusion === 'skipped') { return localize('sessions.changes.checkSkipped', 'Skipped'); }
	if (check.status === 'completed' && check.conclusion !== 'success' && !isFailedConclusion(check.conclusion)) { return localize('sessions.changes.checkNeutral', 'Neutral'); }
	switch (getCheckGroup(check)) {
		case CICheckGroup.Running: return localize('sessions.changes.checkRunning', 'Running');
		case CICheckGroup.Pending: return localize('sessions.changes.checkPending', 'Pending');
		case CICheckGroup.Failed: return localize('sessions.changes.checkFailed', 'Failed');
		case CICheckGroup.Successful: return localize('sessions.changes.checkSuccessful', 'Successful');
	}
}
