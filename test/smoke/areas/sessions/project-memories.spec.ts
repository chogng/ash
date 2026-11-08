import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath } from 'node:fs/promises';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

test.use({ gitRepository: true, electronUserSettings: { 'workbench.locale': 'zh-CN' } });

test('Project memory saved from a prompt is cited in another worktree', { tag: ['@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	test.setTimeout(120_000);
	const note = '演示统一使用紫色样本。';
	const followUp = '按之前说的处理。';
	const provider = 'custom-memory-fixture';
	const model = { provider, model: 'memory-fixture' };
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const input = Buffer.concat(chunks).toString('utf8');
		const reference = input.includes(note) ? input.match(/memory:[A-Za-z0-9_-]+/u)?.[0] : undefined;
		const content = reference ? `会使用紫色样本。 ${reference}` : '已收到。';
		const chunk = (delta: object, finish_reason: 'stop' | null) => `data: ${JSON.stringify({ id: 'memory-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(chunk({ content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const directory = await realpath(testWorkspace.directory);
		connection = await connectProfile(application, undefined, directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		const initialConfig = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: randomUUID(), expectedRevision: initialConfig.revision,
			config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Project memory fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [model.model]: { contextWindow: 272_000 } },
			},
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: randomUUID(), expectedRevision: config.revision, model });
		const createProject = async (name: string) => {
			const projectId = randomUUID();
			await client.request(APP_SERVER_METHODS['project/create'], {
				commandId: randomUUID(), projectId, name, description: '', scope: 'code', materials: [],
			});
			return projectId;
		};
		const projectId = await createProject('Memory fixture');
		const create = async (title: string, branchName: string, project = projectId) => {
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: randomUUID(), kind: 'code', title, agent: { type: 'default' },
				executionTarget: { type: 'local', root: directory }, branchName,
			});
			const threadId = session.threads[0]?.threadId;
			if (!threadId) throw new Error('Missing root thread');
			const { project: current } = await client.request(APP_SERVER_METHODS['project/read'], { projectId: project });
			await client.request(APP_SERVER_METHODS['project/session/link'], {
				commandId: randomUUID(), projectId: project, expectedRevision: current.revision, sessionId: session.sessionId,
			});
			return { sessionId: session.sessionId, threadId };
		};
		const first = await create('First worktree', 'ash/memory-first');
		const second = await create('Second worktree', 'ash/memory-second');
		const read = (identity: typeof first) => client.request(APP_SERVER_METHODS['session/thread/read'], identity);
		const turn = async (identity: typeof first, text: string) => {
			const { thread } = await read(identity);
			await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: randomUUID(), sessionId: identity.sessionId,
				request: { type: 'startTurn', threadId: identity.threadId, expectedSequence: thread.sequence, input: [{ type: 'text', text }], toolMode: 'direct', mode: 'agent' },
			});
			await expect.poll(async () => (await read(identity)).thread.turns.at(-1)?.status).toBe('completed');
		};
		await turn(first, note);

		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		const select = (identity: typeof first) => page.locator(`[data-item="session:${identity.sessionId}"] .ash-sessions-list-item`).click();
		const active = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		await select(first);
		const row = active.locator('.ash-chat-user-message').filter({ hasText: note });
		await row.hover();
		await row.locator('[data-action-id="ash.toolbar.moreActions"] button').press('Enter');
		await page.getByRole('menuitem', { name: '保存为项目记忆', exact: true }).click();

		const memories = page.locator('.ash-memories:visible');
		const title = memories.getByRole('textbox', { name: '记忆标题', exact: true });
		await expect(title).toBeFocused();
		await expect(memories.getByRole('textbox', { name: '记忆内容', exact: true })).toHaveValue(note);
		await title.fill('演示样本');
		await memories.getByRole('button', { name: '保存记忆', exact: true }).press('Enter');
		await expect(memories.getByRole('status')).toHaveText('记忆已保存。');
		await memories.getByRole('checkbox', { name: '启用 Code 模型记忆', exact: true }).check();
		await memories.getByRole('checkbox', { name: '允许读取记忆', exact: true }).check();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['memory/policy/read'], { scope: { type: 'project', projectId } })).automaticRead).toBe('firstInvocation');

		const firstDirectory = (await read(first)).directory;
		const secondDirectory = (await read(second)).directory;
		expect(firstDirectory?.type).toBe('local');
		expect(secondDirectory?.type).toBe('local');
		expect(secondDirectory).not.toEqual(firstDirectory);
		await select(second);
		await turn(second, followUp);
		await active.getByRole('button', { name: '打开记忆引用 1', exact: true }).press('Enter');
		await expect(memories.getByRole('textbox', { name: '记忆内容', exact: true })).toHaveValue(note);
		await memories.getByRole('button', { name: '打开来源对话', exact: true }).press('Enter');
		await expect(active).toHaveAttribute('data-thread-id', first.threadId);

		const expectNoRecall = async (identity: typeof first) => {
			await turn(identity, followUp);
			const items = (await read(identity)).thread.turns.at(-1)?.items ?? [];
			expect(items.filter(item => item.type === 'agentMessage').map(item => item.text).join('')).toBe('已收到。');
		};
		const outside = await create('Outside project', 'ash/memory-outside', await createProject('Other project'));
		await expectNoRecall(outside);

		const { session: chat } = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: randomUUID(), kind: 'chat', title: 'Chat fixture', agent: { type: 'default' }, executionTarget: null,
		});
		const chatThreadId = chat.threads[0]?.threadId;
		if (!chatThreadId) throw new Error('Missing Chat thread');
		const { project } = await client.request(APP_SERVER_METHODS['project/read'], { projectId });
		await client.request(APP_SERVER_METHODS['project/session/link'], {
			commandId: randomUUID(), projectId, expectedRevision: project.revision, sessionId: chat.sessionId,
		});
		expect((await client.request(APP_SERVER_METHODS['memory/scopes'], { threadId: chatThreadId })).scopes).toEqual([]);
		await expectNoRecall({ sessionId: chat.sessionId, threadId: chatThreadId });

		const scope = { type: 'project', projectId } as const;
		const saved = (await client.request(APP_SERVER_METHODS['memory/list'], { scope })).memories[0]!;
		await client.request(APP_SERVER_METHODS['memory/delete'], {
			commandId: randomUUID(), scope, memoryId: saved.memoryId, expectedRevision: saved.revision,
		});
		await expectNoRecall(await create('After deletion', 'ash/memory-deleted'));
	} finally {
		try { await connection?.close(); }
		finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}
});
