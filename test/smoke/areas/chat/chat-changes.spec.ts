import { writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';

test.use({ gitRepository: true });

test('Chat changes follow the selected conversation, history cursor and workspace', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }) => {
	test.setTimeout(180_000);
	const page = workbench.page;
	await writeFile(testWorkspace.file, 'const value = 1;\nworkspace only 1\nworkspace only 2\nworkspace only 3\n');
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	const client = connection.client;
	type Conversation = { sessionId: string; threadId: string; title: string };
	const identity = ({ sessionId, threadId }: Conversation) => ({ sessionId, threadId });
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const pill = chat.locator('.ash-chat-changes-pill');
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	const showSidebar = async () => {
		if (!(await sidebar.isVisible())) await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	};
	const create = async (title: string): Promise<Conversation> => {
		const created = await client.request(methods['session/create'], {
			commandId: title,
			title,
			agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		return { sessionId: created.session.sessionId, threadId: created.session.threads[0].threadId, title };
	};
	const open = async (conversation: Conversation) => {
		await showSidebar();
		await sidebar
			.locator('.ash-agent-session-row')
			.filter({ has: page.locator('.ash-agent-session-title', { hasText: conversation.title }) })
			.click();
		await expect(chat).toHaveAttribute('data-thread-id', conversation.threadId);
	};
	const summary = (conversation: Conversation) => client.request(methods['turnChanges/summary'], identity(conversation));
	const expectChanges = async (conversation: Conversation, additions: number) => {
		await expect.poll(async () => (await summary(conversation)).statistics, { timeout: 30_000 }).toEqual({ files: additions ? 1 : 0, additions, deletions: 0 });
		if (additions) await expect(pill).toHaveAttribute('aria-label', `Open Conversation Changes: 1 files, ${additions} lines added, 0 lines removed`);
		else await expect(pill).toBeHidden();
	};
	const shell = async (conversation: Conversation, command: string, commandId: string) => {
		const { thread } = await client.request(methods['session/thread/read'], identity(conversation));
		await client.request(methods['session/request'], {
			sessionId: conversation.sessionId,
			commandId,
			request: {
				type: 'startShellTurn',
				threadId: conversation.threadId,
				expectedSequence: thread.sequence,
				approvalMode: 'bypassPermissions',
				command,
				workingDirectory: '.',
			},
		});
		await expect.poll(async () => (await client.request(methods['session/thread/read'], identity(conversation))).thread.turns.at(-1)?.status, { timeout: 30_000 }).toBe('completed');
		await expect.poll(async () => (await client.request(methods['turnChanges/list'], identity(conversation))).changeSets.at(-1)?.captureState, { timeout: 30_000 }).toBe('sealed');
	};
	const move = async (conversation: Conversation, direction: 'undo' | 'redo') => {
		const history = await client.request(methods['session/thread/history'], identity(conversation));
		await client.request(methods['session/request'], {
			sessionId: conversation.sessionId,
			commandId: `${direction}-${history.sequence}`,
			request: {
				type: 'moveThreadHistory',
				threadId: conversation.threadId,
				expectedSequence: history.sequence,
				direction,
			},
		});
	};
	const openDiff = async (path: string, line: string) => {
		await pill.click();
		const editor = page.locator('.stanza-multi-diff-editor:visible');
		await expect(editor.getByRole('button', { name: new RegExp(path.replace('.', '\\.')) })).toBeVisible();
		await expect(editor).toContainText(line);
		return editor;
	};
	// Use the real shell/tool/checkpoint stack with deterministic content; no provider is needed in CI.
	const writeLines = (path: string, prefix: string, count: number) =>
		process.platform === 'win32' ? `for /L %i in (1,1,${count}) do @echo ${prefix} %i>>${path}` : `i=1; while [ "$i" -le ${count} ]; do printf '${prefix} %s\\n' "$i"; i=$((i+1)); done > ${path}`;
	try {
		if (!(await page.locator('.ash-chat-view-pane').isVisible())) await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		await expect(pill).toHaveAttribute('aria-label', 'Open Workspace Changes: 1 files, 3 lines added, 0 lines removed', { timeout: 30_000 });
		const a = await create('Conversation A');
		const b = await create('Conversation B');
		await open(a);
		await expectChanges(a, 0);
		await shell(a, writeLines('a.txt', 'A line', 120), 'a-120-lines');
		await expectChanges(a, 120);
		await openDiff('a.txt', 'A line 1');
		await open(b);
		await expectChanges(b, 0);
		await shell(b, writeLines('b.txt', 'B line', 7), 'b-seven-lines');
		await expectChanges(b, 7);
		await expect(await openDiff('b.txt', 'B line 1')).not.toContainText('a.txt');
		await open(a);
		await expectChanges(a, 120);
		await move(a, 'undo');
		await expectChanges(a, 0);
		await move(a, 'redo');
		await expectChanges(a, 120);
		await move(a, 'undo');
		await shell(a, writeLines('continued.txt', 'Continued line', 105), 'a-continued');
		await expectChanges(a, 105);
		expect((await summary(a)).repositories.flatMap(repository => repository.files.map(file => file.path))).toEqual(['continued.txt']);
		expect((await client.request(methods['session/thread/history'], identity(a))).canRedo).toBe(false);
		await expect(await openDiff('continued.txt', 'Continued line 1')).not.toContainText('a.txt');
		await open(b);
		await expectChanges(b, 7);
		await showSidebar();
		await sidebar.getByRole('button', { name: 'New Session', exact: true }).click();
		await expect(chat).not.toHaveAttribute('data-thread-id', /.+/);
		await expect(pill).toHaveAttribute('aria-label', 'Open Workspace Changes: 1 files, 3 lines added, 0 lines removed');
		const workspaceDiff = await openDiff('main.ts', 'workspace only 3');
		await expect(workspaceDiff).not.toContainText('continued.txt');
		await expect(workspaceDiff).not.toContainText('b.txt');
	} finally {
		await connection.close();
	}
});
