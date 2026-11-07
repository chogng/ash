import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IChatService, Thread, Turn, TurnChangeDetails, TurnChangeFile, TurnChangeFileContents, TurnChangeSetSummary } from '../../../workbench/services/chat/common/chatService.js';
import { readChatRequestVersions } from '../../browser/chatRequestVersions.js';
import { createTurnResultComparisonInput } from '../../browser/turnMultiDiffSource.js';
import type { ISession } from '../../services/sessions/common/session.js';

const original = { sessionId: 'session', threadId: 'original', turnId: 'request' };
const alternate = { sessionId: 'session', threadId: 'alternate', turnId: 'rerun' };
const zero = { reported: 0, complete: true };
const usage = {
	modelInvocations: 0, inputTokens: zero, outputTokens: zero,
	cachedInputTokens: zero, cacheWriteInputTokens: zero, reasoningTokens: zero,
};

function capture(target: typeof original): TurnChangeSetSummary {
	return {
		...target, changeSetId: target.turnId, repositoryId: 'repo', revision: 1,
		statistics: { files: 1, additions: 1, deletions: 0 }, captureState: 'sealed', terminalState: 'completed',
		messageState: 'unconfigured', commitState: 'idle', committedPaths: [], dependencies: [],
		externalDependencyPaths: [], warnings: [], conflictPaths: [],
	};
}

function turn(turnId: string, text: string, status: Turn['status'] = 'completed'): Turn {
	return {
		turnId, status, mode: 'agent', kind: 'coding', approvalMode: 'manual', usage,
		items: [{ type: 'userMessage', itemId: `${turnId}-message`, turnId, text, clientId: `${turnId}-submit` }],
	};
}

test('version pairs follow an exact rewind and accepted request from either reply', async () => {
	const inherited = turn('earlier', 'Earlier request');
	const request = turn(original.turnId, 'Same request');
	const thread = (threadId: string, origin: Thread['origin'], turns: readonly Turn[]): Thread => ({
		threadId, origin, turns, sessionId: original.sessionId, title: 'Conversation', status: 'active',
		advisor: { type: 'default' }, agentId: 'agent', sequence: 1, usage,
	});
	const branch = (threadId: string, rerun: Turn): Thread => thread(threadId,
		{ type: 'rewind', parentThreadId: original.threadId, beforeTurnId: original.turnId }, [inherited, rerun]);
	const threads = [
		thread(original.threadId, { type: 'root' }, [inherited, request, turn('later', 'Later request')]),
		branch(alternate.threadId, turn(alternate.turnId, 'Same request')),
		branch('edited', turn('edited-turn', 'Different request')),
		branch('running', turn('running-turn', 'Same request', 'running')),
	];
	const session: ISession = {
		sessionId: original.sessionId, kind: 'code', title: 'Session', status: 'active', nextApprovalMode: 'manual',
		chats: threads.map(thread => ({
			threadId: thread.threadId, status: 'active',
			origin: thread.origin.type === 'rewind' ? { type: 'fork', parentThreadId: thread.origin.parentThreadId, parentSequence: 1 } : { type: 'root' },
		})),
	};
	const chat = {
		readThread: async (sessionId, threadId) => ({
			thread: threads.find(thread => thread.threadId === threadId)!,
			transcript: { sessionId, threadId, durableSequence: 1, revision: 1, entries: [] },
		}),
		listTurnChanges: async (_sessionId, threadId) => [capture(threadId === original.threadId ? original : alternate)],
	} satisfies Pick<IChatService, 'readThread' | 'listTurnChanges'>;
	for (const threadId of [original.threadId, alternate.threadId]) {
		assert.deepEqual(await readChatRequestVersions(chat as unknown as IChatService, session, threadId), [{ original, alternate }]);
	}
	assert.deepEqual(await readChatRequestVersions(chat as unknown as IChatService, session, 'edited'), []);
});

test('version comparison matches final paths and falls back to the common baseline', async () => {
	const file = (path: string, kind: TurnChangeFile['kind'], previousPath?: string): TurnChangeFile => ({
		path, kind, previousPath, binary: false, additions: 1, deletions: 1,
		beforeMode: kind === 'added' ? undefined : '100644', afterMode: kind === 'deleted' ? undefined : '100644',
	});
	const details: Record<string, TurnChangeDetails> = {
		request: { summary: capture(original), files: [file('renamed.ts', 'renamed', 'old.ts'), file('same.ts', 'modified')] },
		rerun: { summary: capture(alternate), files: [file('old.ts', 'modified'), file('same.ts', 'modified'), file('added.ts', 'added'), file('deleted.ts', 'deleted')] },
	};
	const contents: Record<string, [string | undefined, string | undefined]> = {
		'request/renamed.ts': ['base', 'original rename'],
		'request/same.ts': ['before', 'same edit'],
		'rerun/old.ts': ['base', 'alternate edit'],
		'rerun/same.ts': ['before', 'same edit'],
		'rerun/added.ts': [undefined, 'added'],
		'rerun/deleted.ts': ['deleted', undefined],
	};
	const chat = {
		listTurnChanges: async (_sessionId, threadId) => [details[threadId === original.threadId ? original.turnId : alternate.turnId].summary],
		readTurnChange: async (_sessionId, _threadId, changeSetId) => details[changeSetId],
		readTurnChangeFile: async (_sessionId, _threadId, changeSetId, path): Promise<TurnChangeFileContents> => {
			const [before, after] = contents[`${changeSetId}/${path}`];
			return { path, before, after, binary: false, truncated: false };
		},
	} satisfies Pick<IChatService, 'listTurnChanges' | 'readTurnChange' | 'readTurnChangeFile'>;
	const diff = await createTurnResultComparisonInput(chat as unknown as IChatService, { original, alternate });
	assert.deepEqual(diff.items.map(item => [item.label, item.original.initialText, item.modified.initialText]), [
		['old.ts', '', 'alternate edit'], ['renamed.ts', 'original rename', ''], ['added.ts', '', 'added'], ['deleted.ts', 'deleted', ''],
	]);
	assert.ok(diff.items.every(item => item.original.readOnly && item.modified.readOnly));
	const readFile = chat.readTurnChangeFile;
	chat.readTurnChangeFile = async (...args) => {
		const result = await readFile(...args);
		if (args[2] === original.turnId) {
			details.rerun = { ...details.rerun, summary: { ...details.rerun.summary, revision: 2 } };
		}
		return result;
	};
	await assert.rejects(createTurnResultComparisonInput(chat as unknown as IChatService, { original, alternate }), /capture changed/);
});
