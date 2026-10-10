import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { MethodResult } from '../../../../.build/protocol/typescript/index.js';
import { appServerRequest } from '../../../../src/ash/platform/agentHost/browser/appServerRequest.js';
import { Workbench } from '../../../automation/workbench.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// The product resolver is needed on the Desktop home page, before a directory grant exists.
test.use({ openWorkspace: false });

test('the product SSH resolver runs in V8 on Web and Electron and survives window reload', async ({ target, workbench, application, webAppServer, testWorkspace, reloadWorkbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the product extension host');
	let current = { application, workbench };
	for (let generation = 0; generation < 2; generation++) {
		const page = current.workbench.page;
		const panel = page.locator('[data-part="panel"]');
		const portsTab = panel.getByRole('tab', { name: 'Ports', exact: true });
		if (!await panel.isVisible()) {
			await current.workbench.quickaccess.runCommand('workbench.action.togglePanel');
		}
		await expect(panel).toBeVisible();
		await current.workbench.waitForUiIdle();
		if (await portsTab.isVisible()) {
			await portsTab.focus();
			await page.keyboard.press('Enter');
		} else {
			await current.workbench.menus.select(current.application, async () => {
				await panel.getByRole('tab', { name: 'Additional views', exact: true }).focus();
				await page.keyboard.press('Enter');
			}, ['Ports']);
		}
		const ports = page.locator('.ash-remote-ports');
		await expect(ports).toBeVisible();
		await expect(ports.getByRole('spinbutton', { name: 'Remote port', exact: true })).toBeDisabled();
		await expect(ports.getByRole('status')).toHaveText('Forwarded ports are available in an SSH Remote Workspace.');
		expect(await ports.evaluate(element => getComputedStyle(element).display)).toBe('flex');
		expect(await ports.locator('form').evaluate(element => getComputedStyle(element).display)).toBe('grid');
		if (target.kind === 'browser') {
			const result = await page.evaluate(async () => {
				const api = globalThis.ashWebWorkbenchHost!.api.extensionHost;
				const runtime = (await api.list()).extensions.find(extension => extension.id === 'ash.remote-ssh');
				if (runtime?.lifecycle !== 'ready' || runtime.incarnation === undefined) throw new Error(`SSH runtime unavailable: ${JSON.stringify(runtime)}`);
				return api.invoke({ extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, registrationId: 'remote:ssh', operation: 'resolveConnection', payload: { authority: 'ssh+build' }, deadlineUnixMillis: Date.now() + 5_000 }, new AbortController().signal);
			});
			expect(result).toEqual({ connectionName: 'build' });
		} else {
			const connection = await connectProfile(current.application, webAppServer, testWorkspace.directory, page);
			try {
				const runtime = (await appServerRequest(connection.client, 'extensionHost/list', {})).extensions.find(extension => extension.id === 'ash.remote-ssh');
				expect(runtime).toMatchObject({ lifecycle: 'ready', registrations: [{ kind: 'remoteConnectionResolver', registrationId: 'remote:ssh', authorityPrefix: 'ssh' }] });
				const { invocationId } = await appServerRequest(connection.client, 'extensionHost/invoke/start', {
					extensionId: runtime!.id, activationGeneration: runtime!.activationGeneration, incarnation: runtime!.incarnation!,
					registrationId: 'remote:ssh', operation: 'resolveConnection', payload: { authority: 'ssh+build' }, deadlineUnixMillis: Date.now() + 5_000,
				});
				let result: MethodResult<'extensionHost/invoke/read'> | undefined;
				try {
					await expect.poll(async () => {
						result = await appServerRequest(connection.client, 'extensionHost/invoke/read', { invocationId });
						return result.state;
					}, { timeout: 5_000 }).not.toBe('pending');
					expect(result).toEqual({ state: 'succeeded', payload: { connectionName: 'build' } });
				} finally {
					if (!result || result.state === 'pending') { await appServerRequest(connection.client, 'extensionHost/invoke/cancel', { invocationId }); }
				}
			} finally { await connection.close(); }
			if (generation === 0) {
				await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:save', { connection: { name: 'build', host: 'build-linux', workspace: '/srv/project' } }));
			}
			const dialog = await current.workbench.dialogs.expectMessage(current.application, 'Open Remote Window', async () => {
				await current.workbench.quickaccess.runCommand('workbench.action.remote.connect');
				await current.workbench.quickaccess.select(generation === 0 ? 'build' : 'build-review');
			});
			expect(dialog.detail).toBe(generation === 0 ? 'build-linux:/srv/project' : 'review-linux:/srv/review');
			if (generation === 0) {
				await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:update', { originalName: 'build', connection: { name: 'build-review', host: 'review-linux', workspace: '/srv/review' } }));
			} else {
				await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:remove', { name: 'build-review' }));
				expect(await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:list'))).toEqual([]);
			}
		}
		for (const worker of page.workers()) {
			expect(await worker.evaluate(() => self.name).catch(() => '')).not.toBe('Ash Web Extension Host: ash.remote-ssh');
		}
		if (generation === 0) current = await reloadWorkbench();
	}
});

test.describe('standard resolver startup', () => {
	test.use({ openWorkspace: true });

	test('a local V8 resolver connects a remote window before startup and resolves again after socket loss', async ({ target, application, workbench, testWorkspace }) => {
		test.skip(process.platform !== 'darwin' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the Desktop V8 extension host');
		test.setTimeout(150_000);
		if (!('evaluate' in application)) { throw new Error('Expected Electron'); }
		const { mkdir, writeFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const { createServer } = await import('node:http');
		const { connect } = await import('node:net');
		const { launchWeb } = await import('../../../automation/playwrightWeb.js');
		const remote = await launchWeb(testWorkspace.directory);
		const endpoint = new URL(remote.connection.endpoint);
		const peers = new Set<import('node:net').Socket>();
		let upgrades = 0;
		const gateway = createServer();
		// This fixture relays the real authenticated Rust endpoint. Only HTTP upgrade headers
		// change to the backend's exact origin; protocol frames remain untouched.
		gateway.on('upgrade', (request, socket, head) => {
			if (request.headers['sec-websocket-protocol'] !== `ash-session.${remote.connection.token}`) { socket.destroy(); return; }
			const backend = connect(Number(endpoint.port), endpoint.hostname);
			peers.add(backend);
			backend.on('error', () => socket.destroy());
			socket.on('error', () => backend.destroy());
			backend.on('close', () => { peers.delete(backend); socket.destroy(); });
			socket.on('close', () => backend.destroy());
			backend.on('connect', () => {
				upgrades++;
				backend.write(`GET /ash/app-server HTTP/1.1\r\nHost: ${endpoint.host}\r\nOrigin: ${endpoint.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${request.headers['sec-websocket-key']}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${request.headers['sec-websocket-protocol']}\r\n\r\n`);
				if (head.length) { backend.write(head); }
				socket.pipe(backend).pipe(socket);
			});
		});
		await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
		const address = gateway.address();
		if (!address || typeof address === 'string') { throw new Error('Expected a gateway port'); }
		let remotePage: import('@playwright/test').Page | undefined;
		try {
			const remoteRoot = join(testWorkspace.directory, 'remote-environment');
			await mkdir(join(remoteRoot, '.ash-plugin'), { recursive: true });
			await writeFile(join(remoteRoot, '.ash-plugin', 'plugin.json'), JSON.stringify({
				schemaVersion: 1, id: 'acme/remote-environment', version: '1.0.0', displayName: 'Remote environment', compatibility: { ash: '>=0.1.0' },
				contributions: { editorExtensions: [{ id: 'environment', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'startup' }], capabilities: ['command'] }] }, permissions: [],
			}));
			await writeFile(join(remoteRoot, 'extension.js'), `
import { commands } from '@ash/extension';
const loaded = { value: process.env.FIXTURE_REMOTE_ENV ?? null, removed: process.env.FIXTURE_REMOVE ?? null };
export function activate(context) {
	context.subscriptions.push(commands.registerCommand('fixture.remote.environment', 'Show remote environment', async call => call.window.showInformationMessage('REMOTE_ENV:' + JSON.stringify(loaded))));
}
`);
			const remoteProfile = await test.step('Connect remote profile for package installation', () => connectProfile(application, remote, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true }));
			try {
				const grants = await appServerRequest(remoteProfile.client, 'config/dirPermissions/list', {});
				await test.step('Grant remote directory package discovery', () => appServerRequest(remoteProfile.client, 'config/dirPermissions/set', { commandId: 'remote-environment-grant', expectedRevision: grants.revision, path: testWorkspace.directory, permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository', 'discoverPlugins'] }));
				const plugins = await appServerRequest(remoteProfile.client, 'plugin/list', {});
				const installed = await appServerRequest(remoteProfile.client, 'plugin/installLocal', { commandId: 'remote-environment-install', expectedRevision: plugins.revision, path: 'remote-environment', dirId: null });
				const enabled = await appServerRequest(remoteProfile.client, 'plugin/enable', { commandId: 'remote-environment-enable', expectedRevision: installed.command.revision, id: installed.id, version: installed.version, digest: installed.digest });
				await appServerRequest(remoteProfile.client, 'plugin/grant', { commandId: 'remote-environment-authorize', expectedRevision: enabled.revision, id: installed.id, version: installed.version, digest: installed.digest });
			} finally { await remoteProfile.close(); }
			const root = join(testWorkspace.directory, 'standard-resolver');
			await mkdir(join(root, '.ash-plugin'), { recursive: true });
			await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
				schemaVersion: 1, id: 'acme/standard-resolver', version: '1.0.0', displayName: 'Standard resolver', compatibility: { ash: '>=0.1.0' },
				contributions: { editorExtensions: [{ id: 'remote', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'startup' }], capabilities: ['command', 'remoteAuthorityResolver'] }] },
				permissions: [],
			}));
			await writeFile(join(root, 'extension.js'), `
import { commands, workspace, ResolvedAuthority } from '@ash/extension';
export function activate(context) {
	context.subscriptions.push(workspace.registerRemoteAuthorityResolver('fixture', {
		resolve(authority, context) {
			if (authority !== 'fixture+backend' || context.resolveAttempt < 1) throw new Error('Invalid resolution');
			return Object.assign(new ResolvedAuthority('127.0.0.1', ${address.port}, ${JSON.stringify(remote.connection.token)}), { isTrusted: true, extensionHostEnv: { FIXTURE_REMOTE_ENV: 'attempt-' + context.resolveAttempt, FIXTURE_REMOVE: null } });
		},
		getCanonicalURI(uri) {
			if (uri.scheme !== 'ash-remote' || uri.authority !== 'fixture+backend' || uri.path !== '/') throw new Error('Invalid canonical request');
			return uri.with({ authority: 'fixture+other-host' });
		}
	}));
	context.subscriptions.push(commands.registerCommand('fixture.remote.open', 'Open resolver fixture', async call => call.workspace.openRemoteConnection('fixture+backend')));
}
`);
			const page = workbench.page;
			await workbench.quickaccess.runCommand('ash.extensions.installLocal');
			const install = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
			await install.getByRole('textbox').fill('standard-resolver');
			await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('textbox').press('Enter'));
			for (const button of ['Enable', 'Grant permissions']) {
				await workbench.dialogs.confirm(application, 'Standard resolver', button, async () => {
					await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
					await page.getByRole('option').filter({ has: page.getByText('Standard resolver', { exact: true }) }).click();
				});
			}
			const opening = application.waitForEvent('window');
			await workbench.dialogs.confirm(application, 'Open Remote Window', 'Open Remote Window', () => workbench.quickaccess.runCommand('fixture.remote.open'));
			remotePage = await opening;
			const indicator = remotePage.locator('[data-statusbar-item-id="ash.status.remote"]');
			await expect(indicator).toHaveAttribute('aria-label', 'Remote connection to Remote host fixture+backend is ready', { timeout: 45_000 });
			await expect(remotePage.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
			await expect(remotePage.locator('[data-statusbar-item-id="ash.status.workspacePermissions"]')).toHaveAttribute('aria-label', /Restricted workspace/);
			await expect.poll(() => upgrades).toBe(1);
			const assertEnvironment = async (expected: string): Promise<void> => {
				const remoteWorkbench = new Workbench(remotePage!);
				await remoteWorkbench.quickaccess.runCommand('fixture.remote.environment');
				await expect(remotePage!.locator('.ash-notification', { hasText: `REMOTE_ENV:{"value":"${expected}","removed":null}` })).toBeVisible();
			};
			await assertEnvironment('attempt-1');
			for (const peer of peers) { peer.destroy(); }
			await expect.poll(() => upgrades, { timeout: 30_000 }).toBe(2);
			await expect(indicator).toHaveAttribute('aria-label', 'Remote connection to Remote host fixture+backend is ready');
			await assertEnvironment('attempt-2');
			await remotePage.reload();
			await expect.poll(() => upgrades, { timeout: 45_000 }).toBe(3);
			await expect(indicator).toHaveAttribute('aria-label', 'Remote connection to Remote host fixture+backend is ready');
			await assertEnvironment('attempt-1');
			await remotePage.close();
			remotePage = undefined;
			await expect.poll(() => peers.size).toBe(0);
		} finally {
			await remotePage?.close();
			for (const peer of peers) { peer.destroy(); }
			await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()));
			await remote.close();
		}
	});
});

