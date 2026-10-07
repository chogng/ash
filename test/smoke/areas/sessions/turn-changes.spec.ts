import { expect, test } from '../../../automation/test.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/app-server/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { APP_SERVER_METHODS } from '../../../../src/ash/platform/app-server/common/generated/index.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/app-server/common/appServerTransport.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test.use({ gitRepository: true });

test('Turn file selection starts disabled and explains review before commit', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
	await page.locator('.ash-editor-title-control').getByRole('tab', { name: 'Changes', exact: true }).click();
	const changes = page.locator('.ash-sessions-changes');
	await expect(changes.getByRole('button', { name: 'Preview selected changes', exact: true })).toBeDisabled();
	await changes.getByRole('tree').focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Preview selected changes[\s\S]*Commit this preview[\s\S]*remaining files/u);
});

test('Turn file selection commits a reviewed file and keeps another Session separate', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Uses the profile daemon and two real isolated execution directories.');
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
			const session = await client.request(APP_SERVER_METHODS['session/create'], { commandId: `create-${name}`, title: name, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const thread = await client.request(APP_SERVER_METHODS['session/request'], { commandId: `thread-${name}`, sessionId: session.session.sessionId, request: { type: 'createThread', title: name } });
			if (thread.type !== 'thread') throw new Error('Expected a Thread');
			const identity = { sessionId: session.session.sessionId, threadId: thread.value.threadId };
			await client.request(APP_SERVER_METHODS['session/request'], { ...identity, commandId: `write-${name}`, request: { type: 'startShellTurn', threadId: identity.threadId, expectedSequence: 1, approvalMode: 'bypassPermissions', command, workingDirectory: '.' } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], identity)).changeSets[0]?.captureState).toBe('sealed');
			return identity;
		};
		const a = await create('Selected files A', process.platform === 'win32' ? 'echo const value = 42;>main.ts & echo remaining A>remaining.txt' : "printf 'const value = 42;\\n' > main.ts; printf 'remaining A\\n' > remaining.txt");
		const b = await create('Selected files B', process.platform === 'win32' ? 'echo separate B>other-session.txt' : "printf 'separate B\\n' > other-session.txt");
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
		const open = async (name: string): Promise<void> => {
			await page.locator('.ash-sessions-list-item').filter({ hasText: name }).click();
			await page.locator('.ash-editor-title-control').getByRole('tab', { name: 'Changes', exact: true }).click();
		};
		await open('Selected files A');
		const changes = page.locator('.ash-sessions-changes');
		const rows = changes.getByRole('treeitem');
		await expect(rows).toHaveCount(2);
		await rows.filter({ hasText: 'main.ts' }).click();
		await changes.getByRole('button', { name: 'Preview selected changes', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Commit message', exact: true });
		await message.fill('commit selected A');
		await message.press('Enter');
		await expect(page.getByRole('button', { name: 'Commit this preview', exact: true })).toBeVisible();
		await expect(page.locator('[data-part="editor"]')).toContainText('const value = 42;');
		await page.getByRole('button', { name: 'Commit this preview', exact: true }).click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], a)).changeSets[0]?.commitState).toBe('partiallyCommitted');
		const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: testWorkspace.directory })).stdout.trim();
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 42;');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('remaining.txt');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('other-session.txt');
		await open('Selected files B');
		await expect(rows).toHaveCount(1);
		await expect(changes.getByRole('button', { name: 'Preview selected changes', exact: true })).toBeDisabled();
		await rows.first().click();
		await changes.getByRole('button', { name: 'Preview selected changes', exact: true }).click();
		await message.fill('commit separate B');
		await message.press('Enter');
		await page.getByRole('button', { name: 'Commit this preview', exact: true }).click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], b)).changeSets[0]?.commitState).toBe('committed');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 42;');
		expect(await git('show', 'HEAD:other-session.txt')).toBe('separate B');
		expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('remaining.txt');
		expect(await git('rev-list', '--count', 'HEAD')).toBe('3');
	} finally { client.dispose(); incoming.dispose(); closed.dispose(); await frames.close(); launcher.dispose(); }
});
