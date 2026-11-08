import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { readStorageEntries } from '../../../automation/storage.js';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { StorageScope } from '../../../../src/ash/platform/storage/common/storage.js';
import type { ISessionGridState } from '../../../../src/ash/sessions/services/sessions/browser/sessionGridState.js';
import { APP_SERVER_METHODS, APPROVAL_MODE_DEFINITIONS } from '../../../../.build/protocol/typescript/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { connectProfile } from './sessionProfileFixture.js';

const run = promisify(execFile);
test.use({ gitRepository: true, video: 'on' });

test('First sends bind independent named worktrees, preserve failed drafts and restore their directories', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, target, testWorkspace, workbench }, testInfo) => {
	test.setTimeout(240_000);
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const sourceHead = await git('rev-parse', 'HEAD');
	// Dirty source content must survive both provisioning and Agent execution.
	await writeFile(testWorkspace.file, 'const value = 17;\n');
	const sourceStatus = await git('status', '--porcelain');
	const provider = 'custom-workspace-first-send';
	const model = { provider, model: 'workspace-first-send' };
	const sent = new Set<string>();
	const requests: unknown[] = [];
	let releaseFirst!: () => void;
	const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			requests.push(body);
			const marker = ['workspace-a', 'workspace-b', 'workspace-retry'].find(marker => body.messages?.some((message: { role: string; content: unknown; }) => message.role === 'user' && JSON.stringify(message.content).includes(marker)));
			if (!marker) throw new Error('Unexpected fixture prompt');
			const call = !sent.has(marker);
			sent.add(marker);
			if (marker === 'workspace-a' && call) await firstResponse;
			// Relative dot deliberately lets the real tool runtime choose its directory.
			const script = `require('node:fs').writeFileSync('agent.txt', ${JSON.stringify('Checkout marker\n' + marker)}); console.log(JSON.stringify({cwd:process.cwd(),branch:require('node:child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()}));`;
			const delta = call ? { tool_calls: [{ index: 0, id: marker, type: 'function', function: { name: 'shell-command', arguments: JSON.stringify({ program: process.execPath, arguments: ['-e', script], working_directory: '.' }) } }] } : { content: `${marker} complete\n\nSee [Checkout marker](agent.txt#L2) or agent.txt:2.` };
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: marker, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.end(chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
		} catch (error) {
			response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, cwd, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		let config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'workspace-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Workspace first-send fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'workspace-default-model', expectedRevision: config.revision, model });
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], { commandId: 'workspace-shell-policy', expectedRevision: config.revision, rule: { id: 'workspace-shell', selector: { type: 'source', source: 'built_in_tool', sourceId: 'shell-command' }, effect: { type: 'allowUnsandboxed' }, justification: 'Writes only synthetic files in this isolated smoke profile.' } });
		let page = await workbench.openAgentsWindow(target.kind);
		const code = async () => page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await code();
		const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		const workspace = () => active().locator('.ash-sessions-workspace-picker');
		const worktreeToggle = () => page.getByRole('menuitemcheckbox', { name: 'New worktree', exact: true });
		const expectWorktreeEnabled = async () => {
			await workspace().press('Enter');
			await expect(worktreeToggle()).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
		};
		const draft = async (marker: string) => {
			const previousId = await active().getAttribute('data-untitled-session-id');
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			await expect(active()).toHaveAttribute('data-untitled-session-id', /.+/u);
			if (previousId) await expect(active()).not.toHaveAttribute('data-untitled-session-id', previousId);
			const id = (await active().getAttribute('data-untitled-session-id'))!;
			await new Editor(active()).waitForEditorFocus();
			await page.keyboard.insertText(marker);
			await workspace().press('Enter');
			// The saved project and its matching local folder can both appear in the picker.
			await page.getByRole('menuitemradio', { name: basename(cwd), exact: true }).first().click();
			await expect(workspace()).toHaveText(basename(cwd));
			await workspace().press('Enter');
			await expect(worktreeToggle()).toHaveAttribute('aria-checked', 'false');
			await worktreeToggle().click();
			await expect(worktreeToggle()).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');

			// The picker generates the branch name. Read the saved draft to inject failures at its exact Git ref.
			let branch: string | undefined;
			await expect.poll(async () => {
				const stored = (await readStorageEntries(application, page, { scope: StorageScope.WORKSPACE, id: 'sessions' }))['sessions.viewState'];
				const state: ISessionGridState | undefined = stored && JSON.parse(stored.value);
				branch = state?.drafts.find(draft => draft.untitledSessionId === id)?.branchName;
				return branch;
			}).toMatch(/^ash\/[a-f0-9-]+$/u);
			return { id, branch: branch!, marker };
		};
		const select = async (id: string) => page.locator('.ash-sessions-list').locator(`[data-item="${id}"] .ash-sessions-list-item`).click();
		const first = await draft('workspace-a');
		const second = await draft('workspace-b');
		expect(first.branch).not.toBe(second.branch);
		expect(await git('branch', '--list', first.branch, second.branch)).toBe('');
		page = await workbench.reopenAgentsWindow(application, page);
		await code();
		const send = async ({ id, branch, marker }: Awaited<ReturnType<typeof draft>>) => {
			await select(`untitled:${id}`);
			await expect(active()).toHaveAttribute('data-untitled-session-id', id);
			await expectWorktreeEnabled();
			await new Editor(active()).waitForEditorContents(text => text === marker);
			await active().locator('.ash-chat-input-mode-action').click();
			await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true }).press('Enter');
			await active().getByRole('button', { name: /^Permissions:/ }).click();
			const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions')!;
			await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
			await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: bypass.label.english, exact: true }).click();
			await new Editor(active()).input.press('Enter');
			await expect(active()).toHaveAttribute('data-thread-id', /.+/u);
			const sessionId = await active().getAttribute('data-session-id');
			const threadId = await active().getAttribute('data-thread-id');
			if (!sessionId || !threadId) throw new Error('Missing durable identity');
			return { sessionId, threadId, branch, marker };
		};
		const a = await send(first);
		await expect.poll(() => sent.has('workspace-a')).toBe(true);
		// Hold A's model response until B is created, so execution follows a real switch.
		const b = await send(second);
		releaseFirst();
		expect(a.sessionId).not.toBe(b.sessionId);
		expect(a.threadId).not.toBe(b.threadId);
		const verify = async (identity: typeof a) => {
			const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], identity);
			await expect.poll(async () => (await read()).thread.turns.at(-1)?.status, { timeout: 90_000 }).toBe('completed');
			const result = await read();
			if (result.directory?.type !== 'local') throw new Error('Missing local execution directory');
			const root = result.directory.root;
			expect(root).not.toBe(cwd);
			expect((await run('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe(identity.branch);
			expect(await readFile(join(root, 'agent.txt'), 'utf8')).toBe('Checkout marker\n' + identity.marker);
			expect(result.thread.turns.at(-1)?.directory).toEqual({ type: 'local', root });
			expect(await readFile(join(root, 'main.ts'), 'utf8')).toBe('const value = 17;\n');
			const tool = result.thread.turns.flatMap(turn => turn.items).find(item => item.type === 'toolResult' && item.toolCallId === identity.marker);
			expect(tool).toMatchObject({ type: 'toolResult', isError: false });
			expect(JSON.stringify(tool)).toContain(root);
			expect(JSON.stringify(tool)).toContain(identity.branch);
			const catalog = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: identity.sessionId })).session;
			// The catalog retains the source target; each Thread owns its actual checkout.
			expect(catalog?.executionTarget).toEqual({ type: 'local', root: cwd });
			return root;
		};
		const rootA = await verify(a);
		const rootB = await verify(b);
		expect(rootA).not.toBe(rootB);
		const inventory = await git('worktree', 'list', '--porcelain');
		expect(inventory).toContain(`worktree ${rootA}\n`);
		expect(inventory).toContain(`worktree ${rootB}\n`);
		page = await workbench.reopenAgentsWindow(application, page);
		await code();
		for (const identity of [a, b]) {
			await select(`session:${identity.sessionId}`);
			await expect(active()).toHaveAttribute('data-thread-id', identity.threadId);
			const root = identity === a ? rootA : rootB;
			const status = active().locator('.ash-session-workspace-status');
			await expect(status).toHaveText(basename(cwd));
			await expect(status).toHaveAttribute('title', root);
			expect(await verify(identity)).toBe(root);
			const explicit = active().getByRole('link', { name: 'Checkout marker', exact: true });
			const plainTextReference = active().getByRole('link', { name: 'agent.txt:2', exact: true });
			const target = URI.file(join(root, 'agent.txt'));
			await expect(explicit).toHaveAttribute('href', target.with({ fragment: 'L2' }).toString());
			await expect(plainTextReference).toHaveAttribute('href', target.with({ fragment: 'L2,1' }).toString());
			await (identity === a ? explicit : plainTextReference).press('Enter');
			const editor = new Editor(page.locator('.ash-editor-group:visible'));
			await editor.waitForEditorContents(contents => contents === `Checkout marker\n${identity.marker}`);
			await expect(editor.element.locator('.view-overlays .view-overlay-line[data-line-index="1"] .current-line-exact')).toBeVisible();
		}

		// Both failures happen after selection, at the real Git provisioning boundary.
		const failed = await draft('workspace-retry');
		const traffic = requests.length;
		const sessions = async () => (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.map(session => session.sessionId).sort();
		const beforeFailure = await sessions();
		const expectFailedDraft = async (id: string) => {
			await new Editor(active()).input.press('Enter');
			await expect(active().getByRole('region', { name: 'CoreOperationFailed', exact: true })).toBeVisible();
			await expect(workspace()).toBeEnabled();
			await expect(active()).toHaveAttribute('data-untitled-session-id', id);
			await new Editor(active()).waitForEditorContents(text => text === 'workspace-retry');
			expect(await git('worktree', 'list', '--porcelain')).toBe(inventory);
			expect(requests).toHaveLength(traffic);
			expect(await sessions()).toEqual(beforeFailure);
		};
		const occupiedRef = `${failed.branch}/occupied`;
		await git('branch', occupiedRef);
		try {
			await expectFailedDraft(failed.id);
			await expectWorktreeEnabled();
		} finally { await git('branch', '-D', occupiedRef); }
		const locked = await draft('workspace-retry');
		await expect(active().getByRole('region', { name: 'CoreOperationFailed', exact: true })).toHaveCount(0);
		const lock = join(cwd, '.git', 'refs', 'heads', `${locked.branch}.lock`);
		await writeFile(lock, 'synthetic lock');
		try {
			await expectFailedDraft(locked.id);
			expect(await git('branch', '--list', locked.branch)).toBe('');
		} finally { await rm(lock, { force: true }); }
		// Retry the same draft after repairing the Git ref.
		const retry = await send(locked);
		await verify(retry);
		await verify(a);
		await verify(b);
		await select(`untitled:${failed.id}`);
		await expectWorktreeEnabled();
		await new Editor(active()).waitForEditorContents(text => text === 'workspace-retry');
		expect(await git('branch', '--show-current')).toBe('main');
		expect(await git('rev-parse', 'HEAD')).toBe(sourceHead);
		expect(await git('status', '--porcelain')).toBe(sourceStatus);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 17;\n');
		await expect(readFile(join(cwd, 'agent.txt'))).rejects.toThrow(/ENOENT/u);
		const trustConnection = await connectProfile(application, webAppServer, cwd, page, { directoryGrantsHost: true });
		try {
			const trust = trustConnection.client;
			const readGrant = (path: string) => trust.request(APP_SERVER_METHODS['config/directoryGrants/read'], { path });
			const config = await trust.request(APP_SERVER_METHODS['config/read'], {});
			const grant = await trust.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
				path: cwd, expectedRevision: config.revision, commandId: 'worktree-trust-source',
				permissions: [...DEVELOPMENT_DIR_PERMISSIONS],
			});
			const source = await readGrant(cwd);
			for (const root of [rootA, rootB]) {
				const inherited = await readGrant(root);
				expect(inherited.permissions).toBeFalsy();
				expect(inherited.inheritedWorkspacePermissions).toEqual(source.permissions);
			}
			await trust.request(APP_SERVER_METHODS['config/directoryGrants/forget'], {
				dir: source.dir, expectedRevision: grant.revision, commandId: 'worktree-trust-revoke',
			});
			expect((await readGrant(rootA)).inheritedWorkspacePermissions).toBeFalsy();
			expect((await readGrant(rootB)).inheritedWorkspacePermissions).toBeFalsy();
		} finally {
			await trustConnection.close();
		}
		await testInfo.attach('worktree-identities.json', { body: JSON.stringify({ a: { ...a, root: rootA }, b: { ...b, root: rootB }, inventory, sourceHead, sourceStatus }, null, 2), contentType: 'application/json' });
		await page.screenshot({ path: testInfo.outputPath('first-send-worktrees.png') });
	} finally {
		releaseFirst();
		await testInfo.attach('model-requests.json', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
