import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IChatService, type StartTurnOptions } from '../../../../../workbench/services/chat/common/chatService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionCodeReviewService } from '../../browser/sessionCodeReviewService.js';

suite('SessionCodeReviewService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retains an older Last Turn draft until its repository identities can be resolved', async () => {
		const dom = new JSDOM('', { url: 'https://ash.test' });
		using browser = { [Symbol.dispose]: () => dom.window.close() };
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'code-review', flushInterval: 0 });
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		services.registerInstance(ISessionsManagementService, { onDidChange: Event.None } as ISessionsManagementService);
		const target = { sessionId: 'session', threadId: 'source' };
		let forks = 0;
		services.registerInstance(IAgentThreadService, {
			async fork() {
				forks++;
				return { sessionId: target.sessionId, threadId: 'review' };
			},
		} as unknown as IAgentThreadService);
		const captures = [
			{ changeSetId: 'change-a', repositoryId: 'repository-a' },
			{ changeSetId: 'change-b', repositoryId: 'repository-b' },
		];
		const failure = new Error('Turn changes temporarily unavailable');
		let available = false;
		const submissions: StartTurnOptions[] = [];
		services.registerInstance(IChatService, {
			readThread: async () => ({ thread: { status: 'active', sequence: 1, turns: [] } }),
			async listTurnChanges() {
				if (!available) throw failure;
				return captures;
			},
			startTurn: async (request: StartTurnOptions) => { submissions.push(request); },
		} as unknown as IChatService);
		using reviews = services.createInstance(SessionCodeReviewService);
		const path = 'src/main.ts';
		for (const { changeSetId } of captures) {
			const resource = `ash-turn-diff:/${changeSetId}/${path}`;
			reviews.save(target, { key: `${resource}\0${resource}`, path, before: 'old', after: 'new' }, { side: 'modified', line: 1 }, 'Same feedback');
		}
		const draft = reviews.draft(target);

		await assert.rejects(reviews.send(target, () => true), failure);
		assert.deepEqual(reviews.draft(target), draft);
		assert.equal(reviews.pending(target), undefined);
		assert.equal(forks, 0);
		assert.equal(submissions.length, 0);

		available = true;
		await reviews.send(target, () => true);
		assert.equal(forks, 1);
		assert.equal(submissions.length, 1);
		assert.deepEqual(JSON.parse(submissions[0]!.contexts![0]!.content).map((comment: { repositoryId: string; path: string; }) => [comment.repositoryId, comment.path]), [
			['repository-a', path], ['repository-b', path],
		]);
		assert.deepEqual(reviews.draft(target), { files: [], comments: [] });
	});
});
