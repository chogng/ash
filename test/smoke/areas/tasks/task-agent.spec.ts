import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { expect, test as base } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { APP_SERVER_METHODS, type Thread, type Turn } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { TaskAgentModelFixture, taskLabel, taskMarker, taskModel } from './taskAgentModelFixture.js';

interface TaskSession {
	client: AppServerProtocolClient; page: Page; directory: string; sessionId: string; readThread(): Promise<Thread>;
}

const test = base.extend<{ taskKind: 'process' | 'shell'; startupFailure: boolean; mockModel: TaskAgentModelFixture; taskSession: TaskSession; }>({
	taskKind: ['process', { option: true }],
	startupFailure: [false, { option: true }],
	testWorkspace: async ({ testWorkspace, taskKind, startupFailure }, use) => {
		await mkdir(join(testWorkspace.directory, '.vscode'), { recursive: true });
		await writeFile(join(testWorkspace.directory, '.vscode/tasks.json'), JSON.stringify({
			version: '2.0.0', tasks: [{ label: taskLabel, type: taskKind, command: startupFailure ? 'ash-task-fixture-missing-executable-7f0c2' : 'node', args: ['task-loop.cjs'], presentation: { echo: true, reveal: 'always', focus: false, panel: 'new' } }],
		}));
		await writeFile(join(testWorkspace.directory, 'task-loop.cjs'),
			"const fs = require('node:fs'); fs.appendFileSync('task-starts.jsonl', JSON.stringify({pid:process.pid}) + String.fromCharCode(10)); console.log('" + taskMarker + " pid=' + process.pid + ' 😀'); setInterval(() => console.log('TASK_TICK pid=' + process.pid), 500);");
		await writeFile(join(testWorkspace.directory, 'task-starts.jsonl'), '');
		await use(testWorkspace);
	},
	mockModel: async ({ }, use) => {
		const model = new TaskAgentModelFixture();
		await model.start();
		try { await use(model); } finally { await model.close(); }
	},
	taskSession: async ({ application, workbench, testWorkspace, mockModel }, use, testInfo) => {
		const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true });
		const { client } = connection;
		let readThread: (() => Promise<Thread>) | undefined;
		try {
			await expect(workbench.page.locator('.ash-sessions-window')).toBeVisible();
			const initial = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'task-fixture-provider', expectedRevision: initial.revision, config: {
					connection: taskModel.provider, provider: taskModel.provider, baseUrl: mockModel.baseUrl,
					custom: { name: 'Task regression mock', protocol: 'responses', order: 0, contextWindow: 272_000 },
					modelContext: { [taskModel.model]: { contextWindow: 272_000 } },
				}
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: taskModel.provider, apiKey: 'synthetic-fixture-key' });
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'task-fixture-model', expectedRevision: config.revision, model: taskModel, execution: { ...config.execution, approvalMode: 'manual' } });
			const permissions = ['readFiles', 'browseFiles', 'watchFiles', 'executeCommands'] as const;
			const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'task-fixture-session', title: 'Mock Agent Task Regression', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0]!.threadId;
			const snapshot = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			if (snapshot.directory?.type !== 'local') throw new Error('Task fixture needs the actual local Thread directory');
			const directory = snapshot.directory.root;
			await client.request(APP_SERVER_METHODS['session/dirs/add'], { sessionId, path: directory, permissions: [...permissions] });
			readThread = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			mockModel.selectDirectory(directory);
			const page = workbench.page;

			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Mock Agent Task Regression' }).click();
			const active = page.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
			await active.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
			const auto = picker.getByRole('switch', { name: 'Auto', exact: true });
			if (await auto.isChecked()) await auto.press('Space');
			await picker.getByRole('combobox').fill(taskModel.model);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await picker.getByRole('combobox').press('Enter');
			await use({ client, page, directory, sessionId, readThread: readThread! });
		} finally {
			try {
				if (testInfo.status !== testInfo.expectedStatus && !workbench.page.isClosed()) await testInfo.attach('task-agent-window', { body: await workbench.page.screenshot(), contentType: 'image/png' });
				await testInfo.attach('mock-model-exchanges', { body: JSON.stringify({ exchanges: mockModel.exchanges, errors: mockModel.errors }, null, 2), contentType: 'application/json' });
				if (readThread) await testInfo.attach('agent-thread', { body: JSON.stringify(await readThread(), null, 2), contentType: 'application/json' });
			} finally { await connection.close(); }
		}
	},
});

