import { createServer } from 'node:http';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

test('Inbox triage keeps keyboard focus near the handled notification', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
	const model = { provider: 'custom-inbox-fixture', model: 'inbox-fixture' };
	await using server = createServer((request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		const reply = { id: 'inbox-reply', choices: [{ delta: { content: 'Inbox reply' }, finish_reason: 'stop' }] };
		response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing Inbox fixture address');
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const foreground = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
	const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
	let foregroundId: string;
	try {
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'inbox-provider', expectedRevision: config.revision,
			config: {
				connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Inbox fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [model.model]: { contextWindow: 272_000 } },
			},
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: model.provider, apiKey: 'isolated-fixture-key' });
		const create = async (title: string) => (await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: `create-${title}`, kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory },
		})).session;
		foregroundId = (await create('Foreground conversation')).sessionId;
		await page.locator(`.ash-sessions-list [data-item="session:${foregroundId}"] .ash-sessions-list-item`).press('Enter');
		await expect(foreground).toHaveAttribute('data-session-id', foregroundId);
		for (const title of ['Oldest reply', 'Middle reply', 'Newest reply']) {
			const { sessionId, threads } = await create(title);
			const { threadId } = threads[0]!;
			const { thread } = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: `turn-${title}`, sessionId,
				request: { type: 'startTurn', threadId, expectedSequence: thread.sequence, approvalMode: 'manual', model, input: [{ type: 'text', text: title }] },
			});
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
		}
	} finally {
		await close();
	}

	const trigger = page.getByRole('button', { name: /Inbox, sessions needing attention: 3/u });
	await trigger.press('Enter');
	const inbox = page.getByRole('dialog', { name: 'Inbox', exact: true });
	const row = (title: string) => inbox.getByRole('button', { name: `${title} Unread reply`, exact: true });
	await expect(row('Newest reply')).toBeFocused();
	await row('Middle reply').press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Mark Session Done', exact: true }).press('Enter');
	await expect(row('Middle reply')).toHaveCount(0);
	await expect(row('Oldest reply')).toBeFocused();

	await row('Oldest reply').press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Dismiss Notification', exact: true }).press('Enter');
	await expect(row('Newest reply')).toBeFocused();
	await row('Newest reply').press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Put Session on Hold', exact: true }).press('Enter');
	await expect(inbox).toContainText('No conversations need your attention.');
	await expect(inbox).toBeFocused();
	await expect(foreground).toHaveAttribute('data-session-id', foregroundId);
});
