import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { RemoteAgentConnection } from '../../../../src/ash/platform/remote/common/remoteAgentApi.js';
import type { SshPortForward } from '../../../../src/ash/platform/remote/electron-main/sshPortForwardingService.js';

test('SSH Desktop edits, searches, forwards ports and recovers the same terminal after transport loss', { tag: ['@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(240_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const fixture = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'), process.env.ASH_TEST_SSH_ADDRESS);
	const workspace = join(fixture.root, 'remote workspace 中文');
	const service = createServer((_request, response) => response.end('remote-forward-ok'));
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		await mkdir(workspace);
		await writeFile(join(workspace, 'remote.txt'), 'ssh_desktop_search_token\n');
		await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
		const remotePort = (service.address() as import('node:net').AddressInfo).port;
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(fixture.root, 'desktop'),
			workspaceDirectory: workspace, workspacePermissions: 'development', startupTimeout: 60_000,
			extraArgs: [`--remote-ssh=${fixture.host}`],
			environment: { ...process.env, ASH_SSH_PATH: fixture.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { workbench } = desktop.driver;
		const page = workbench.page;
		await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		await installMainChannelTestClient(page);
		const indicator = page.locator('[data-statusbar-item-id="ash.status.remote"]');
		const readyLabel = `Remote connection to SSH host ${fixture.host} is ready`;
		const connection = () => page.evaluate(async () => await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection') as RemoteAgentConnection);
		const tunnels = () => page.evaluate(() => globalThis.ashTestMainProcess.call<SshPortForward[]>('remotePortForwarding', 'ash:remote:tunnel:list'));
		await test.step('Initialize the production Desktop SSH connection', async () => {
			await expect(indicator).toHaveAttribute('aria-label', readyLabel);
			expect(await connection()).toMatchObject({ kind: 'ssh', host: fixture.host, authority: `ssh+${fixture.host}` });
		});
		await test.step('Edit and save a remote file through the editor', async () => {
			await workbench.quickaccess.open('remote.txt');
			await workbench.quickaccess.select('remote.txt');
			const editor = workbench.editors.groupAt(0).editor;
			await editor.waitForEditorFocus();
			await editor.input.press('ControlOrMeta+End');
			await editor.waitForTypeInEditor('saved_over_ssh');
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect.poll(() => readFile(join(workspace, 'remote.txt'), 'utf8')).toBe('ssh_desktop_search_token\nsaved_over_ssh');
		});
		await test.step('Search the remote workspace', async () => {
			await workbench.search.open();
			await workbench.search.search('ssh_desktop_search_token');
			await expect(workbench.search.status).toHaveText('1 results');
			await expect(workbench.search.files).toHaveText(['remote.txt']);
		});
		const agent = await test.step('Complete a deterministic Agent turn through the real SSH runtime', async () => {
			const report = join(fixture.root, 'agent-acceptance', 'remote-agent-smoke.json');
			await promisify(execFile)(process.execPath, [
				'build/python.ts', '-B', 'build/remote_smoke.py', '--package-dir', packageRoot,
				'--ssh', fixture.ssh, '--host', fixture.host, '--report', report,
			], { cwd: resolve('.'), timeout: 120_000, env: { ...process.env, CODEX_HOME: join(fixture.root, 'codex') } });
			const result = JSON.parse(await readFile(report, 'utf8'));
			expect(result.status).toBe('passed');
			await testInfo.attach('remote-agent-smoke', { path: report, contentType: 'application/json' });
			return result;
		});
		await test.step('Run a real remote PTY and forward a remote service', async () => {
			await workbench.terminal.show();
			await workbench.terminal.runCommand(`printf '%s' "$$" > shell-before.txt; printf '%s\\n' remote-pty-"ready"`);
			await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('remote-pty-ready');
			const panel = page.locator('[data-part="panel"]');
			const portsTab = panel.getByRole('tab', { name: 'Ports', exact: true });
			if (await portsTab.isVisible()) { await portsTab.click(); }
			else await workbench.menus.select(desktop!.application, async () => {
				await panel.getByRole('tab', { name: 'Additional views', exact: true }).press('Enter');
			}, ['Ports']);
			const ports = page.locator('.ash-remote-ports');
			await ports.getByRole('spinbutton', { name: 'Remote port', exact: true }).fill(String(remotePort));
			await ports.getByRole('button', { name: 'Forward Port', exact: true }).click();
			await expect.poll(async () => (await tunnels()).map(tunnel => tunnel.state)).toEqual(['open']);
			const [tunnel] = await tunnels();
			expect(await (await fetch(`http://127.0.0.1:${tunnel!.localPort}`)).text()).toBe('remote-forward-ok');
		});
		const before = await connection();
		const [forwarded] = await tunnels();
		await test.step('Recover the SSH connection, dirty editor, PTY and forwarded port', async () => {
			const editor = workbench.editors.groupAt(0).editor;
			await editor.waitForEditorFocus();
			await editor.input.press('ControlOrMeta+End');
			await editor.waitForTypeInEditor('_dirty_before_disconnect');
			fixture.disconnect();
			await expect.poll(async () => (await connection()).generation, { timeout: 30_000 }).toBeGreaterThan(before.generation);
			await expect(indicator).toHaveAttribute('aria-label', readyLabel, { timeout: 30_000 });
			await editor.waitForEditorContents(content => content.includes('saved_over_ssh_dirty_before_disconnect'));
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect.poll(() => readFile(join(workspace, 'remote.txt'), 'utf8')).toBe('ssh_desktop_search_token\nsaved_over_ssh_dirty_before_disconnect');
			await workbench.quickaccess.runCommand('workbench.action.terminal.focus');
			await expect(workbench.terminal.activeInstance).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
			await workbench.terminal.runCommand(`printf '%s' "$$" > shell-after.txt; printf '%s\\n' remote-pty-"recovered"`);
			await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('remote-pty-recovered');
			expect(await readFile(join(workspace, 'shell-after.txt'), 'utf8')).toBe(await readFile(join(workspace, 'shell-before.txt'), 'utf8'));
			await expect.poll(async () => (await tunnels()).map(tunnel => ({ localPort: tunnel.localPort, state: tunnel.state })), { timeout: 30_000 }).toEqual([{ localPort: forwarded!.localPort, state: 'open' }]);
			expect(await (await fetch(`http://127.0.0.1:${forwarded!.localPort}`)).text()).toBe('remote-forward-ok');
		});
		const screenshot = testInfo.outputPath('remote-desktop.png');
		await page.screenshot({ path: screenshot });
		await testInfo.attach('remote-desktop', { path: screenshot, contentType: 'image/png' });
		const report = testInfo.outputPath('remote-desktop.json');
		await writeFile(report, JSON.stringify({ address: fixture.address, before, after: await connection(), sameTerminalProcess: true, forwardedPort: forwarded!.localPort, dirtyBufferSaved: true, agent }, null, 2));
		await testInfo.attach('remote-desktop', { path: report, contentType: 'application/json' });
	} catch (error) {
		if (desktop && !desktop.driver.workbench.page.isClosed()) {
			await testInfo.attach('remote-desktop-failure.png', { body: await desktop.driver.workbench.page.screenshot(), contentType: 'image/png' });
		}
		throw error;
	} finally {
		try {
			if (desktop) {
				try {
					const path = testInfo.outputPath('trace.zip');
					await desktop.driver.workbench.page.context().tracing.stop({ path });
					await testInfo.attach('trace', { path, contentType: 'application/zip' });
				}
				finally { await desktop.close(); }
			}
		} finally {
			await new Promise<void>(resolve => service.close(() => resolve()));
			await fixture.close();
		}
	}
});

