import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test as base } from '../../../automation/test.js';
import { APP_SERVER_METHODS, type Thread, type Turn } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { TaskAgentModelFixture, taskLabel, taskMarker, taskModel } from './taskAgentModelFixture.js';

const test = base.extend<{ taskKind: 'process' | 'shell'; mockModel: TaskAgentModelFixture; }>({
	taskKind: ['process', { option: true }],
	testWorkspace: async ({ testWorkspace, taskKind }, use) => {
		await mkdir(join(testWorkspace.directory, '.vscode'), { recursive: true });
		await writeFile(join(testWorkspace.directory, '.vscode/tasks.json'), JSON.stringify({
			version: '2.0.0', tasks: [{ label: taskLabel, type: taskKind, command: 'node', args: ['task-loop.cjs'], presentation: { echo: true, reveal: 'always', focus: false, panel: 'new' } }],
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
});

// The Task tools and their approval UI must belong to the same Agents window.
test.use({
	electronArgs: ['--agents-window'],
	electronUserSettings: { 'models.hidden': [{ ...taskModel, visible: true }] },
});

interface TaskResult {
	runId: string;
	taskId: string;
	terminalId: string;
	status: string;
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

async function completedTurn(page: Page, read: () => Promise<Thread>, count: number, approve: boolean): Promise<Turn> {
	let approved = 0;
	let completed: Turn | undefined;
	await expect.poll(async () => {
		const button = page.getByRole('button', { name: 'Approve once', exact: true });
		if (await button.isVisible()) {
			expect(approve, 'Only starting the Task requires approval').toBe(true);
			const interaction = page.locator(':is(.ash-chat-interaction,.ash-cowork-interaction):visible');
			await expect(interaction).toContainText(taskLabel);
			await expect(interaction).toContainText('task-loop.cjs');
			await button.click();
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

for (const taskKind of ['process', 'shell'] as const) {
	test.describe(taskKind, () => {
		test.use({ taskKind });
		test('Mock Agent Task loop discovers, runs, reads and cancels one shared execution', { tag: '@electron-app-server' }, async ({ application, workbench, testWorkspace, mockModel }, testInfo) => {
			test.setTimeout(180_000);
			const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true });
			const { client } = connection;
			let readThread: (() => Promise<Thread>) | undefined;
			let scenarioPage: Page | undefined;
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
				scenarioPage = page;
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
			} finally {
				try {
					if (testInfo.status !== testInfo.expectedStatus && scenarioPage && !scenarioPage.isClosed()) {
						await testInfo.attach('task-agent-window', { body: await scenarioPage.screenshot(), contentType: 'image/png' });
					}
					await testInfo.attach('mock-model-exchanges', { body: JSON.stringify({ exchanges: mockModel.exchanges, errors: mockModel.errors }, null, 2), contentType: 'application/json' });
					if (readThread) await testInfo.attach('agent-thread', { body: JSON.stringify(await readThread(), null, 2), contentType: 'application/json' });
				} finally { await connection.close(); }
			}
		});
	});
}
