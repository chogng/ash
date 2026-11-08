import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import { buildOpenSessionLinkUri } from '../../../../src/ash/platform/agentHost/common/openSessionLink.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import { sessionProviderAuthority, threadIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

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
		await expect(quickaccess.items.filter({ hasText: 'link-ssh-host' })).toContainText('Connected');
		await quickaccess.close();
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
