import { createServer } from 'node:http';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import { buildOpenSessionLinkUri } from '../../../../src/ash/platform/agentHost/common/openSessionLink.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import { createSshRemoteWorkspaceUri } from '../../../../src/ash/platform/remote/common/remote.js';
import { sshAgentHostProviderId } from '../../../../src/ash/sessions/common/agentHostSessionsProvider.js';
import { sessionIdentity, sessionProviderAuthority, threadIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { directoryPermissionPrompt } from '../../../automation/dialogs.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test('Open IDE hands off the selected SSH project and worktree threads', { tag: ['@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(120_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const ssh = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'));
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let seed: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const root = await realpath(ssh.root);
		const localRoot = join(root, 'local-workspace');
		const remoteRoot = join(root, 'remote-project');
		await Promise.all([mkdir(localRoot), mkdir(remoteRoot)]);
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(root, 'desktop'), workspaceDirectory: localRoot, workspacePermissions: 'development',
			environment: { ...process.env, ASH_SSH_PATH: ssh.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { application, driver: { workbench } } = desktop;
		const tracing = workbench.page.context().tracing;
		await tracing.start({ screenshots: true, snapshots: true, sources: true });
		seed = await connectProfile(application, undefined, remoteRoot, workbench.page, { profileRoot: join(root, 'remote-profile'), directoryGrantsHost: true });
		const { client } = seed;
		const grants = await client.request(methods['config/directoryGrants/list'], {});
		await client.request(methods['config/directoryGrants/set'], {
			commandId: 'ssh-ide-directory-grant', expectedRevision: grants.revision, path: remoteRoot,
			permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository', 'discoverPlugins'],
		});
		const { session } = await client.request(methods['session/create'], {
			commandId: 'ssh-ide-session', kind: 'code', title: 'SSH project conversation', agent: { type: 'default' },
			executionTarget: { type: 'local', root: remoteRoot },
		});
		const rootThread = session.threads[0]!.threadId;
		const { directory: rootDirectory } = await client.request(methods['session/thread/read'], { sessionId: session.sessionId, threadId: rootThread });
		if (rootDirectory?.type !== 'local') throw new Error('Expected a working directory for the SSH project thread');
		const branch = await client.request(methods['session/request'], {
			commandId: 'ssh-ide-branch', sessionId: session.sessionId,
			request: { type: 'forkThread', parentThreadId: rootThread, title: 'SSH worktree conversation' },
		});
		if (branch.type !== 'thread') throw new Error('Expected a persisted fork Thread');
		const forkThread = branch.value.threadId;
		const { directory } = await client.request(methods['session/thread/read'], { sessionId: session.sessionId, threadId: forkThread });
		if (directory?.type !== 'local' || directory.root === rootDirectory.root) throw new Error('Expected a separate working directory on the SSH host');
		await Promise.all([
			writeFile(join(rootDirectory.root, 'ssh-project-marker.txt'), 'Project thread checkout'),
			writeFile(join(directory.root, 'ssh-worktree-marker.txt'), 'Selected thread worktree'),
		]);

		const definition = { name: 'ssh-ide-fixture', host: ssh.host, workspace: remoteRoot };
		await workbench.page.evaluate(connection => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:save', { connection }), definition);
		const agents = await workbench.openAgentsWindow('electron');
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await new QuickAccess(agents).runCommand('sessions.action.manageAgentHosts');
		const hosts = agents.getByRole('dialog', { name: 'Remote Environments' });
		await hosts.getByRole('button', { name: `Connect: ${definition.name}`, exact: true }).click();
		await agents.getByRole('button', { name: 'Trust and Open', exact: true }).click();
		await expect(hosts.getByRole('row').filter({ hasText: definition.name })).toContainText('Connected', { timeout: 30_000 });
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		const providerId = sshAgentHostProviderId(definition);
		const remoteId = sessionIdentity(providerId, session.sessionId, 'local-agent-host');
		const row = agents.locator(`[data-item=${JSON.stringify(`session:${remoteId}`)}] > .ash-sessions-list-item`);
		const source = agents.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		const openIde = agents.locator('.ash-sessions-titlebar-right').getByRole('button', { name: 'Open IDE', exact: true });
		const assertHandoff = async (threadId: string, expectedRoot: string, marker: string): Promise<void> => {
			const sourceThread = threadIdentity(providerId, threadId, 'local-agent-host');
			await expect(source).toHaveAttribute('data-thread-id', sourceThread);
			const opened = application.waitForEvent('window');
			await openIde.click();
			const destination = await opened;
			await destination.waitForURL(url => url.pathname.endsWith('/workbench.html'), { waitUntil: 'domcontentloaded' });
			const expectedUri = createSshRemoteWorkspaceUri(ssh.host, expectedRoot).toString();
			const folder = () => destination.evaluate(async () => {
				const workspace = await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:workspace:context:read') as { folders: { uri: string; }[]; };
				return workspace.folders[0]?.uri;
			});
			await expect.poll(folder).toBe(expectedUri);
			const permission = directoryPermissionPrompt(destination);
			const chat = destination.locator('.ash-chat-view-pane .ash-chat:visible');
			const reconnect = destination.getByRole('dialog').filter({ hasText: `Connect to ${definition.name} and open the conversation?` });
			await expect(permission.or(chat).or(reconnect).first()).toBeVisible({ timeout: 30_000 });
			if (await permission.isVisible()) await permission.getByRole('button', { name: 'Trust Folder', exact: true }).click();
			await expect(chat.or(reconnect).first()).toBeVisible({ timeout: 30_000 });
			await expect(reconnect).toHaveCount(0);
			await expect(chat).toHaveAttribute('data-session-id', session.sessionId);
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			const ide = new Workbench(destination);
			await ide.openExplorer();
			await expect(destination.locator('[data-part="sidebar"]').getByText(marker, { exact: true })).toBeVisible();
			await expect(source).toHaveAttribute('data-thread-id', sourceThread);
		};
		await test.step('Open the SSH project with the root thread', async () => {
			await row.click();
			await assertHandoff(rootThread, rootDirectory.root, 'ssh-project-marker.txt');
		});
		await test.step('Open the selected fork in its SSH worktree', async () => {
			await row.press('ArrowRight');
			await agents.locator('.ash-sessions-list').getByRole('treeitem', { name: /^SSH worktree conversation\b/u }).locator('.ash-sessions-list-item').click();
			await assertHandoff(forkThread, directory.root, 'ssh-worktree-marker.txt');
		});
	} finally {
		try {
			await seed?.close();
		} finally {
			try {
				if (desktop) {
					const path = testInfo.outputPath('ssh-ide-trace.zip');
					await desktop.driver.workbench.page.context().tracing.stop({ path }).then(() => testInfo.attach('trace', { path, contentType: 'application/zip' })).catch(() => { });
					await desktop.close();
				}
			} finally {
				await ssh.close();
			}
		}
	}
});

test('IDE opens an SSH conversation link and continues on its original host', { tag: ['@electron-app-server', '@darwin'] }, async () => {
	test.setTimeout(120_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const ssh = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'));
	const modelId = 'remote-link-model';
	const origin = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: modelId }] }));
			return;
		}
		for await (const _ of request) { /* Consume the fixture request body. */ }
		const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'remote-link', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(chunk({ content: 'Answer from the SSH host' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
	});
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let seed: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
		const address = origin.address();
		if (!address || typeof address === 'string') throw new Error('Missing model fixture address');
		const localRoot = join(ssh.root, 'local-workspace');
		const remoteRoot = join(ssh.root, 'remote-workspace');
		await Promise.all([mkdir(localRoot), mkdir(remoteRoot)]);
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(ssh.root, 'desktop'), workspaceDirectory: localRoot, workspacePermissions: 'development',
			environment: { ...process.env, ASH_SSH_PATH: ssh.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { page, quickaccess } = desktop.driver.workbench;
		seed = await connectProfile(desktop.application, undefined, remoteRoot, page, { profileRoot: join(ssh.root, 'remote-profile'), directoryGrantsHost: true });
		const { client } = seed;
		const grants = await client.request(methods['config/directoryGrants/list'], {});
		await client.request(methods['config/directoryGrants/set'], {
			commandId: 'remote-link-grant', expectedRevision: grants.revision, path: remoteRoot,
			permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository', 'discoverPlugins'],
		});
		const provider = 'custom-remote-link-fixture';
		const config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], {
			commandId: 'remote-link-provider', expectedRevision: config.revision, config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Remote link fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [modelId]: { contextWindow: 272_000 } },
			},
		});
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-remote-link-fixture-key' });
		const title = 'SSH link fixture';
		const { session } = await client.request(methods['session/create'], {
			commandId: 'remote-link-session', kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: remoteRoot },
		});
		const sessionId = session.sessionId;
		const threadId = session.threads[0].threadId;
		const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
		await client.request(methods['session/request'], {
			sessionId, commandId: 'remote-link-first-turn', request: {
				type: 'startTurn', threadId, expectedSequence: (await read()).sequence, mode: 'ask', approvalMode: 'manual',
				model: { provider, model: modelId }, input: [{ type: 'text', text: 'Initial remote message' }],
			},
		});
		await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
		await page.evaluate(connection => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:save', { connection }), {
			name: 'link-ssh-host', host: ssh.host, workspace: remoteRoot,
		});
		await quickaccess.runCommand('workbench.action.chat.open');

		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const input = chat.locator('.stanza-editor-input');
		const providerId = `ssh-agent-host:${JSON.stringify([ssh.host, remoteRoot])}`;
		const link = buildOpenSessionLinkUri(sessionId, threadId, sessionProviderAuthority(providerId, 'local-agent-host'));
		await input.focus();
		await page.keyboard.insertText(link.toString());
		await expect(chat.locator('.stanza-editor')).toContainText('agent-host-session://');
		await page.keyboard.press('ArrowLeft');
		const connectionsBeforeConfirm = ssh.connectionCount;
		await quickaccess.runCommand('editor.action.openLink');
		const confirm = page.getByRole('dialog').filter({ hasText: 'Connect to link-ssh-host and open the conversation?' });
		await expect(confirm).toContainText(ssh.host);
		await expect(confirm).toContainText(remoteRoot);
		await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(confirm).toHaveCount(0);
		expect(ssh.connectionCount).toBe(connectionsBeforeConfirm);
		await expect(chat.locator('.stanza-editor')).toContainText('agent-host-session://');

		await input.focus();
		await quickaccess.runCommand('editor.action.openLink');
		await confirm.getByRole('button', { name: 'Connect and Open', exact: true }).click();
		await expect(chat).toHaveAttribute('data-thread-id', threadIdentity(providerId, threadId, 'local-agent-host'));
		await expect(chat.getByText('Initial remote message')).toBeVisible();
		await quickaccess.runCommand('workbench.action.chat.showHistory');
		await expect(page.getByRole('option').filter({ hasText: title })).toContainText('link-ssh-host');
		await quickaccess.close();

		await input.focus();
		await page.keyboard.insertText('Follow-up sent from the IDE');
		await page.keyboard.press('Enter');
		await expect.poll(async () => {
			const thread = await read();
			return [thread.turns.length, thread.turns.at(-1)?.status];
		}).toEqual([2, 'completed']);
		await expect(chat.getByText('Follow-up sent from the IDE')).toBeVisible();

		await input.focus();
		await page.keyboard.insertText('Draft retained after SSH recovery');
		const connectionsBeforeDrop = ssh.connectionCount;
		ssh.disconnect();
		await expect.poll(() => ssh.connectionCount, { timeout: 30_000 }).toBeGreaterThan(connectionsBeforeDrop);
		await quickaccess.runCommand('sessions.action.manageAgentHosts');
		const hosts = page.getByRole('dialog', { name: 'Remote Environments' });
		await expect(hosts.getByRole('row').filter({ hasText: 'link-ssh-host' })).toContainText('Connected');
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(chat).toHaveAttribute('data-thread-id', threadIdentity(providerId, threadId, 'local-agent-host'));
		await expect(chat.locator('.stanza-editor')).toContainText('Draft retained after SSH recovery');
		await expect.poll(async () => (await read()).turns.length).toBe(2);
		await expect(chat.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled({ timeout: 30_000 });
		await input.focus();
		await page.keyboard.press('Enter');
		await expect.poll(async () => {
			const thread = await read();
			return [thread.turns.length, thread.turns.at(-1)?.status];
		}, { timeout: 30_000 }).toEqual([3, 'completed']);
		await expect(chat.getByText('Draft retained after SSH recovery')).toBeVisible();
	} finally {
		await seed?.close();
		await desktop?.close();
		origin.closeAllConnections();
		if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()));
		await ssh.close();
	}
});
