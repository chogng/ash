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
import type { RemoteTunnel } from '../../../../src/ash/platform/remote/common/remoteTunnelService.js';

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
		const tunnels = () => page.evaluate(() => globalThis.ashTestMainProcess.call<RemoteTunnel[]>('remotePortForwarding', 'ash:remote:tunnel:list'));
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