// The Task tools and their approval UI must belong to the same Agents window.
test.use({
	electronArgs: ['--agents-window'],
	electronUserSettings: { 'models.hidden': [{ ...taskModel, visible: true }] },
});
test.describe.configure({ timeout: 180_000 });

interface TaskResult {
	runId: string;
	taskId: string;
	terminalId: string;
	status: string;
	exitCode: number | null;
	text: string;
	cursor: number;
	nextCursor: number;
}

function toolEvidence(turn: Turn) {
	const calls = turn.items.filter(item => item.type === 'toolCall');
	return turn.items.filter(item => item.type === 'toolResult').map(item => {
		const call = calls.find(call => call.toolCallId === item.toolCallId);
		if (!call) throw new Error('Tool result has no matching call');
		expect(item.isError, item.text).toBe(false);
		return { name: call.name, arguments: JSON.parse(call.argumentsJson) as Record<string, unknown>, result: JSON.parse(item.text) as TaskResult };
	});
}

async function submit(page: Page, text: string): Promise<void> {
	const slot = page.locator('.ash-sessions-chat-slot.active:visible');
	await slot.locator('.stanza-editor-input').first().focus();
	await page.keyboard.insertText(text);
	await slot.locator('[data-action-id="ash.chat.input.send"] button').click();
}

async function completedTurn(page: Page, read: () => Promise<Thread>, count: number, approve: boolean | 'decline' | (() => Promise<void>)): Promise<Turn> {
	let approved = 0;
	let completed: Turn | undefined;
	await expect.poll(async () => {
		const button = page.getByRole('button', { name: 'Approve once', exact: true });
		if (await button.isVisible()) {
			expect(approve, 'Only starting the Task requires approval').not.toBe(false);
			const interaction = page.locator(':is(.ash-chat-interaction,.ash-cowork-interaction):visible');
			await expect(interaction).toContainText(taskLabel);
			await expect(interaction).toContainText('task-loop.cjs');
			if (typeof approve === 'function') await approve();
			await page.getByRole('button', { name: approve === 'decline' ? 'Decline' : 'Approve once', exact: true }).click();
			await expect(button).toBeHidden();
			approved++;
		}
		const thread = await read();
		const turn = thread.turns[count - 1];
		if (turn?.status === 'failed' || turn?.status === 'interrupted') throw new Error('Agent Turn failed: ' + JSON.stringify(turn));
		if (turn?.status === 'completed') completed = turn;
		return completed !== undefined;
	}, { timeout: 90_000, intervals: [100, 250, 500] }).toBe(true);
	expect(approved).toBe(approve ? 1 : 0);
	return completed!;
}

async function revokeCommands(session: TaskSession): Promise<void> {
	const { revision } = await session.client.request(APP_SERVER_METHODS['session/dirs/list'], { sessionId: session.sessionId });
	const permissions = ['readFiles', 'browseFiles', 'watchFiles'] as const;
	await session.client.request(APP_SERVER_METHODS['session/dirs/permissions/set'], { sessionId: session.sessionId, path: session.directory, expectedRevision: revision, permissions: [...permissions] });
	const current = await session.client.request(APP_SERVER_METHODS['session/dirs/list'], { sessionId: session.sessionId });
	expect(current.dirs.find(dir => dir.path === session.directory)?.permissions.slice().sort()).toEqual([...permissions].sort());
}

