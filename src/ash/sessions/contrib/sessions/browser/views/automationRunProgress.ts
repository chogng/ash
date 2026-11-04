import type { IChatWidget } from '../../../../../workbench/contrib/chat/browser/chat.js';
import type { IAutomationRun } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import type { ISessionProviderScope } from '../../../../browser/agentHost/sessionProviderScopeService.js';

/** A retained Chat can report in-flight progress before the automation history refreshes. */
export function automationRunWithLocalProgress(
	run: IAutomationRun,
	widgets: readonly IChatWidget[],
	scope: Pick<ISessionProviderScope, 'providerId' | 'identity'> | undefined,
): IAutomationRun {
	if (!scope || scope.providerId !== run.providerId || !run.sessionId || !run.threadId || !run.turnId
		|| (run.status !== 'pending' && run.status !== 'running')) return run;

	const sessionId = scope.identity(run.sessionId);
	const threadId = scope.identity(run.threadId);
	const thread = widgets.find(widget => widget.sessionId === sessionId && widget.threadId === threadId
		&& widget.model?.thread?.sessionId === sessionId && widget.model.thread.threadId === threadId)?.model?.thread;
	const turn = thread?.turns.find(turn => turn.turnId === run.turnId);
	const status = turn?.status;
	if (status === 'waitingForUserInput' || status === 'waitingForApproval' || status === 'waitingForCapability') {
		return { ...run, status: 'needsInput', message: null };
	}
	if (status === 'running' && run.status === 'pending') {
		return { ...run, status: 'running', message: null };
	}
	return run;
}
