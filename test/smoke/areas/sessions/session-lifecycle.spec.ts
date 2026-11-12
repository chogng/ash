import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { directoryPermissionPrompt } from '../../../automation/dialogs.js';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { APP_SERVER_METHODS, type ModelRef } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile, enableFixtureModel } from './sessionProfileFixture.js';

test('Open IDE opens the selected Code thread in its working folder', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
	if (!('windows' in application)) throw new Error('Open IDE requires Electron');
	const directory = join(testWorkspace.directory, 'conversation-project');
	await mkdir(directory);
	const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
	try {
		const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'open-in-ide-session', kind: 'code', title: 'IDE handoff fixture', agent: { type: 'default' },
			executionTarget: { type: 'local', root: directory },
		});
		const branch = await client.request(APP_SERVER_METHODS['session/request'], {
			commandId: 'open-in-ide-branch', sessionId: session.sessionId,
			request: { type: 'forkThread', parentThreadId: session.threads[0]!.threadId, title: 'Thread to open in IDE' },
		});
		if (branch.type !== 'thread') throw new Error('Expected a persisted fork Thread');
		const threadId = branch.value.threadId;
		const thread = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: session.sessionId, threadId });
		if (thread.directory?.type !== 'local') throw new Error('Expected a local working directory for the branch');
		await writeFile(join(thread.directory.root, 'conversation-worktree.txt'), 'This file belongs to the selected thread.');
		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const sessionRow = agents.locator(`[data-item="session:${session.sessionId}"] > .ash-sessions-list-item`);
		await sessionRow.press('ArrowRight');
		await agents.locator('.ash-sessions-list').getByRole('treeitem', { name: /^Thread to open in IDE\b/u }).locator('.ash-sessions-list-item').click();
		const source = agents.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(source).toHaveAttribute('data-thread-id', threadId);
		const openIde = agents.locator('.ash-sessions-titlebar-right').getByRole('button', { name: 'Open IDE', exact: true });
		const opened = application.waitForEvent('window');
		await openIde.click();
		const destination = await opened;
		const permission = directoryPermissionPrompt(destination);
		await expect(permission).toContainText(thread.directory.root);
		await permission.getByRole('button', { name: 'Trust Folder', exact: true }).click();
		const ide = new Workbench(destination);
		await ide.waitForReady();
		const chat = destination.locator('.ash-chat-view-pane .ash-chat:visible');
		await expect(chat).toHaveAttribute('data-session-id', session.sessionId);
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		await ide.openExplorer();
		await expect(destination.locator('[data-part="sidebar"]').getByText('conversation-worktree.txt', { exact: true })).toBeVisible();
		await expect(source).toHaveAttribute('data-thread-id', threadId);
		await ide.quickaccess.runCommand('workbench.action.chat.newChat');
		await expect(chat).not.toHaveAttribute('data-thread-id', threadId);
		await openIde.click();
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
	} finally {
		await close();
	}
});

async function chooseWorkspaceProject(page: Page, directory: string): Promise<void> {
	const chooser = page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker');
	const folder = basename(directory);
	await chooser.click();
	await page.getByRole('menuitemradio', { name: folder, exact: true }).click();
	await expect(chooser).toHaveText(folder);
}

test('Ash Chat opens persisted fork Threads from its sidebar tree', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
	const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
	try {
		const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'sidebar-fork-origin', kind: 'chat', title: 'Native fork origin', agent: { type: 'default' }, executionTarget: null,
		});
		const { sessionId } = session;
		const root = session.threads[0]!.threadId;
		const fork = async (parentThreadId: string, title: string) => {
			const result = await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: title, sessionId, request: { type: 'forkThread', parentThreadId, title },
			});
			if (result.type !== 'thread') throw new Error('Expected a persisted fork Thread');
			return result.value.threadId;
		};
		const child = await fork(root, 'First native fork');
		const grandchild = await fork(child, 'Nested native fork');
		const page = await workbench.openAgentsWindow(target.kind);
		const sidebar = page.locator('[data-view-container-id="sessions.chatgpt.navigation"]');
		const original = sidebar.locator(`[data-item="ash:${sessionId}"]`);
		const title = original.getByRole('button', { name: 'Native fork origin', exact: true });
		const branches = original.getByRole('button', { name: 'Conversation branches', exact: true });
		const nested = sidebar.getByRole('button', { name: 'Nested native fork', exact: true });
		const chat = page.locator('.ash-native-chat-widget .ash-chat');
		await expect(original.locator('[data-ash-icon-id="chat-session"]')).toBeVisible();
		await expect(nested).toHaveCount(0);
		await title.press('ArrowRight');
		await expect(branches).toHaveAttribute('aria-expanded', 'true');
		await nested.click();
		await expect(chat).toHaveAttribute('data-thread-id', grandchild);
		const parent = sidebar.getByRole('button', { name: 'Forked from: First native fork', exact: true });
		await expect(parent.locator('[data-ash-icon-id="fork"]')).toBeVisible();
		await parent.click();
		await expect(chat).toHaveAttribute('data-thread-id', child);
		await sidebar.getByRole('button', { name: 'Forked from: Native fork origin', exact: true }).click();
		await expect(chat).toHaveAttribute('data-thread-id', root);
		await title.press('ArrowLeft');
		await expect(nested).toHaveCount(0);
	} finally {
		await close();
	}
});