test('inbound SSH hosting opens the Browser Workbench from a Chinese Desktop command and revokes access on stop', async ({ target, testWorkspace }) => {
	test.skip(process.platform !== 'darwin' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the local macOS OpenSSH server and Desktop backend');
	test.setTimeout(120_000);
	const { spawn, execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir, userInfo } = await import('node:os');
	const { join } = await import('node:path');
	const { createServer: tcpServer, connect } = await import('node:net');
	const { createServer, request: httpRequest } = await import('node:http');
	const { chromium } = await import('@playwright/test');
	const { launchElectronApplication } = await import('../../../automation/playwrightElectron.js');
	const { ElectronPlaywrightDriver } = await import('../../../automation/electronDriver.js');
	const run = promisify(execFile);
	const directory = await mkdtemp(join(tmpdir(), 'ash-inbound-ssh-'));
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const unusedPort = async (): Promise<number> => {
		const server = tcpServer();
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Missing TCP port'); }
		await new Promise<void>(resolve => server.close(() => resolve()));
		return address.port;
	};
	const accepts = (port: number): Promise<boolean> => new Promise(resolve => {
		const socket = connect(port, '127.0.0.1');
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => { socket.destroy(); resolve(false); });
	});
	await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host')]);
	await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'client')]);
	const relayPort = await unusedPort();
	await writeFile(join(directory, 'sshd_config'), `Port ${relayPort}\nListenAddress 127.0.0.1\nHostKey ${directory}/host\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/client.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\nGatewayPorts no\nPermitOpen any\nPermitListen 127.0.0.1:*\nLogLevel ERROR\n`);
	await writeFile(join(directory, 'ssh_config'), `Host ash-relay\n HostName 127.0.0.1\n Port ${relayPort}\n User ${userInfo().username}\n IdentityFile ${directory}/client\n IdentitiesOnly yes\n StrictHostKeyChecking no\n UserKnownHostsFile ${directory}/known_hosts\n`);
	const ssh = join(directory, 'ssh');
	await writeFile(ssh, `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(directory, 'ssh_config'))} "$@"\n`, { mode: 0o700 });
	const relay = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
	let relayErrors = '';
	relay.stderr.on('data', data => { relayErrors = (relayErrors + String(data)).slice(-4096); });
	let desktop: Awaited<ReturnType<typeof launchElectronApplication>> & { driver: import('../../../automation/electronDriver.js').ElectronPlaywrightDriver; } | undefined;
	let browser: import('@playwright/test').Browser | undefined;
	let client: import('node:child_process').ChildProcess | undefined;
	let proxy: import('node:http').Server | undefined;
	const peers = new Set<import('node:net').Socket>();
	const previousSsh = process.env.ASH_SSH_PATH;
	let scenarioError: unknown;
	try {
		await expect.poll(() => accepts(relayPort), { message: 'OpenSSH relay is listening' }).toBe(true);
		await run(ssh, ['-o', 'BatchMode=yes', 'ash-relay', 'true']);
		const profile = join(directory, 'desktop', 'profile');
		await mkdir(profile, { recursive: true });
		await writeFile(join(profile, 'settings.json'), JSON.stringify({ 'workbench.locale': 'zh-CN' }));
		process.env.ASH_SSH_PATH = ssh;
		const launched = await launchElectronApplication({ appServerMode: 'required', userDataDirectory: join(directory, 'desktop'), workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const firstPage = launched.application.windows()[0] ?? await launched.application.waitForEvent('window');
		desktop = { ...launched, driver: new ElectronPlaywrightDriver(launched.application, firstPage, launched.diagnostics) };
		const ready = desktop.driver.workbench.waitForReady();
		const trust = firstPage.getByRole('dialog', { name: 'Ash', exact: true });
		await Promise.race([ready, trust.waitFor({ state: 'visible' })]);
		if (await trust.isVisible()) { await trust.getByRole('button', { name: '信任文件夹并启用开发功能', exact: true }).click(); }
		await ready;
		const workbench = desktop.driver.workbench;
		const page = workbench.page;
		const panel = page.locator('[data-part="panel"]');
		if (!await panel.isVisible()) { await workbench.quickaccess.runCommand('workbench.action.togglePanel'); }
		await expect(panel).toBeVisible();
		await workbench.waitForUiIdle();
		const portsTab = panel.getByRole('tab', { name: '端口', exact: true });
		if (!await portsTab.isVisible()) {
			await workbench.menus.select(desktop.application, async () => {
				await panel.getByRole('tab', { name: '其他视图', exact: true }).focus();
				await page.keyboard.press('Enter');
			}, ['端口']);
		} else {
			await portsTab.focus();
			await page.keyboard.press('Enter');
		}
		const ports = page.locator('.ash-remote-ports');
		await expect(ports.getByRole('spinbutton', { name: '远程端口', exact: true })).toBeDisabled();
		await expect(ports.getByRole('button', { name: '转发端口', exact: true })).toBeDisabled();
		await expect(ports.getByRole('status')).toHaveText('端口转发适用于 SSH 远程工作区。');
		expect(await ports.evaluate(element => getComputedStyle(element).display)).toBe('flex');
		expect(await ports.locator('form').evaluate(element => getComputedStyle(element).display)).toBe('grid');
		await workbench.quickaccess.open('>workbench.remoteTunnel.actions.turnOn');
		await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('workbench.remoteTunnel.actions.turnOn', { exact: true }) })).toContainText('远程隧道: 启用远程隧道访问');
		await workbench.quickaccess.close();
		const message = await workbench.dialogs.confirm(desktop.application, '远程隧道访问已启用', '复制连接说明', async () => {
			await workbench.quickaccess.runCommand('workbench.remoteTunnel.actions.turnOn');
			const input = page.getByRole('dialog', { name: '此本地工作区的 SSH 中继', exact: true }).getByRole('textbox');
			await expect(input).toBeFocused();
			await input.fill('-oBad');
			await input.press('Enter');
			await expect(input).toBeVisible();
			await input.fill('ash-relay');
			await input.press('Enter');
		});
		await expect.poll(() => desktop!.application.evaluate(({ clipboard }) => clipboard.readText())).toBe(message.detail);
		const link = message.detail.match(/http:\/\/127\.0\.0\.1:\d+\/browser\/workbench\/workbench\.html#[^\s]+/)?.[0];
		const remotePort = Number(message.detail.match(/-L 127\.0\.0\.1:\d+:127\.0\.0\.1:(\d+) ash-relay/)?.[1]);
		if (!link || !remotePort) { throw new Error('Missing SSH connection instructions'); }
		const endpoint = new URL(link);
		const localPort = Number(endpoint.port);
		expect(await accepts(remotePort)).toBe(true);
		const clientPort = await unusedPort();
		client = spawn(ssh, ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${clientPort}:127.0.0.1:${remotePort}`, 'ash-relay'], { stdio: 'ignore' });
		await expect.poll(() => accepts(clientPort)).toBe(true);
		// Both test devices share one loopback namespace. Route browser sockets through
		// the real SSH client port while keeping the product URL, Host and Origin intact.
		proxy = createServer((request, response) => {
			const url = new URL(request.url!, endpoint.origin);
			if (url.origin !== endpoint.origin) { response.writeHead(403).end(); return; }
			const upstream = httpRequest({ hostname: '127.0.0.1', port: clientPort, method: request.method, path: url.pathname + url.search, headers: request.headers }, reply => { response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response); });
			upstream.on('error', () => response.writeHead(502).end());
			request.pipe(upstream);
		});
		let upgrades = 0;
		proxy.on('connect', (request, socket, head) => {
			if (request.url !== endpoint.host) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
			const upstream = connect(clientPort, '127.0.0.1');
			peers.add(upstream);
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
			upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
			socket.on('close', () => upstream.destroy());
			upstream.once('connect', () => {
				upgrades++;
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head.length) { upstream.write(head); }
				socket.pipe(upstream); upstream.pipe(socket);
			});
		});
		proxy.on('upgrade', (request, socket, head) => {
			expect(request.headers.host).toBe(endpoint.host);
			expect(request.headers.origin).toBe(endpoint.origin);
			const upstream = connect(clientPort, '127.0.0.1');
			peers.add(upstream);
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
			upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
			socket.on('close', () => upstream.destroy());
			upstream.once('connect', () => {
				upgrades++;
				const url = new URL(request.url!, endpoint.origin);
				upstream.write(`${request.method} ${url.pathname + url.search} HTTP/1.1\r\n${request.rawHeaders.reduce((lines, header, index, headers) => index % 2 === 0 ? lines + `${header}: ${headers[index + 1]}\r\n` : lines, '')}\r\n`);
				if (head.length) { upstream.write(head); }
				socket.pipe(upstream); upstream.pipe(socket);
			});
		});
		await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
		const address = proxy.address();
		if (!address || typeof address === 'string') { throw new Error('Missing browser proxy address'); }
		browser = await chromium.launch({ headless: true, proxy: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' } });
		const remotePage = await browser.newPage();
		await remotePage.goto(link);
		const remoteWorkbench = new Workbench(remotePage);
		await expect(remoteWorkbench.element).toBeVisible({ timeout: 20_000 });
		await remoteWorkbench.waitForReady();
		expect(upgrades).toBeGreaterThan(0);
		expect(await remotePage.evaluate(() => {
			const workspace = globalThis.ashWebWorkbenchHost!.workspace;
			if (!workspace || !('uri' in workspace)) { throw new Error('Expected hosted folder'); }
			return workspace.uri.fsPath;
		})).toBe(testWorkspace.directory);
		const result = await remotePage.evaluate(() => {
			const host = globalThis.ashWebWorkbenchHost!;
			return host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' });
		});
		expect(result).toMatchObject({ content: 'const value = 1;\n' });
		await remotePage.reload();
		await remoteWorkbench.waitForReady();
		// A new browser session cannot reuse the launcher ticket.
		const replay = await remotePage.evaluate(async ticket => (await fetch('/ash/session', { method: 'POST', credentials: 'omit', body: ticket })).status, new URLSearchParams(endpoint.hash.slice(1)).get('ash-ticket'));
		expect(replay).toBe(401);
		await page.reload();
		await workbench.waitForReady();
		expect((await page.evaluate(() => globalThis.ashTestMainProcess.call<{ type: string; }>('remoteTunnel', 'getTunnelStatus'))).type).toBe('connected');
		await workbench.quickaccess.runCommand('workbench.remoteTunnel.actions.turnOff');
		await expect.poll(() => accepts(remotePort)).toBe(false);
		await expect.poll(() => accepts(localPort)).toBe(false);
		// Command selection dispatches asynchronously; listeners can close before the helper publishes its final state.
		await expect.poll(async () => (await page.evaluate(() => globalThis.ashTestMainProcess.call<{ type: string; }>('remoteTunnel', 'getTunnelStatus'))).type).toBe('disconnected');
	} catch (error) {
		scenarioError = error;
		throw error;
	} finally {
		if (previousSsh === undefined) { delete process.env.ASH_SSH_PATH; } else { process.env.ASH_SSH_PATH = previousSsh; }
		await browser?.close();
		for (const peer of peers) { peer.destroy(); }
		if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
		client?.kill();
		if (client && client.exitCode === null && client.signalCode === null) { await new Promise<void>(resolve => client!.once('exit', () => resolve())); }
		try {
			await desktop?.close();
		} catch (error) {
			// Keep a scenario failure visible; a successful scenario still fails on bad teardown.
			if (scenarioError === undefined) { throw error; }
			console.error('Inbound Desktop cleanup also failed', error);
		} finally {
			relay.kill();
			if (relay.exitCode === null && relay.signalCode === null) { await new Promise<void>(resolve => relay.once('exit', () => resolve())); }
			await rm(directory, { recursive: true, force: true });
		}
	}
	expect(relayErrors).not.toContain('fatal');
});
