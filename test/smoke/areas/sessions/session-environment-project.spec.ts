import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { readStorageEntries } from '../../../automation/storage.js';
import { StorageScope } from '../../../../src/ash/platform/storage/common/storage.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile, enableFixtureModel } from './sessionProfileFixture.js';

const run = promisify(execFile);
test.use({ gitRepository: true, video: 'on' });

test('Reselecting a saved Worktree environment preserves the original Project through first send and restart', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, target, testWorkspace, workbench }, testInfo) => {
	test.setTimeout(180_000);
	const cwd = testWorkspace.directory;
	const checkout = join(cwd, '.git', 'environment-worktree');
	await run('git', ['worktree', 'add', '-b', 'environment-worktree', checkout, 'HEAD'], { cwd });
	const worktreeContent = 'const worktreeIdentity = 19;\n';
	await writeFile(join(checkout, 'main.ts'), worktreeContent);
	const provider = 'custom-environment-project';
	const model = { provider, model: 'environment-project' };
	let requests = 0;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		for await (const _chunk of request) { /* Drain the request before replying. */ }
		requests++;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'environment-project', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.end(chunk({ content: 'Environment project fixture complete.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, cwd, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		let config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'environment-project-provider', expectedRevision: config.revision,
			config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Environment project fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } },
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'environment-project-model', expectedRevision: config.revision, model });
		const { project } = await client.request(APP_SERVER_METHODS['project/create'], {
			commandId: 'environment-source-project', projectId: 'environment-source-project', scope: 'code',
			name: 'Original repository project', description: '',
			materials: [{ kind: 'folder', name: 'Repository', path: pathToFileURL(cwd).href }],
		});
		// An explicit competing Project makes a directory-based rematch observable.
		const { project: competing } = await client.request(APP_SERVER_METHODS['project/create'], {
			commandId: 'environment-worktree-project', projectId: 'environment-worktree-project', scope: 'code',
			name: 'Separate Worktree project', description: '',
			materials: [{ kind: 'folder', name: 'Worktree', path: pathToFileURL(checkout).href }],
		});
		await enableFixtureModel(workbench, model, 'en');
		let page = await workbench.openAgentsWindow(target.kind);
		const code = async () => page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await code();
		const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		const picker = () => active().locator('.ash-sessions-environment-picker');
		await active().locator('.ash-sessions-workspace-picker').click();
		await page.getByRole('menuitemradio', { name: project.name, exact: true }).click();
		await picker().click();
		await page.getByText('New Environment', { exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'New Environment', exact: true });
		await dialog.getByLabel('Name', { exact: true }).fill('Repository Worktree environment');
		const worktree = dialog.getByRole('button', { name: `Worktree for ${cwd}`, exact: true });
		await worktree.click();
		await page.getByRole('menuitem', { name: 'Choose Worktree…', exact: true }).click();
		await expect(dialog.locator('.ash-sessions-form-actions').locator('..')).not.toHaveAttribute('aria-busy', 'true');
		await worktree.click();
		await page.getByRole('menuitemradio', { name: 'environment-worktree', exact: true }).click();
		await dialog.getByRole('button', { name: 'Create environment', exact: true }).click();
		await page.getByRole('dialog', { name: 'Trust this workspace?', exact: true }).getByRole('button', { name: 'Trust and Open', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(picker()).toHaveText('Repository Worktree environment');
		const originalDraft = await active().getAttribute('data-untitled-session-id');
		const selectedProject = () => active().locator('.ash-sessions-workspace-picker');
		await expect(selectedProject()).toHaveText(project.name);
		await page.screenshot({ path: testInfo.outputPath('created-worktree-environment.png') });

		page = await workbench.reopenAgentsWindow(application, page);
		await code();
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(active()).not.toHaveAttribute('data-untitled-session-id', originalDraft!);
		await expect(picker()).toHaveText('This Computer');
		// Resolve from P again so an inherited W draft cannot mask a missing saved Project reference.
		await selectedProject().click();
		await page.getByRole('menuitemradio', { name: project.name, exact: true }).click();
		await picker().click();
		await page.getByRole('menuitemradio', { name: 'Repository Worktree environment', exact: true }).click();
		await expect(selectedProject()).toHaveText(project.name);
		await picker().click();
		await page.getByRole('menuitemradio', { name: 'Repository Worktree environment', exact: true }).click();
		await expect(selectedProject()).toHaveText(project.name);
		const activeDraft = await active().getAttribute('data-untitled-session-id');
		await expect.poll(async () => {
			const stored = (await readStorageEntries(application, page, { scope: StorageScope.WORKSPACE, id: 'sessions' }))['sessions.viewState'];
			const state = stored && JSON.parse(stored.value);
			return state?.drafts.find((draft: { untitledSessionId: string; }) => draft.untitledSessionId === activeDraft)?.workspace;
		}).toEqual({ type: 'local', root: checkout });
		await page.screenshot({ path: testInfo.outputPath('reselected-worktree-environment.png') });
		const editor = new Editor(active());
		await editor.input.focus();
		await page.keyboard.insertText('Verify the saved Worktree project identity.');
		await editor.input.press('Enter');
		await expect(active()).toHaveAttribute('data-thread-id', /.+/u);
		const sessionId = (await active().getAttribute('data-session-id'))!;
		const threadId = (await active().getAttribute('data-thread-id'))!;
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
		const result = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
		const catalog = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
		expect(catalog?.executionTarget).toEqual({ type: 'local', root: checkout });
		// Git Turns use their own managed checkout; its contents must come from W, not P.
		if (result.directory?.type !== 'local') throw new Error('Missing local Thread directory');
		expect(await readFile(join(result.directory.root, 'main.ts'), 'utf8')).toBe(worktreeContent);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
		expect(requests).toBeGreaterThan(0);
		const members = async (projectId: string) => (await client.request(APP_SERVER_METHODS['project/read'], { scope: 'code', projectId })).project.sessionIds;
		expect(await members(project.projectId)).toEqual([sessionId]);
		expect(await members(competing.projectId)).toEqual([]);
		page = await workbench.reopenAgentsWindow(application, page);
		await code();
		await expect(active()).toHaveAttribute('data-session-id', sessionId);
		expect(await members(project.projectId)).toEqual([sessionId]);
		expect(await members(competing.projectId)).toEqual([]);
		await page.screenshot({ path: testInfo.outputPath('restored-project-membership.png') });
		await testInfo.attach('worktree-project-result', {
			body: JSON.stringify({ source: cwd, selectedExecutionTarget: catalog?.executionTarget, threadDirectory: result.directory, sessionId, threadId, projectId: project.projectId, projectMembers: await members(project.projectId), competingProjectMembers: await members(competing.projectId) }, null, 2),
			contentType: 'application/json',
		});
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
