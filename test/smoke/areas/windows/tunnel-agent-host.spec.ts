import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { createTestEnvironment } from '../../../automation/testEnvironment.js';
import { startWeb } from '../../../../build/desktop/web.js';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { AppServerRemoteError } from '../../../../src/ash/platform/agentHost/common/appServerError.js';
import { Editor } from '../../../automation/editor.js';
import { parseSessionIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';

test('Tunnel connects a real published Session through an HTTP forward, reconnects and retires a revoked lease', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, target }, testInfo) => {
	test.setTimeout(120_000);
	const root = join(testWorkspace.directory, 'tunnel-workspace');
	const profile = join(testWorkspace.directory, 'tunnel-profile');
	await Promise.all([mkdir(root), mkdir(profile)]);
	await writeFile(join(root, 'remote-tunnel.txt'), 'Published Tunnel file\n');
	const seed = await connectProfile(application, undefined, root, workbench.page, { profileRoot: profile, directoryGrantsHost: true });
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	const sockets = new Set<Socket>();
	let destination: URL | undefined;
	let connections = 0;
	const authenticationStatus: number[] = [];
	// Map the test proxy's Host to the real listener, preserving its explicit Origin.
	// WebSocket payloads stay opaque. SSH's same-port forwarding is separate acceptance.
	const forward = createServer((incoming, response) => {
		if (!destination) { response.writeHead(503).end(); return; }
		const upstream = request(new URL(incoming.url!, destination), { method: incoming.method, headers: { ...incoming.headers, host: destination.host } }, reply => {
			if (incoming.url === '/ash/session') authenticationStatus.push(reply.statusCode!);
			response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response);
		});
		upstream.on('error', () => response.destroy()); incoming.pipe(upstream);
	});
	forward.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
	forward.on('upgrade', (incoming, socket, head) => {
		if (!destination) { socket.destroy(); return; }
		connections++;
		const upstream = connect(Number(destination.port), destination.hostname);
		sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
		upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
		upstream.once('connect', () => {
			const headers = { ...incoming.headers, host: destination!.host };
			upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
	});
	const environment = { ...createTestEnvironment(profile, process.env), ASH_HOME: profile, ASH_WEB_APP_SERVER_PROFILE: profile, ASH_WORKSPACE_ROOT: root, ASH_USE_INMEMORY_SECRETSTORAGE: '1' };
	try {
		const grants = await seed.client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
		await seed.client.request(APP_SERVER_METHODS['config/directoryGrants/set'], { commandId: randomUUID(), expectedRevision: grants.revision, path: root, permissions: [...DEVELOPMENT_DIR_PERMISSIONS] });
		const { session } = await test.step('Seed the published Session', () => seed.client.request(APP_SERVER_METHODS['session/create'], { commandId: randomUUID(), kind: 'code', title: 'Published Tunnel conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root } }));
		await seed.close();
		await new Promise<void>(resolveListen => forward.listen(0, '127.0.0.1', resolveListen));
		const endpoint = `http://127.0.0.1:${(forward.address() as { port: number; }).port}/`;
		web = await startWeb({ port: 0, origin: new URL(endpoint).origin, assets: join(resolve('.'), '.build/desktop/renderer/ash'), environment, preparedBackend: true });
		destination = new URL(web.info.endpoint);
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('sessions.action.connectTunnelAgentHost');
		const link = new URL(endpoint); link.hash = new URLSearchParams({ 'ash-ticket': web.info.ticket }).toString();
		const input = page.locator('.ash-quick-input-host input[type="password"]');
		await input.fill(link.href);
		await input.press('Enter');
		const row = page.locator('.ash-sessions-list-item').filter({ hasText: session.title });
		await expect(row).toBeVisible({ timeout: 30_000 });
		await row.click();
		const thread = page.locator('.ash-sessions-chat-slot.active .ash-chat');
		await expect.poll(async () => parseSessionIdentity(await thread.getAttribute('data-thread-id') ?? '', 'local-agent-host').providerId).toMatch(/^tunnel-agent-host:tunnel\+/);
		const threadId = await thread.getAttribute('data-thread-id');
		expect(parseSessionIdentity(threadId!, 'local-agent-host').backendSessionId).toBe(session.threads[0]!.threadId);
		await commands.runCommand('workbench.action.agentSessions.newFileTab');
		await page.locator('.ash-desktop-auxiliarybar:visible').getByRole('treeitem', { name: 'remote-tunnel.txt', exact: true }).dblclick();
		await new Editor(page.locator('[data-part="editor"]')).waitForEditorContents(text => text === 'Published Tunnel file\n');
		await commands.runCommand('sessions.action.manageAgentHosts');
		const hosts = page.getByRole('dialog', { name: 'Remote Environments', exact: true });
		const host = hosts.getByRole('row').filter({ hasText: endpoint.slice(0, -1) });
		await expect(host).toContainText('Connected');
		const before = connections;
		for (const socket of sockets) socket.destroy();
		await expect.poll(() => connections).toBeGreaterThan(before);
		await expect(host).toContainText('Connected', { timeout: 30_000 });
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(thread).toHaveAttribute('data-thread-id', threadId!);
		await expect(row).toBeVisible();
		await web.close(); web = undefined;
		await commands.runCommand('sessions.action.manageAgentHosts');
		await expect(host).toContainText('Host offline', { timeout: 30_000 });
		await host.getByRole('button', { name: /^Disconnect:/ }).click();
		await expect(host).toHaveCount(0);
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(row).toHaveCount(0);
	} catch (error) {
		console.error('Tunnel forward diagnostics:', { authenticationStatus, connections });
		if (error instanceof AppServerRemoteError) console.error('Tunnel acceptance RPC:', error.data);
		for (const file of await readdir(profile, { recursive: true })) {
			if (file.endsWith('.log')) await testInfo.attach(file, { body: await readFile(join(profile, file)), contentType: 'text/plain' });
		}
		throw error;
	} finally {
		await seed.close();
		await web?.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolveClose => forward.close(() => resolveClose()));
		const packageRoot = developmentAshPackagePath(resolve('.'));
		await promisify(execFile)(join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon'), ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });
	}
});
