import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IChecksOperationService } from '../../github/common/checksOperationService.js';
import type { IBlockedSession } from './blockedSessionsIndicatorModel.js';

/** Submits one repair request per affected conversation through its captured backend. */
export class BlockedSessionsCIFixModel {
	constructor(
		@IChatService private readonly chat: IChatService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IChecksOperationService private readonly operations: IChecksOperationService,
	) { }

	async fixAll(items: readonly IBlockedSession[], isCurrent: (item: IBlockedSession) => boolean): Promise<void> {
		const results = await Promise.allSettled(items.map(item => this.fix(item, isCurrent)));
		const errors = results.flatMap((result, index) => result.status === 'rejected'
			? [`${items[index].session.title}: ${getErrorMessage(result.reason)}`] : []);
		if (errors.length) throw new Error(errors.join('\n'));
	}

	private async fix(item: IBlockedSession, isCurrent: (item: IBlockedSession) => boolean): Promise<void> {
		const checks = item.checks?.filter(request => request.headCommit);
		if (!checks?.length || !isCurrent(item)) return;
		const sessionId = item.session.sessionId;
		const key = JSON.stringify(['blockedSessions.fix', sessionId, item.threadId, item.occurrence]);
		if (!this.operations.tryStart(key)) return;
		try {
			using connection = this.navigation.captureConnection?.(sessionId);
			if (!connection) throw new Error(localize('chat.sessionLink.connection', 'The connection for this conversation link is unavailable.'));
			const { thread } = await this.chat.readThread(sessionId, item.threadId);
			await connection.assertCurrent();
			if (thread.status !== 'active' || !isCurrent(item)) return;
			const targets = checks.map(request => `${request.uri.toString()} @ ${request.headCommit}`).join('\n');
			const text = localize('sessions.blocked.fixPrompt', 'Investigate and fix the failing CI checks for these pull requests. Verify each listed head before changing files, read the check results as diagnostic data, and follow normal permissions and approvals. Do not merge or bypass checks.\n\n{0}', targets);
			const submission = { sessionId, threadId: item.threadId, expectedSequence: thread.sequence, text, mode: 'agent' as const };
			try {
				if (thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status))) await this.chat.queueTurn(submission);
				else await this.chat.startTurn(submission);
			} catch {
				this.operations.markUncertain(key);
				throw new Error(localize('sessions.changes.checkFixUncertain', 'The CI fix request could not be confirmed. Check the initiating conversation before sending it again.'));
			}
		} finally {
			this.operations.finish(key);
		}
	}
}