test('SSH multi-root menus persist remote identities and retain a terminal in the surviving root', { tag: ['@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(240_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const fixture = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'), process.env.ASH_TEST_SSH_ADDRESS);
	const first = join(fixture.root, 'work-client');
	const second = join(fixture.root, 'work-server');
	const saved = join(fixture.root, 'team.ash-workspace');
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		await Promise.all([mkdir(first), mkdir(second)]);
		await writeFile(join(first, 'client.txt'), 'remote_workspace_token client\n');
		await writeFile(join(second, 'server.txt'), 'remote_workspace_token server\n');
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(fixture.root, 'desktop'),
			workspaceDirectory: first, workspacePermissions: 'development', startupTimeout: 60_000,
			extraArgs: [`--remote-ssh=${fixture.host}`],
			environment: { ...process.env, ASH_SSH_PATH: fixture.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { workbench } = desktop.driver;
		const page = workbench.page;
		const app = desktop.application;
		await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		await app.evaluate(({ dialog }, saved) => {
			dialog.showSaveDialog = (async () => ({ canceled: false, filePath: saved })) as typeof dialog.showSaveDialog;
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [saved] })) as typeof dialog.showOpenDialog;
		}, saved);
		const context = () => page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:workspace:context:read') as Promise<{ folders: { id: string; uri: string; }[]; configuration?: string; remoteAuthority?: string; }>);
		const fileMenu = async (label: string) => {
			await expect.poll(() => app.evaluate(({ Menu }, label) => Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === label)?.enabled, label)).toBe(true);
			await app.evaluate(({ Menu }, label) => Menu.getApplicationMenu()!.items.find(item => item.label === 'File')!.submenu!.items.find(item => item.label === label)!.click({ altKey: false }), label);
		};
		await test.step('Add a second root through the File menu and real remote permission prompt', async () => {
			await fileMenu('Add Folder to Workspace...');
			const input = page.locator('.ash-quick-pick input');
			await input.fill(second); await input.press('Enter');
			await page.getByRole('dialog', { name: 'Ash', exact: true }).getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
			await expect.poll(async () => (await context()).folders.length).toBe(2);
			expect((await context()).folders.every(folder => folder.uri.startsWith(`ash-remote://ssh+${fixture.host}/`))).toBe(true);
		});
		const roots = (await context()).folders;
		await test.step('Read, edit and search the second remote root', async () => {
			await workbench.quickaccess.open('server.txt'); await workbench.quickaccess.select('server.txt');
			const editor = workbench.editors.groupAt(0).editor;
			await editor.waitForEditorFocus(); await editor.input.press('ControlOrMeta+End');
			await editor.waitForTypeInEditor('saved_in_second_remote_root');
			await fileMenu('Remove Folder from Workspace...');
			await page.locator('.ash-quick-pick').getByText('work-server', { exact: true }).click();
			const errors = page.getByRole('region', { name: 'Notifications', exact: true });
			await expect(errors.getByText(/Save or revert unsaved files/)).toBeVisible();
			expect((await context()).folders).toHaveLength(2);
			await errors.getByRole('button', { name: 'Remove notification', exact: true }).click();
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect.poll(() => readFile(join(second, 'server.txt'), 'utf8')).toContain('saved_in_second_remote_root');
			await workbench.search.open(); await workbench.search.search('remote_workspace_token');
			await expect(workbench.search.status).toHaveText('2 results');
		});
		await test.step('Save local metadata containing remote URI roots', async () => {
			await fileMenu('Save Workspace As...');
			await expect.poll(async () => (await context()).configuration).toContain('team.ash-workspace');
			const metadata = JSON.parse(await readFile(saved, 'utf8'));
			expect(metadata.remoteAuthority).toBe(`ssh+${fixture.host}`);
			expect(metadata.folders.map((folder: { uri: string; }) => folder.uri)).toEqual(roots.map(folder => folder.uri));
		});
		await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
		await test.step('Remove the first root from Explorer while a second-root terminal survives', async () => {
			await workbench.terminal.show();
			await workbench.terminal.runCommand(`printf '%s\\n' "$PWD" > cwd-before.txt`);
			await expect.poll(() => readFile(join(second, 'cwd-before.txt'), 'utf8').catch(() => '')).toContain('server');
			const row = page.locator('.ash-explorer .ash-tree-row').filter({ has: page.locator(`[data-resource=${JSON.stringify(roots[0]!.uri)}]`) });
			await workbench.menus.select(app, async () => { await row.click(); await row.press('Shift+F10'); }, ['Remove Folder from Workspace...']);
			await expect.poll(async () => (await context()).folders.map(folder => folder.id)).toEqual([roots[1]!.id]);
			await workbench.quickaccess.runCommand('workbench.action.terminal.focus');
			await workbench.terminal.runCommand(`printf '%s\\n' "$PWD" > cwd-after.txt`);
			await expect.poll(() => readFile(join(second, 'cwd-after.txt'), 'utf8').catch(() => '')).toContain('server');
			expect(await readFile(join(first, 'client.txt'), 'utf8')).toContain('remote_workspace_token');
		});
		await test.step('Close and reopen the saved workspace on the same SSH authority', async () => {
			await fileMenu('Close Workspace');
			await expect.poll(async () => (await context()).folders.length).toBe(0);
			await workbench.waitForReady();
			expect((await context()).remoteAuthority).toBe(`ssh+${fixture.host}`);
			await fileMenu('Open Workspace from File...');
			await expect.poll(async () => (await context()).folders.map(folder => folder.uri)).toEqual([roots[1]!.uri]);
			await workbench.waitForReady();
			await expect(page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'server' }).first()).toBeVisible();
		});
		const screenshot = testInfo.outputPath('remote-multi-root-reopened.png');
		await page.screenshot({ path: screenshot });
		await testInfo.attach('remote-multi-root-reopened', { path: screenshot, contentType: 'image/png' });
	} finally {
		if (desktop) {
			const trace = testInfo.outputPath('remote-multi-root-trace.zip');
			await desktop.driver.workbench.page.context().tracing.stop({ path: trace }).catch(() => { });
			await testInfo.attach('remote-multi-root-trace', { path: trace, contentType: 'application/zip' }).catch(() => { });
			await desktop.close();
		}
		await fixture.close();
	}
});
