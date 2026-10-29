import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import {
	IChatService,
	type StartTurnOptions,
	type ThreadRead,
} from '../../../../../workbench/services/chat/common/chatService.js';
import type { ISession, IChat } from '../../../../services/sessions/common/session.js';
import type { ISessionPullRequestCreation, ISessionPullRequestChatOptions } from '../../common/pullRequestCreation.js';
import { CreatePullRequestChatRequest } from '../../browser/createPullRequestChatRequest.js';

const session = { sessionId: 'origin', status: 'active' } as ISession;
const chat = { threadId: 'origin-thread', status: 'active' } as IChat;
const options: ISessionPullRequestChatOptions = {
	draft: false,
	title: 'Reviewed title',
	description: 'Reviewed description',
	autoMergeMethod: 'SQUASH',
	expectedContext: {
		workingDirectory: '/origin',
		repository: 'github.com/team/repo',
		branchName: 'feature',
		baseBranchName: 'main',
	},
};

function thread(active: boolean, archived = false): ThreadRead {
	return {
		thread: {
			sessionId: 'origin',
			threadId: 'origin-thread',
			sequence: 17,
			status: archived ? 'archived' : 'active',
			turns: active ? [{ status: 'running' }] : [],
		},
	} as unknown as ThreadRead;
}

for (const active of [false, true])
	test(`PR agent request ${active ? 'queues beside an active Turn' : 'starts in an idle Thread'} with the captured context`, async () => {
		using services = new InstantiationService();
		const calls: { action: string; request: StartTurnOptions }[] = [];
		services.registerInstance(IChatService, {
			readThread: async () => thread(active),
			startTurn: async (request: StartTurnOptions) => {
				calls.push({ action: 'start', request });
			},
			queueTurn: async (request: StartTurnOptions) => {
				calls.push({ action: 'queue', request });
			},
		} as unknown as IChatService);
		const creation = {
			prepareChatRequest: async (message: string) => message,
		} as unknown as ISessionPullRequestCreation;
		await services.createInstance(CreatePullRequestChatRequest).send(session, options, creation, chat);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.action, active ? 'queue' : 'start');
		assert.deepEqual(
			{ ...calls[0]!.request, text: undefined },
			{ sessionId: 'origin', threadId: 'origin-thread', expectedSequence: 17, mode: 'agent', text: undefined },
		);
		assert.match(calls[0]!.request.text, /github.com\/team\/repo.*\/origin.*feature.*main/u);
		assert.match(calls[0]!.request.text, /Title: Reviewed title\nDescription:\nReviewed description/u);
		assert.match(calls[0]!.request.text, /SQUASH/u);
	});

test('PR agent requests stop before submission for archived Threads or changed preparation context', async () => {
	using services = new InstantiationService();
	let archived = true;
	let prepared = 0;
	services.registerInstance(IChatService, {
		readThread: async () => thread(false, archived),
		startTurn: async () => assert.fail('Invalid context reached Turn submission'),
	} as unknown as IChatService);
	const creation = {
		prepareChatRequest: async () => {
			prepared++;
			throw new Error('Repository changed');
		},
	} as unknown as ISessionPullRequestCreation;
	const request = services.createInstance(CreatePullRequestChatRequest);
	await assert.rejects(request.send(session, options, creation, chat), /archived/u);
	assert.equal(prepared, 0);
	archived = false;
	await assert.rejects(request.send(session, options, creation, chat), /Repository changed/u);
	assert.equal(prepared, 1);
});

test('a lost agent submission reply is explicitly uncertain and is never replayed', async () => {
	using services = new InstantiationService();
	let submissions = 0;
	services.registerInstance(IChatService, {
		readThread: async () => thread(false),
		startTurn: async () => {
			submissions++;
			throw new Error('Lost connection after sending');
		},
	} as unknown as IChatService);
	const creation = {
		prepareChatRequest: async (message: string) => message,
	} as unknown as ISessionPullRequestCreation;
	await assert.rejects(
		services.createInstance(CreatePullRequestChatRequest).send(session, options, creation, chat),
		error => {
			assert.equal(CreatePullRequestChatRequest.isSubmissionUncertain(error), true);
			assert.match(String(error), /Check the initiating conversation/u);
			return true;
		},
	);
	assert.equal(submissions, 1);
});