function rejectedRun(turn: Turn, reason: string): void {
	const calls = turn.items.filter(item => item.type === 'toolCall');
	expect(calls.map(call => call.name)).toEqual(['tasks_list', 'tasks_run']);
	const call = calls[1]!;
	const result = turn.items.find(item => item.type === 'toolResult' && item.toolCallId === call.toolCallId);
	expect(result?.type).toBe('toolResult');
	if (result?.type !== 'toolResult') throw new Error('Missing declined tool result');
	expect(result.isError).toBe(true);
	expect(result.text).toContain(reason);
}

async function processStarts(directory: string): Promise<{ pid: number; }[]> {
	const text = (await readFile(join(directory, 'task-starts.jsonl'), 'utf8')).trim();
	return text ? text.split('\n').map(line => JSON.parse(line)) : [];
}

async function processExited(pid: number): Promise<void> {
	await expect.poll(() => {
		try { process.kill(pid, 0); return true; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			return false;
		}
	}, { timeout: 15_000 }).toBe(false);
}

async function showTasks(page: Page): Promise<void> {
	const panel = page.locator('[data-part="panel"]');
	if (!await panel.isVisible()) await new QuickAccess(page).runCommand('ash.sessions.togglePanel');
	await panel.getByRole('tab', { name: 'Tasks', exact: true }).click();
}

async function runningTask(session: TaskSession): Promise<{ runId: string; terminalId: string; pid: number; }> {
	await submit(session.page, 'TASK_FIXTURE_RUN: Discover and run ' + taskLabel + ' once, query status and read output.');
	const turn = await completedTurn(session.page, session.readThread, 1, true);
	const evidence = toolEvidence(turn);
	expect(evidence.filter(item => item.name === 'tasks_run')).toHaveLength(1);
	const runId = evidence.find(item => item.name === 'tasks_run')!.result.runId;
	const status = evidence.find(item => item.name === 'tasks_status' && item.result.status === 'running' && item.result.terminalId);
	expect(status?.result.runId).toBe(runId);
	const starts = await processStarts(session.directory);
	expect(starts).toHaveLength(1);
	const pid = starts[0]!.pid;
	expect(evidence.find(item => item.name === 'tasks_output' && item.result.text.includes(taskMarker))?.result.text).toContain(taskMarker + ' pid=' + pid);
	// Assert the fixture process is live before any cleanup action is exercised.
	expect(() => process.kill(pid, 0)).not.toThrow();
	return { runId, terminalId: status!.result.terminalId, pid };
}

