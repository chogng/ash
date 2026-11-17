import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { WSLRemoteAgentHostService } from '../../../../src/ash/platform/agentHost/node/wslRemoteAgentHostService.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { SSH_REMOTE_INITIALIZE_TIMEOUT_MS } from '../../../../src/ash/platform/remote/common/remote.js';
import { parseSessionIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';

const run = promisify(execFile);

test('Windows connects an independently packaged WSL host, reads its Session files and reconnects after backend exit', { tag: ['@electron-app-server', '@win32'] }, async ({ workbench, target }, testInfo) => {
	test.setTimeout(240_000);
	const distro = process.env.ASH_TEST_WSL_DISTRO;
	const packageRoot = process.env.ASH_TEST_WSL_REMOTE_PACKAGE;
	test.skip(!distro || !packageRoot, 'Select an installed WSL 2 distribution and independently built Remote package.');
	// The test owns this PATH entry and profile. Existing installations are never overwritten.
	const setup = await run('wsl.exe', ['--distribution', distro!, '--exec', 'python3', '-c', `
import json, os, pathlib, shlex, sys, tempfile
package = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert (package / 'ash-package.json').is_file()
entry = pathlib.Path('/usr/local/bin/ash-remote-server')
assert entry.parent.is_dir() and str(entry.parent) in os.environ['PATH'].split(':')
assert not entry.exists()
root = pathlib.Path(tempfile.mkdtemp(prefix='ash-wsl-acceptance-'))
profile, workspace = root / 'profile', root / 'workspace'
profile.mkdir(); workspace.mkdir()
(workspace / 'remote-wsl.txt').write_text('Independent WSL file\\n')
script = '#!/bin/sh\\nexport ASH_HOME=' + shlex.quote(str(profile)) + '\\nexport ASH_USE_DEVELOPMENT_SECRETSTORAGE=1\\nexec ' + shlex.quote(str(package / 'bin/ash-remote-server')) + ' "$@"\\n'
print(json.dumps(dict(root=str(root), profile=str(profile), workspace=str(workspace), entry=str(entry), script=script)))
`, packageRoot!], { windowsHide: true, timeout: 30_000 });
	const fixture = JSON.parse(setup.stdout) as { root: string; profile: string; workspace: string; entry: string; script: string; };
	let frames: ChildProcessJsonlTransport | undefined;
	let client: AppServerProtocolClient | undefined;
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emit = (event: string, payload: unknown) => { for (const listener of listeners.get(event) ?? []) listener(payload); };
	let incoming: { dispose(): void; } | undefined;
	let closed: { dispose(): void; } | undefined;
	const closeSeed = async () => { client?.dispose(); incoming?.dispose(); closed?.dispose(); await frames?.close(); };
	let installed = false;
	try {
		await run('wsl.exe', ['--distribution', distro!, '--user', 'root', '--exec', 'python3', '-c', `
import json, pathlib, sys
fixture = json.loads(sys.argv[1]); entry = pathlib.Path(fixture['entry'])
assert entry == pathlib.Path('/usr/local/bin/ash-remote-server')
with entry.open('x') as output: output.write(fixture['script'])
entry.chmod(0o755)
`, JSON.stringify(fixture)], { windowsHide: true, timeout: 30_000 });
		installed = true;
		const launcher = new WSLRemoteAgentHostService().createProcessLauncher({ type: 'wsl', name: distro!, distro: distro!, workspace: fixture.workspace });
		await launcher.validate();
		frames = new ChildProcessJsonlTransport(launcher.launch());
		incoming = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		closed = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
		client = new AppServerProtocolClient({
			on(event, listener) { let group = listeners.get(event); if (!group) listeners.set(event, group = new Set()); group.add(listener); },
			off(event, listener) { listeners.get(event)?.delete(listener); },
			send(event, payload) {
				if (event === WEB_APP_SERVER_CONNECT_EVENT) emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'wsl-fixture', workspaceRoot: fixture.workspace });
				else if (event === WEB_APP_SERVER_FRAME_EVENT) void frames!.send((payload as { frame: string; }).frame).catch(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) }));
				else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) throw new Error(`Unexpected WSL fixture event ${event}`);
			},
		}, { capabilities: { directoryGrantsHost: { version: 1 } }, initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS });
		await client.connect();
		const grants = await client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
		await client.request(APP_SERVER_METHODS['config/directoryGrants/set'], { commandId: randomUUID(), expectedRevision: grants.revision, path: fixture.workspace, permissions: [...DEVELOPMENT_DIR_PERMISSIONS] });
		const { session } = await client.request(APP_SERVER_METHODS['session/create'], { commandId: randomUUID(), kind: 'code', title: 'Independent WSL conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root: fixture.workspace } });
		const savedThread = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: session.sessionId, threadId: session.threads[0]!.threadId });
		if (savedThread.directory?.type !== 'local') throw new Error('Expected the WSL-owned Thread directory');
		const threadRoot = savedThread.directory.root;
		console.info('WSL Thread directory:', threadRoot, fixture.workspace);
		await closeSeed();
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('sessions.action.connectWSLAgentHost');
		await commands.select(distro!);
		const input = page.locator('.ash-quick-input-host input');
		await input.fill(fixture.workspace); await input.press('Enter');
		const row = page.locator('.ash-sessions-list-item').filter({ hasText: session.title });
		await expect(row).toBeVisible({ timeout: 30_000 }); await row.click();
		const thread = page.locator('.ash-sessions-chat-slot.active .ash-chat');
		await expect.poll(async () => parseSessionIdentity(await thread.getAttribute('data-thread-id') ?? '', 'local-agent-host').providerId).toMatch(/^wsl-agent-host:ash-remote:\/\/wsl\+/);
		const threadId = await thread.getAttribute('data-thread-id');
		expect(parseSessionIdentity(threadId!, 'local-agent-host').backendSessionId).toBe(session.threads[0]!.threadId);
		const openFile = async (expected = 'Independent WSL file\n') => {
			await commands.runCommand('workbench.action.agentSessions.newFileTab');
			await page.locator('.ash-desktop-auxiliarybar:visible').getByRole('treeitem', { name: 'remote-wsl.txt', exact: true }).dblclick();
			await new Editor(page.locator('[data-part="editor"]')).waitForEditorContents(text => text === expected);
		};
		await openFile();
		const backend = async () => JSON.parse((await run('wsl.exe', ['--distribution', distro!, '--exec', 'env', `ASH_HOME=${fixture.profile}`, `${packageRoot}/bin/ash-app-server-daemon`, 'diagnostic-target'], { windowsHide: true, timeout: 30_000 })).stdout) as { pid: number; instanceId: string; };
		const before = await backend();
		const stop = () => run('wsl.exe', ['--distribution', distro!, '--exec', 'env', `ASH_HOME=${fixture.profile}`, `${packageRoot}/bin/ash-app-server-daemon`, 'stop'], { windowsHide: true, timeout: 30_000 });
		await stop();
		await run('wsl.exe', ['--distribution', distro!, '--exec', 'python3', '-c', 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_text("Independent WSL file after restart\\n")', `${threadRoot}/remote-wsl.txt`], { windowsHide: true, timeout: 30_000 });
		await expect.poll(async () => {
			try { const current = await backend(); return current.pid > 0 && current.pid !== before.pid && current.instanceId !== before.instanceId; }
			catch { return false; }
		}, { timeout: 30_000 }).toBe(true);
		await commands.runCommand('sessions.action.manageAgentHosts');
		const hosts = page.getByRole('dialog', { name: 'Remote Environments', exact: true });
		const host = hosts.getByRole('row').filter({ hasText: fixture.workspace });
		await expect(host).toContainText('Connected', { timeout: 30_000 });
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(thread).toHaveAttribute('data-thread-id', threadId!);
		await openFile('Independent WSL file after restart\n');
		await commands.runCommand('sessions.action.manageAgentHosts');
		await host.getByRole('button', { name: /^Disconnect:/ }).click();
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(row).toHaveCount(0);
	} finally {
		await closeSeed(); listeners.clear();
		await run('wsl.exe', ['--distribution', distro!, '--exec', 'env', `ASH_HOME=${fixture.profile}`, `${packageRoot}/bin/ash-app-server-daemon`, 'stop'], { windowsHide: true, timeout: 30_000 });
		if (installed) await run('wsl.exe', ['--distribution', distro!, '--user', 'root', '--exec', 'python3', '-c', `
import json, pathlib, sys
fixture = json.loads(sys.argv[1]); entry = pathlib.Path(fixture['entry'])
assert entry == pathlib.Path('/usr/local/bin/ash-remote-server') and entry.read_text() == fixture['script']
entry.unlink()
`, JSON.stringify(fixture)], { windowsHide: true, timeout: 30_000 });
		await run('wsl.exe', ['--distribution', distro!, '--exec', 'python3', '-c', `
import json, pathlib, shutil, sys
fixture = json.loads(sys.argv[1]); root = pathlib.Path(fixture['root']).resolve()
assert root.parent == pathlib.Path('/tmp') and root.name.startswith('ash-wsl-acceptance-')
shutil.rmtree(root)
`, JSON.stringify(fixture)], { windowsHide: true, timeout: 30_000 });
		await testInfo.attach('remote-runtime', { body: JSON.stringify({ distro, packageRoot, isolatedProfile: true }), contentType: 'application/json' });
	}
});
