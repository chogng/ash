import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { expect, test as base } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import type { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

const test = base.extend<{ debugModel: Awaited<ReturnType<typeof modelFixture>> }>({
	debugModel: async ({}, use) => {
		const model = await modelFixture();
		try {
			await use(model);
		} finally {
			await model.close();
		}
	},
	backendConfiguration: async ({ testWorkspace, debugModel }, use) => {
		await use(configuration(testWorkspace.directory, debugModel.url));
	},
});

function configuration(root: string, endpoint: string): string {
	return `schemaVersion = 10\n[agent.trace]\nenabled = true\ndirectory = ${JSON.stringify(join(root, 'debug-log-trace'))}\n[connections.custom-debug-logs]\nprovider = "custom-debug-logs"\nconnection = "custom-debug-logs"\nbaseUrl = ${JSON.stringify(endpoint)}\n[connections.custom-debug-logs.custom]\nprotocol = "responses"\nname = "Debug logs fixture"\ncontextWindow = 272000\norder = 0\nmodel = "debug-log-model"\n`;
}

async function modelFixture() {
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			/* Consume the synthetic model input. */
		}
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(
			`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'debug-logs-response', status: 'completed', output: [{ type: 'message', id: 'debug-logs-answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'debug-logs-saved-model-response' }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
		);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Model fixture has no port');
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		},
	};
}

async function seedSession(client: AppServerProtocolClient, root: string, title: string) {
	const provider = 'custom-debug-logs';
	const model = { provider, model: 'debug-log-model' };
	const { session } = await client.request(methods['session/create'], {
		commandId: 'debug-logs-session',
		title,
		agent: { type: 'default' },
		executionTarget: { type: 'local', root },
	});
	const threadId = session.threads[0].threadId;
	const read = () => client.request(methods['session/thread/read'], { sessionId: session.sessionId, threadId });
	await client.request(methods['session/request'], {
		sessionId: session.sessionId,
		commandId: 'debug-log-turn',
		request: {
			type: 'startTurn',
			threadId,
			expectedSequence: (await read()).thread.sequence,
			model,
			mode: 'ask',
			toolMode: 'direct',
			approvalMode: 'manual',
			input: [{ type: 'text', text: 'debug-logs-saved-user-request' }],
		},
	});
	await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
	return session;
}

async function exportBundle(window: Workbench, application: PlaywrightApplication, testInfo: TestInfo) {
	let archivePath: string;
	if ('windows' in application) {
		archivePath = testInfo.outputPath('debug-logs.zip');
		await application.evaluate(
			({ BrowserWindow }, { url, path }) => {
				const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
				if (!owner) throw new Error('Export window is missing');
				owner.webContents.session.once('will-download', (_event, item) => item.setSavePath(path));
			},
			{ url: window.page.url(), path: archivePath },
		);
		await window.quickaccess.runCommand('workbench.action.chat.exportAgentHostDebugLogs');
		await expect
			.poll(async () => {
				try {
					return (await readFile(archivePath)).readUInt32LE(0);
				} catch {
					return undefined;
				}
			})
			.toBe(0x04034b50);
	} else {
		const download = window.page.waitForEvent('download');
		await window.quickaccess.runCommand('workbench.action.chat.exportAgentHostDebugLogs');
		const completed = await download;
		expect(completed.suggestedFilename()).toBe('ash-agent-host-debug-logs.zip');
		archivePath = (await completed.path())!;
	}
	const bytes = await readFile(archivePath);
	const files = new Map<string, string>();
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		const length = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const start = offset + 30 + nameLength;
		files.set(bytes.subarray(offset + 30, start).toString('utf8'), bytes.subarray(start, start + length).toString('utf8'));
		offset = start + length;
	}
	const manifest = JSON.parse(files.get('manifest.json')!);
	const bodies = [...files]
		.filter(([name]) => name.startsWith('session/payloads/'))
		.map(([, body]) => body)
		.join('\n');
	expect(bodies).toContain('debug-logs-saved-user-request');
	expect(bodies).toContain('debug-logs-saved-model-response');
	expect(manifest.coverage.requestPayloads.references.some((entry: { kind: string; status: string }) => entry.kind === 'coreRequest' && entry.status === 'saved')).toBe(true);
	expect(manifest.coverage.requestPayloads.references.some((entry: { kind: string; status: string }) => entry.kind === 'modelResponse' && entry.status === 'saved')).toBe(true);
	await testInfo.attach('debug-logs.zip', { path: archivePath, contentType: 'application/zip' });
	return { files, manifest };
}

for (const surface of ['IDE', 'Agent Window'] as const) {
	test(
		`${surface} exports debug logs for the active session from the Command Palette`,
		{ tag: ['@electron-app-server', '@browser-app-server'] },
		async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
			const agents = surface === 'Agent Window';
			const page = agents ? await workbench.openAgentsWindow(target.kind) : workbench.page;
			const window = new Workbench(page);
			const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
			try {
				const session = await seedSession(connection.client, testWorkspace.directory, 'Debug logs source');
				const threadId = session.threads[0].threadId;
				if (agents) {
					await page.locator('.ash-sessions-list-item').filter({ hasText: 'Debug logs source' }).click();
				} else {
					await window.quickaccess.runCommand('workbench.action.chat.open');
					if (!(await page.locator('.ash-chat-sessions-sidebar').isVisible())) await window.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar');
					await page.locator('.ash-chat-sessions-sidebar .ash-agent-session-row').filter({ hasText: 'Debug logs source' }).click();
				}
				const chat = page.locator(agents ? '.ash-sessions-chat-slot.active:visible [data-thread-id]' : '.ash-chat-view-pane .ash-chat:visible').first();
				await expect(chat).toHaveAttribute('data-thread-id', threadId);
				const { files, manifest } = await exportBundle(window, application, testInfo);
				expect(manifest.conversation).toEqual({ sessionId: session.sessionId, threadId });
				expect(manifest.issues.filter((issue: { source: string }) => issue.source.startsWith('session'))).toEqual([]);
				expect(JSON.parse(files.get('session/trace-1.json')!).trace.sessionId).toBe(session.sessionId);
				expect(files.has('session/diagnostics-1.json')).toBe(true);
				if (target.kind === 'electron') {
					expect(manifest.sources.some((source: { source: string }) => source.source === 'app-server')).toBe(true);
					expect(manifest.sources.some((source: { source: string }) => /window-\d+\.log$/u.test(source.source))).toBe(true);
				}
				await expect(chat).toHaveAttribute('data-thread-id', threadId);
			} finally {
				await connection.close();
			}
		},
	);
}

test('SSH debug logs contain the remote process, its rotations and saved model bodies', { tag: ['@electron-app-server', '@darwin'] }, async ({ debugModel }, testInfo) => {
	test.setTimeout(180_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const daemon = join(packageRoot, 'bin/ash-app-server-daemon');
	const fixture = await createSshFixture(daemon);
	const workspace = join(fixture.root, 'workspace');
	const profile = join(fixture.root, 'remote-profile');
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		await mkdir(workspace);
		await writeFile(join(profile, 'config.toml'), configuration(profile, debugModel.url));
		desktop = await launchElectron({
			appServerMode: 'required',
			userDataDirectory: join(fixture.root, 'desktop'),
			workspaceDirectory: workspace,
			workspacePermissions: 'development',
			extraArgs: [`--remote-ssh=${fixture.host}`],
			environment: {
				...process.env,
				ASH_SSH_PATH: fixture.ssh,
				ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server'),
			},
		});
		const window = desktop.driver.workbench;
		await expect(window.page.locator('[data-statusbar-item-id="ash.status.remote"]')).toHaveAttribute('aria-label', `Remote connection to SSH host ${fixture.host} is ready`);
		// Seed only the isolated remote profile through its public API. The window's export uses OpenSSH.
		connection = await connectProfile(desktop.application, undefined, workspace, window.page, {
			profileRoot: profile,
		});
		const session = await seedSession(connection.client, workspace, 'SSH debug logs source');
		const { stdout } = await promisify(execFile)(daemon, ['version'], {
			env: { ...process.env, ASH_HOME: profile },
		});
		const log = JSON.parse(stdout).logPath as string;
		await appendFile(log, 'remote-process-debug-export-marker\n');
		await writeFile(`${log}.1`, 'remote-rotated-debug-export-marker\n');
		await window.quickaccess.runCommand('workbench.action.chat.open');
		if (!(await window.page.locator('.ash-chat-sessions-sidebar').isVisible())) await window.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar');
		await window.page.locator('.ash-chat-sessions-sidebar .ash-agent-session-row').filter({ hasText: 'SSH debug logs source' }).click();
		const { files, manifest } = await exportBundle(window, desktop.application, testInfo);
		expect(manifest.conversation.sessionId).toBe(session.sessionId);
		expect(manifest.coverage.sessionHostProcessLogs).toBe('collected');
		const hostLogs = [...files]
			.filter(([name]) => name.startsWith('host/'))
			.map(([, content]) => content)
			.join('\n');
		expect(hostLogs).toContain('remote-process-debug-export-marker');
		expect(hostLogs).toContain('remote-rotated-debug-export-marker');
	} finally {
		try {
			await connection?.close();
			await desktop?.close();
		} finally {
			await fixture.close();
		}
	}
});