for (const taskKind of ['process', 'shell'] as const) {
	test.describe(taskKind, () => {
		test.use({ taskKind });
		test('Mock Agent Task loop refuses a declined approval without starting a process', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
			mockModel.expectOutcome('denied');
			await submit(taskSession.page, 'TASK_FIXTURE_RUN: Discover and run the existing Task.');
			const declined = await completedTurn(taskSession.page, taskSession.readThread, 1, 'decline');
			rejectedRun(declined, 'user declined');
			expect(await processStarts(taskSession.directory)).toEqual([]);
			await showTasks(taskSession.page);
			await expect(taskSession.page.locator('[data-run-id]')).toHaveCount(0);
			expect(mockModel.errors).toEqual([]);
		});

		test.describe('startup failure', () => {
			test.use({ startupFailure: true });
			test('Mock Agent Task loop retains the failed Run ID and real launch error', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('failed');
				await submit(taskSession.page, 'TASK_FIXTURE_RUN: Discover and run the existing Task, then report status and output.');
				const failed = toolEvidence(await completedTurn(taskSession.page, taskSession.readThread, 1, true));
				expect(failed.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				const runId = failed.find(item => item.name === 'tasks_run')!.result.runId;
				expect(runId).toBeTruthy();
				const status = failed.find(item => item.name === 'tasks_status' && item.result.status === 'failed')!.result;
				expect(status.runId).toBe(runId);
				const output = failed.find(item => item.name === 'tasks_output')!;
				expect(output.arguments.run_id).toBe(runId);
				if (taskKind === 'process') {
					expect(output.result.text).toBe('TerminalOperationFailed');
					expect(status.terminalId).toBe('');
					expect(status.exitCode).toBeNull();
				} else {
					expect(output.result.text).toContain('ash-task-fixture-missing-executable-7f0c2');
					expect(status.terminalId).toBeTruthy();
					expect(status.exitCode).not.toBe(0);
					expect(status.exitCode).not.toBeNull();
				}
				expect(output.result.text).not.toContain(taskMarker);
				expect(await processStarts(taskSession.directory)).toEqual([]);
				await showTasks(taskSession.page);
				await expect(taskSession.page.locator('[data-run-id="' + runId + '"]')).toContainText(taskLabel + ' — Failed');
				expect(mockModel.errors).toEqual([]);
			});
		});

		test('Mock Agent Task loop rechecks revoked command permission after approval', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
			mockModel.expectOutcome('revoked');
			await submit(taskSession.page, 'TASK_FIXTURE_RUN: Discover and run the existing Task.');
			const revoked = await completedTurn(taskSession.page, taskSession.readThread, 1, () => revokeCommands(taskSession));
			rejectedRun(revoked, 'granted capabilities');
			expect(await processStarts(taskSession.directory)).toEqual([]);
			await showTasks(taskSession.page);
			await expect(taskSession.page.locator('[data-run-id]')).toHaveCount(0);
			expect(mockModel.errors).toEqual([]);
		});

		test('Mock Agent Task loop releases the running process when command permission is revoked', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
			const { runId, pid } = await runningTask(taskSession);
			await revokeCommands(taskSession);
			await processExited(pid);
			mockModel.beginFollowup();
			await submit(taskSession.page, 'TASK_FIXTURE_INSPECT: Read the original Run status and retained output after permission revocation.');
			const stopped = toolEvidence(await completedTurn(taskSession.page, taskSession.readThread, 2, false));
			expect(stopped.at(-1)!.name).toBe('tasks_output');
			expect(stopped.slice(0, -1).every(item => item.name === 'tasks_status')).toBe(true);
			for (const item of stopped) expect(item.arguments.run_id).toBe(runId);
			expect(['failed', 'canceled']).toContain(stopped.at(-2)!.result.status);
			expect(stopped.at(-1)!.result.text).toContain(taskMarker + ' pid=' + pid);
			mockModel.beginFollowup();
			mockModel.expectOutcome('revoked');
			await submit(taskSession.page, 'TASK_FIXTURE_RETRY: Discover and attempt the same Task once after command permission revocation.');
			rejectedRun(await completedTurn(taskSession.page, taskSession.readThread, 3, false), 'granted capabilities');
			expect(await processStarts(taskSession.directory)).toEqual([{ pid }]);
			expect(mockModel.errors).toEqual([]);
		});

		test('Mock Agent Task loop closes its process with the owning window while the backend stays alive', { tag: '@electron-app-server' }, async ({ taskSession, mockModel, application }) => {
			if (!('browserWindow' in application)) throw new Error('Expected Electron');
			const { pid, runId } = await runningTask(taskSession);
			// Keep Main and the profile daemon alive with an inert test-owned window.
			// The assertion must precede application/daemon fixture teardown.
			await application.evaluate(async ({ BrowserWindow }) => {
				const anchor = new BrowserWindow({ show: false });
				await anchor.loadURL('about:blank');
			});
			const window = await application.browserWindow(taskSession.page);
			const closed = taskSession.page.waitForEvent('close');
			await window.evaluate(window => window.close());
			await closed;
			await processExited(pid);
			expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
			expect((await taskSession.client.request(APP_SERVER_METHODS['diagnostics/read'], {})).build.version).toBeTruthy();
			const retained = toolEvidence((await taskSession.readThread()).turns[0]!);
			expect(retained.find(item => item.name === 'tasks_run')?.result.runId).toBe(runId);
			expect(retained.some(item => item.name === 'tasks_cancel')).toBe(false);
			expect(await processStarts(taskSession.directory)).toEqual([{ pid }]);
			expect(mockModel.errors).toEqual([]);
		});

		test('Mock Agent Task loop discovers, runs, reads and cancels one shared execution', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
			test.setTimeout(180_000);
			const { page, readThread, directory } = taskSession;

			const running = await test.step('Agent discovers, approves and starts the existing Task exactly once', async () => {
				await submit(page, 'TASK_FIXTURE_RUN: Discover ' + taskLabel + ' in ' + directory + ', run it once, query its Run ID and read output. Use only Task tools.');
				return completedTurn(page, readThread!, 1, true);
			});
			expect(running.model).toEqual(taskModel);
			const results = toolEvidence(running);
			expect(results.slice(0, 2).map(result => result.name)).toEqual(['tasks_list', 'tasks_run']);
			expect(results.slice(2).every(result => result.name === 'tasks_status' || result.name === 'tasks_output')).toBe(true);
			const starts = results.filter(result => result.name === 'tasks_run');
			expect(starts).toHaveLength(1);
			const runId = starts[0]!.result.runId;
			const status = results.find(result => result.name === 'tasks_status' && result.result.status === 'running' && result.result.terminalId);
			expect(status).toBeDefined();
			expect(status!.result.runId).toBe(runId);
			const terminalId = status!.result.terminalId;
			const output = results.find(result => result.name === 'tasks_output' && result.result.text.includes(taskMarker));
			expect(output).toBeDefined();
			const processStarts = async (): Promise<{ pid: number; }[]> => (await readFile(join(directory, 'task-starts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			const launched = await processStarts();
			expect(launched).toHaveLength(1);
			const pid = launched[0]!.pid;
			expect(output!.result.text).toContain('pid=' + pid + ' 😀');
			expect(output!.result.cursor).toBe(0);
			expect(output!.result.nextCursor).toBe(output!.result.text.length);
			for (const result of results.filter(result => result.name === 'tasks_status' || result.name === 'tasks_output')) expect(result.arguments.run_id).toBe(runId);

			await test.step('Tasks and Terminal expose the same Run, terminal and real PID', async () => {
				const terminal = page.locator('.ash-terminal-instance:visible');
				await expect(terminal).toContainText(taskMarker + ' pid=' + pid);
				await page.locator('[data-part="panel"]').getByRole('tab', { name: 'Tasks', exact: true }).click();
				const row = page.locator('[data-run-id="' + runId + '"]');
				await expect(row).toHaveAttribute('data-terminal-id', terminalId);
				await expect(row).toContainText(taskLabel + ' — Running');
				await row.click();
				await expect(terminal).toContainText(taskMarker + ' pid=' + pid);
			});
			await test.step('Agent cancels the original Run; process exits and output is retained', async () => {
				await submit(page, 'TASK_FIXTURE_CANCEL: Cancel Run ID ' + runId + ', query canceled status and read its retained output. Use only Task tools.');
				const canceled = await completedTurn(page, readThread!, 2, false);
				const evidence = toolEvidence(canceled);
				expect(evidence.map(result => result.name)).toEqual(['tasks_cancel', 'tasks_status', 'tasks_output']);
				for (const result of evidence) expect(result.arguments.run_id).toBe(runId);
				expect(evidence[0]!.result.status).toBe('canceled');
				expect(evidence[1]!.result).toMatchObject({ runId, terminalId, status: 'canceled' });
				expect(evidence[2]!.result.text).toContain(taskMarker + ' pid=' + pid + ' 😀');
				expect(evidence[2]!.result.text.startsWith(output!.result.text)).toBe(true);
				expect(evidence[2]!.result.nextCursor).toBe(evidence[2]!.result.text.length);
				await expect.poll(() => {
					try { process.kill(pid, 0); return true; } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
						return false;
					}
				}, { timeout: 15_000 }).toBe(false);
				await page.locator('[data-part="panel"]').getByRole('tab', { name: 'Tasks', exact: true }).click();
				await expect(page.locator('[data-run-id="' + runId + '"]')).toContainText(taskLabel + ' — Canceled');
				expect(await processStarts()).toEqual(launched);
				expect(mockModel.errors).toEqual([]);
			});
		});
	});
}
