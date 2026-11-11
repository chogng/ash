import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
test.use({ gitRepository: true });

test('Changes explains the review and commit preview workflow before files arrive', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.agentSessions.action.viewChanges');
	const changes = page.locator('.ash-sessions-changes-editor:visible');
	await expect(changes.getByRole('tree')).toHaveCount(0);
	await changes.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Preview commit to select files and enter a commit message/u);
});

test('Turn file selection commits a reviewed file and keeps another Session separate', { tag: ['@electron-app-server'] }, async ({ target, application, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(120_000);
	if (!('evaluate' in application)) throw new Error('This scenario requires Electron');
	const host = await application.evaluate(({ app }) => ({
		appPath: app.getAppPath(), resourcesPath: process.resourcesPath, electronExecutable: process.execPath,
		profileRoot: process.env.ASH_HOME!, sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ASH_RG_PATH: process.env.ASH_RG_PATH, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH },
	}));
	const { launcher } = createAppServerDaemonLauncher({ ...host, packageLocation: { appPath: host.appPath, resourcesPath: host.resourcesPath, isPackaged: false, platform: process.platform }, workspaceRoot: testWorkspace.directory, role: 'agents' });
	await launcher.validate();
	const frames = new ChildProcessJsonlTransport(launcher.launch());
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emit = (event: string, payload: unknown): void => { for (const listener of listeners.get(event) ?? []) listener(payload); };
	const incoming = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
	const closed = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
	const client = new AppServerProtocolClient({
		on(event, listener) { let group = listeners.get(event); if (!group) listeners.set(event, group = new Set()); group.add(listener); },
		off(event, listener) { listeners.get(event)?.delete(listener); },
		send(event, payload) {
			if (event === WEB_APP_SERVER_CONNECT_EVENT) emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'turn-selection', workspaceRoot: testWorkspace.directory });
			else if (event === WEB_APP_SERVER_FRAME_EVENT) { void frames.send((payload as { frame: string; }).frame); }
			else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) throw new Error(`Unexpected transport event ${event}`);
		},
	});
	try {
		await client.connect();
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], { commandId: 'allow-turn-selection-shell', expectedRevision: config.revision, rule: { id: 'turn-selection-shell', selector: { type: 'source', source: 'built_in_tool', sourceId: 'shell-command' }, effect: { type: 'allowUnsandboxed' }, justification: 'The scenario writes only to its isolated temporary repositories.' } });
		const create = async (name: string, command: string): Promise<{ sessionId: string; threadId: string; }> => {
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], { commandId: `create-${name}`, kind: 'code', title: name, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const identity = { sessionId: session.sessionId, threadId: session.threads[0]!.threadId };
			const { thread } = await client.request(APP_SERVER_METHODS['session/thread/read'], identity);
			await client.request(APP_SERVER_METHODS['session/request'], { ...identity, commandId: `write-${name}`, request: { type: 'startShellTurn', threadId: identity.threadId, expectedSequence: thread.sequence, approvalMode: 'bypassPermissions', command, workingDirectory: '.' } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], identity)).changeSets[0]?.captureState).toBe('sealed');
			return identity;
		};
		const a = await create('Selected files A', process.platform === 'win32' ? 'echo const value = 42;>main.ts & echo remaining A>remaining.txt' : "printf 'const value = 42;\\n' > main.ts; printf 'remaining A\\n' > remaining.txt");
		const b = await create('Selected files B', process.platform === 'win32' ? 'echo separate B>other-session.txt' : "printf 'separate B\\n' > other-session.txt");
		const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: testWorkspace.directory })).stdout.trim();
		const initialHead = await git('rev-parse', 'HEAD');
		const changeB = (await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]!;
		const selectionB = { changeSetId: changeB.changeSetId, expectedRevision: changeB.revision, paths: ['other-session.txt'] };
		// Shared repository identity must never substitute for the capture's Session/Thread owner.
		await expect(client.request(APP_SERVER_METHODS['turnChanges/prepareCommit'], {
			...a, commandId: 'reject-cross-session-selection', selections: [selectionB], message: 'must not commit B as A',
		})).rejects.toMatchObject({ code: -32082, errorName: 'TurnChangesOperationFailed' });
		await expect(client.request(APP_SERVER_METHODS['turnChanges/prepareCommit'], {
			sessionId: a.sessionId, threadId: b.threadId, commandId: 'reject-cross-session-thread', selections: [selectionB], message: 'must not use B thread as A',
		})).rejects.toMatchObject({ code: -32082, errorName: 'TurnChangesOperationFailed' });
		const previewB = await client.request(APP_SERVER_METHODS['turnChanges/prepareCommit'], {
			...b, commandId: 'preview-owner-check-B', selections: [selectionB], message: 'owned by B',
		});
		await expect(client.request(APP_SERVER_METHODS['turnChanges/commit'], {
			...a, commandId: 'reject-cross-session-preview', commitId: previewB.commitId,
		})).rejects.toMatchObject({ code: -32082, errorName: 'TurnChangesOperationFailed' });
		expect(await git('rev-parse', 'HEAD')).toBe(initialHead);
		expect((await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]?.commitState).toBe('idle');
		// Local staged, unstaged and untracked content is outside both frozen Turn selections.
		await writeFile(join(testWorkspace.directory, 'external.txt'), 'staged local\n');
		await git('add', 'external.txt');
		await writeFile(join(testWorkspace.directory, 'external.txt'), 'unstaged local\n');
		await writeFile(join(testWorkspace.directory, 'untracked.txt'), 'untracked local\n');
		const localState = await git('status', '--porcelain');
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const open = async (sessionId: string): Promise<void> => {
			await page.locator(`.ash-sessions-list [data-item="session:${sessionId}"] .ash-sessions-list-item`).click();
			await new QuickAccess(page).runCommand('workbench.agentSessions.action.viewChanges');
		};
		await open(a.sessionId);
		const review = page.locator('.ash-sessions-changes-editor .stanza-multi-diff-editor');
		await expect(review).toBeVisible();
		const screenshot = testInfo.outputPath('changes-card-review.png');
		await page.screenshot({ path: screenshot });
		await testInfo.attach('changes-card-review', { path: screenshot, contentType: 'image/png' });
		const fileHeader = review.getByRole('button', { name: /main.ts/ });
		await fileHeader.press('Enter');
		await expect(fileHeader).toHaveAttribute('aria-expanded', 'false');
		const changesTool = page.locator('[data-part="titlebar"] [data-action-id="ash.sessions.toggleChanges"] button');
		await changesTool.click();
		await expect(review).toBeHidden();
		await changesTool.click();
		await expect(fileHeader).toHaveAttribute('aria-expanded', 'false');
		await fileHeader.press('Enter');
		await expect(fileHeader).toHaveAttribute('aria-expanded', 'true');
		const changes = page.locator('.ash-sessions-changes-editor:visible');
		const header = page.locator('[data-editor-tool="changes"] .ash-editor-group-header:visible');
		const toggleFiles = header.getByRole('button', { name: 'Toggle Changed Files', exact: true });
		if (await toggleFiles.getAttribute('aria-pressed') === 'false') await toggleFiles.click();
		const rows = changes.getByRole('tree', { name: 'Changed Files', exact: true }).getByRole('treeitem');
		const previewFile = async (name: RegExp, committed?: RegExp): Promise<void> => {
			await header.getByRole('button', { name: 'More Actions', exact: true }).click();
			await page.getByRole('menu').getByText('Preview commit…', { exact: true }).click();
			const picker = page.getByRole('listbox');
			if (committed) await expect(picker.getByRole('option', { name: committed })).toHaveCount(0);
			await picker.getByRole('option', { name }).click();
			await page.keyboard.press('Enter');
		};
		await expect(rows).toHaveCount(2);
		await expect(rows.filter({ hasText: 'main.ts' })).toBeInViewport({ ratio: 1 });
		await previewFile(/main\.ts/u);
		const message = page.getByRole('textbox', { name: 'Commit message', exact: true });
		await message.fill('commit selected A');
		await message.press('Enter');
		await expect(page.locator('[data-part="editor"]').getByRole('tab', { name: /commit selected A/u })).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('button', { name: 'Commit this preview', exact: true })).toBeVisible();
		await expect(page.locator('[data-part="editor"]')).toContainText('const value = 42;');
		await page.getByRole('button', { name: 'Commit this preview', exact: true }).click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], a)).changeSets[0]?.commitState).toBe('partiallyCommitted');
		expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('main.ts');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 42;');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('remaining.txt');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('other-session.txt');
		expect(await git('status', '--porcelain')).toBe(localState);
		const committedA = await git('rev-parse', 'HEAD');
		// B's old preview must fail after A advances their shared target, then allow a fresh review.
		await client.request(APP_SERVER_METHODS['turnChanges/commit'], { ...b, commandId: 'reject-stale-preview-B', commitId: previewB.commitId });
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]?.commitState).toBe('conflict');
		expect(await git('rev-parse', 'HEAD')).toBe(committedA);
		await open(b.sessionId);
		await expect(rows).toHaveCount(1);
		await previewFile(/other-session\.txt/u);
		await message.fill('commit separate B');
		await message.press('Enter');
		await expect(page.locator('[data-part="editor"]').getByRole('tab', { name: /commit separate B/u })).toHaveAttribute('aria-selected', 'true');
		await page.getByRole('button', { name: 'Commit this preview', exact: true }).click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]?.commitState).toBe('committed');
		expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('other-session.txt');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 42;');
		expect(await git('show', 'HEAD:other-session.txt')).toBe('separate B');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('remaining.txt');
		expect(await git('rev-list', '--count', 'HEAD')).toBe('3');
		expect(await git('status', '--porcelain')).toBe(localState);
		await open(a.sessionId);
		await expect(rows).toHaveCount(2);
		await previewFile(/remaining\.txt/u, /main\.ts/u);
		await message.fill('commit remaining A');
		await message.press('Enter');
		await expect(page.locator('[data-part="editor"]').getByRole('tab', { name: /commit remaining A/u })).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('[data-part="editor"]')).toContainText('remaining A');
		await page.getByRole('button', { name: 'Commit this preview', exact: true }).click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], a)).changeSets[0]?.commitState).toBe('committed');
		expect((await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]?.commitState).toBe('committed');
		expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('remaining.txt');
		expect(await git('show', 'HEAD:remaining.txt')).toBe('remaining A');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 42;');
		expect(await git('show', 'HEAD:other-session.txt')).toBe('separate B');
		expect(await git('rev-list', '--count', 'HEAD')).toBe('4');
		expect(await git('status', '--porcelain')).toBe(localState);
		expect(await git('show', ':external.txt')).toBe('staged local');
		expect(await readFile(join(testWorkspace.directory, 'external.txt'), 'utf8')).toBe('unstaged local\n');
		expect(await readFile(join(testWorkspace.directory, 'untracked.txt'), 'utf8')).toBe('untracked local\n');
	} finally { client.dispose(); incoming.dispose(); closed.dispose(); await frames.close(); launcher.dispose(); }
});