test('Agents reload restores the live terminal for the selected session', { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }) => {
	const { client, close } = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
	try {
		const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'agents-terminal-reload', kind: 'code', title: 'Terminal reload fixture', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator(`[data-item="session:${session.sessionId}"] > .ash-sessions-list-item`).click();
		const active = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(active).toHaveAttribute('data-thread-id', session.threads[0]!.threadId);
		const commands = new QuickAccess(page);
		await commands.runCommand('ash.sessions.togglePanel');
		const terminal = page.locator('.ash-terminal-editor:visible');
		const input = terminal.locator('.xterm-helper-textarea');
		const rows = terminal.locator('.xterm-rows');
		await input.focus();
		await input.pressSequentially(`node -p "'AGENTS_PTY_' + process.ppid"`);
		await input.press('Enter');
		await expect(rows).toContainText(/AGENTS_PTY_\d+/u);
		const pid = (await rows.textContent())!.match(/AGENTS_PTY_(\d+)/u)![1];
		const loaded = page.waitForEvent('domcontentloaded');
		await commands.runCommand('workbench.action.reloadWindow');
		await loaded;
		await expect(active).toHaveAttribute('data-thread-id', session.threads[0]!.threadId);
		await expect(rows).toContainText(`AGENTS_PTY_${pid}`);
		await input.focus();
		await input.pressSequentially(`node -p "'AFTER_RELOAD_' + process.ppid"`);
		await input.press('Enter');
		await expect(rows).toContainText(`AFTER_RELOAD_${pid}`);
	} finally {
		await close();
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`Session first send uses one atomic root and restores drafts in ${locale}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
		test.setTimeout(240_000);
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const copy = locale === 'zh-CN' ? { code: '代码', picker: '选择聊天模型', auto: '自动' } : { code: 'Code', picker: 'Choose a chat model', auto: 'Auto' };
		const invokedModels: string[] = [];
		const modelServer = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ data: [{ id: 'lifecycle-model' }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; };
			invokedModels.push(body.model);
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end('data: {"id":"lifecycle-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Isolated lifecycle answer"},"finish_reason":null}]}\n\ndata: {"id":"lifecycle-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		let page: Page | undefined;
		try {
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
			const { client } = connection;
			const address = modelServer.address();
			if (!address || typeof address === 'string') throw new Error('Lifecycle model fixture has no port');
			const provider = 'custom-session-lifecycle-fixture';
			const model: ModelRef = { provider, model: 'lifecycle-model' };
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'lifecycle-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Isolated lifecycle model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { 'lifecycle-model': { contextWindow: 272_000 } },
				}
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
			const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'lifecycle-default', expectedRevision: configured.revision, model });
			await enableFixtureModel(workbench, model, locale);

			let agentsWorkbench = workbench;
			if (target.kind === 'browser') {
				// Keep the independent verification connection in the original Workbench realm.
				const source = await workbench.page.context().newPage();
				await source.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
				agentsWorkbench = new Workbench(source);
				await agentsWorkbench.waitForReady();
			}
			page = await agentsWorkbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: copy.code, exact: true }).click();
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			await chooseWorkspaceProject(page, testWorkspace.directory);
			const active = (): ReturnType<Page['locator']> => page!.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
			const editor = new Editor(active());
			await editor.waitForEditorFocus();
			await editor.waitForTypeInEditor('Return the isolated lifecycle answer without using tools.');
			await active().locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
			const automatic = picker.getByRole('switch', { name: copy.auto, exact: true });
			if (await automatic.isChecked()) await automatic.press('Space');
			await expect(automatic).not.toBeChecked();
			const search = picker.getByRole('combobox');
			await search.fill(model.model);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await search.press('Enter');
			await editor.waitForEditorFocus();
			await page.keyboard.press('Enter');
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.length).toBe(1);
			const created = (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions[0]!;
			// Inspect the product-created Session, not a fixture-created backend Session.
			expect(created.threads).toHaveLength(1);
			const root = created.threads[0]!;
			expect(root.parentThreadId).toBeFalsy();
			await expect(active()).toHaveAttribute('data-thread-id', root.threadId);
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: created.sessionId, threadId: root.threadId })).thread.turns.at(-1)?.status).toBe('completed');
			expect(invokedModels.length).toBeGreaterThan(0);
			expect(invokedModels.every(invoked => invoked === model.model)).toBe(true);
			await expect(active()).toContainText('Isolated lifecycle answer');

			await page.locator('[data-action-id="sessions.newSession"] button').click();
			await expect(active()).toHaveAttribute('data-untitled-session-id', /.+/u);
			const draftId = await active().getAttribute('data-untitled-session-id');
			const draftEditor = new Editor(active());
			await draftEditor.waitForEditorFocus();
			await draftEditor.waitForTypeInEditor('Keep this unsent lifecycle draft.');
			page = await agentsWorkbench.reopenAgentsWindow(application, page);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: copy.code, exact: true }).click();
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
			const readCatalog = async () => (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: created.sessionId })).session;
			const persisted = await readCatalog();
			expect(persisted?.threads).toHaveLength(1);
			const durableRows = (): ReturnType<Page['locator']> => page!.locator('[data-item^="session:"] > .ash-sessions-list-item');
			await expect(durableRows()).toHaveCount(1);
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'lifecycle-archive', sessionId: created.sessionId, request: { type: 'archive' } });
			await expect.poll(async () => (await readCatalog())?.status).toBe('archived');
			await expect(durableRows()).toHaveCount(0);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'lifecycle-restore', sessionId: created.sessionId, request: { type: 'restore' } });
			await expect.poll(async () => (await readCatalog())?.status).toBe('active');
			await expect(durableRows()).toHaveCount(1);
			const restored = await readCatalog();
			expect(restored?.threads).toHaveLength(1);
			expect(restored?.threads[0]?.threadId).toBe(root.threadId);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'lifecycle-stop', sessionId: created.sessionId, request: { type: 'stop' } });
			await expect.poll(async () => (await readCatalog())?.status).toBe('archived');
			await expect(durableRows()).toHaveCount(0);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
			await writeFile(testInfo.outputPath('lifecycle-evidence.json'), JSON.stringify({ locale, created: persisted, restored, stopped: await readCatalog(), invokedModels, restoredDraftId: draftId }, null, 2));
			await page.screenshot({ path: testInfo.outputPath('restored-lifecycle.png') });
		} finally {
			try { await connection?.close(); }
			finally {
				modelServer.closeAllConnections();
				await new Promise<void>(resolve => modelServer.close(() => resolve()));
			}
		}
	});
}

test('Agents title bar replaces the first-message preview and /recap saves a conversation recap', { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }) => {
	const provider = 'custom-thread-title-fixture';
	const model = { provider, model: 'conversation-fixture' };
	const titleModel = { provider, model: 'title-fixture' };
	const recapModel = { provider, model: 'recap-fixture' };
	const firstMessage = 'Handle empty inputs in the parser and verify the fix.';
	const shortTitle = 'Handle empty parser inputs';
	const recap = 'The parser now handles empty inputs.';
	let releaseRecap!: () => void;
	const recapGate = new Promise<void>(resolve => { releaseRecap = resolve; });
	let releaseTitle!: () => void;
	const titleGate = new Promise<void>(resolve => { releaseTitle = resolve; });
	const invocations: string[] = [];
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }, { id: titleModel.model }, { id: recapModel.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; };
		invocations.push(body.model);
		const generatingTitle = body.model === titleModel.model;
		if (generatingTitle) await titleGate;
		const generatingRecap = body.model === recapModel.model;
		if (generatingRecap) await recapGate;
		const content = generatingTitle ? shortTitle : generatingRecap ? recap : 'Parser fixture complete';
		if (body.stream) {
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'title-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { 'content-type': 'text/event-stream' }).end(chunk({ content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
		} else {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'title-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Title model fixture has no port');
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'title-provider', expectedRevision: config.revision, config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Title fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: Object.fromEntries([model, titleModel, recapModel].map(({ model }) => [model, { contextWindow: 272_000 }])),
			},
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-title-key' });
		const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
		expect(configured.threadRecapEnabled).toBe(false);
		await client.request(APP_SERVER_METHODS['config/update'], {
			commandId: 'title-models', expectedRevision: configured.revision, model, threadTitleModel: titleModel, threadRecapModel: recapModel,
		});

		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await chooseWorkspaceProject(page, testWorkspace.directory);
		const active = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		const editor = new Editor(active);
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor(firstMessage);
		await page.keyboard.press('Enter');
		await expect(active).toHaveAttribute('data-thread-id', /.+/u);
		const title = page.locator('.ash-sessions-titlebar-title');
		await expect(title).toHaveText(firstMessage);
		await expect.poll(() => invocations.filter(id => id === titleModel.model)).toHaveLength(1);
		releaseTitle();
		await expect(title).toHaveText(shortTitle);
		const readSession = async () => (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.find(session => session.title === shortTitle);
		const threadId = await active.getAttribute('data-thread-id');
		await expect(active.getByText('Parser fixture complete', { exact: true })).toBeVisible();
		expect(invocations).not.toContain(recapModel.model);
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor('/recap');
		await page.keyboard.press('Enter');
		await expect.poll(() => invocations.filter(id => id === recapModel.model)).toHaveLength(1);
		expect((await readSession())?.threads.find(thread => thread.threadId === threadId)?.recap).toBeUndefined();
		releaseRecap();
		await expect.poll(async () => (await readSession())?.threads.find(thread => thread.threadId === threadId)?.recap).toBe(recap);
		await new QuickAccess(page).runCommand('sessions.showConversationRecap');
		await expect(page.locator('.stanza-editor:visible .stanza-editor-line-text').filter({ hasText: recap })).toBeVisible();
	} finally {
		releaseTitle();
		releaseRecap();
		try { await connection?.close(); }
		finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}
});
