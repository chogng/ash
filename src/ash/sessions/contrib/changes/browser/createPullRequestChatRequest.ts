import { localize } from '../../../../nls.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import type { ISession, IChat } from '../../../services/sessions/common/session.js';
import type { ISessionPullRequestChatOptions, ISessionPullRequestCreation } from '../common/pullRequestCreation.js';

class UncertainChatRequestError extends Error {
	constructor(error: unknown) {
		super(localize('sessions.changes.prAgentUncertain', 'The agent request could not be confirmed. Check the initiating conversation before sending it again.'), { cause: error });
	}
}

/** Submits to the initiating Thread through the ordinary Turn/queue permission path. */
export class CreatePullRequestChatRequest {
	constructor(@IChatService private readonly chatService: IChatService) { }

	public static isSubmissionUncertain(error: unknown): boolean { return error instanceof UncertainChatRequestError; }

	public async send(session: ISession, options: ISessionPullRequestChatOptions, creation: ISessionPullRequestCreation, chat: IChat): Promise<void> {
		if (!creation.prepareChatRequest) { throw new Error(localize('sessions.changes.prAgentUnavailable', 'This repository cannot prepare a pull request request for the agent.')); }
		const { thread } = await this.chatService.readThread(session.sessionId, chat.threadId);
		if (session.status === 'archived' || thread.status === 'archived') { throw new Error(localize('sessions.changes.prReadOnly', 'Cannot send a pull request request to an archived conversation.')); }
		const text = await creation.prepareChatRequest(createPullRequestMessage(options), options);
		const submission = { sessionId: session.sessionId, threadId: chat.threadId, expectedSequence: thread.sequence, text, mode: 'agent' as const };
		const active = thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status));
		try {
			if (active) { await this.chatService.queueTurn(submission); }
			else { await this.chatService.startTurn(submission); }
		} catch (error) {
			// The Turn contract does not distinguish a rejected command from a lost reply.
			// Never invite a retry that could enqueue the same request twice.
			throw new UncertainChatRequestError(error);
		}
	}
}

export function createPullRequestMessage(options: ISessionPullRequestChatOptions): string {
	const context = options.expectedContext;
	return [
		options.draft ? localize('sessions.changes.prAgentDraft', 'Create a draft pull request and leave it in draft.') : localize('sessions.changes.prAgentReady', 'Create a pull request ready for review.'),
		localize('sessions.changes.prAgentContext', 'Use repository {0} in {1}, source branch {2}, and target branch {3}. If the repository or branch has changed, stop and ask me to review the context.', context.repository, context.workingDirectory, context.branchName, context.baseBranchName),
		options.title ? localize('sessions.changes.prAgentDetails', 'Title: {0}\nDescription:\n{1}', options.title, options.description ?? '') : localize('sessions.changes.prAgentGenerate', 'Generate a title and description that summarize the changes.'),
		localize('sessions.changes.prAgentPublish', 'Review the changes, commit the intended files, and push the source branch as needed. Follow the ordinary permission and approval requirements.'),
		options.autoMergeMethod && !options.draft
			? localize('sessions.changes.prAgentAuto', 'Enable GitHub auto-merge using {0}. Wait for required checks and approvals; do not bypass them.', options.autoMergeMethod)
			: localize('sessions.changes.prAgentManual', 'Do not merge the pull request or enable auto-merge.'),
	].join('\n\n');
}
