import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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

const pagePayload = 'a😀中éb😀终';
const firstPayload = 'FIRST_RUN_ONLY 😀';
const secondPayload = 'SECOND_RUN_ONLY 中';
type TaskScenario = 'loop' | 'dependencies' | 'background' | 'pages' | 'reuse' | 'dependency-failure' | 'dependency-cancel' | 'background-pending' | 'truncated';

const test = base.extend<{ taskScenario: TaskScenario; taskKind: 'process' | 'shell'; startupFailure: boolean; mockModel: TaskAgentModelFixture; taskSession: TaskSession; }>({
	taskScenario: ['loop', { option: true }],
	taskKind: ['process', { option: true }],
	startupFailure: [false, { option: true }],
	testWorkspace: async ({ testWorkspace, taskKind, startupFailure, taskScenario }, use) => {
		const directory = testWorkspace.directory;
		await mkdir(join(directory, '.vscode'), { recursive: true });
		const presentation = { echo: taskScenario !== 'pages' && taskScenario !== 'reuse' && taskScenario !== 'truncated', reveal: 'always', focus: false, panel: taskScenario === 'reuse' ? 'shared' : 'new', clear: taskScenario === 'reuse' };
		const root = { label: taskLabel, type: taskKind, command: startupFailure ? 'ash-task-fixture-missing-executable-7f0c2' : 'node', args: ['task-loop.cjs'], presentation };
		let tasks: unknown[] = [root];
		const starts = "fs.appendFileSync('task-starts.jsonl', JSON.stringify({pid:process.pid}) + String.fromCharCode(10));";
		let script = "const fs = require('node:fs'); " + starts + "console.log('" + taskMarker + " pid=' + process.pid + ' 😀'); setInterval(() => console.log('TASK_TICK pid=' + process.pid), 500);";
		if (taskScenario === 'dependencies' || taskScenario === 'dependency-failure') {
			tasks = [{ ...root, dependsOn: 'Mock Agent Prepare', dependsOrder: 'sequence' }, { label: 'Mock Agent Prepare', type: taskKind, command: 'node', args: ['task-prepare.cjs'], presentation }];
			await writeFile(join(directory, 'task-prepare.cjs'), "const fs = require('node:fs'); fs.appendFileSync('dependency-starts.jsonl', JSON.stringify({pid:process.pid}) + String.fromCharCode(10)); fs.appendFileSync('task-order.txt', 'prepare-start\\n'); const timer = setInterval(() => { if (fs.existsSync('prepare-release')) { clearInterval(timer); fs.appendFileSync('task-order.txt', 'prepare-finish\\n'); fs.writeFileSync('prepare-finished', 'done'); } }, 25);");
			if (taskScenario === 'dependency-failure') {
				await writeFile(join(directory, 'task-prepare.cjs'), "const fs = require('node:fs'); fs.appendFileSync('dependency-starts.jsonl', JSON.stringify({pid:process.pid}) + String.fromCharCode(10)); console.error('DEPENDENCY_WAITING'); const timer = setInterval(() => { if (fs.existsSync('failure-release')) { clearInterval(timer); console.error('DEPENDENCY_FAILED_EXIT_17'); process.exitCode = 17; } }, 25);");
			}
			await writeFile(join(directory, 'dependency-starts.jsonl'), '');
			await writeFile(join(directory, 'task-order.txt'), '');
			script = "const fs = require('node:fs'); if (!fs.existsSync('prepare-finished')) throw new Error('Root started before dependency completion'); fs.appendFileSync('task-order.txt', 'root-start\\n'); " + script.replace("const fs = require('node:fs'); ", '');
		} else if (taskScenario === 'dependency-cancel') {
			tasks = [{ ...root, dependsOn: 'Mock Agent Prepare' }, { ...root, label: 'Mock Agent Prepare', args: ['task-middle.cjs'], dependsOn: ['Mock Agent Leaf A', 'Mock Agent Leaf B'], dependsOrder: 'parallel' }, ...['A', 'B'].map(leaf => ({ ...root, label: 'Mock Agent Leaf ' + leaf, args: ['task-leaf.cjs', leaf] }))];
			await writeFile(join(directory, 'task-middle.cjs'), "require('node:fs').writeFileSync('middle-started', 'unexpected');");
			await writeFile(join(directory, 'task-leaf.cjs'), "const fs = require('node:fs'); fs.appendFileSync('dependency-starts.jsonl', JSON.stringify({pid:process.pid, leaf:process.argv[2]}) + String.fromCharCode(10)); setInterval(() => console.log('LEAF_' + process.argv[2] + ' pid=' + process.pid), 100);");
			await writeFile(join(directory, 'dependency-starts.jsonl'), '');
		} else if (taskScenario === 'background' || taskScenario === 'background-pending') {
			tasks = [{ ...root, isBackground: true, problemMatcher: { owner: 'task-regression', pattern: { regexp: '^(.*):(\\d+):(.*)$', file: 1, line: 2, message: 3 }, background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } }];
			script = "const fs = require('node:fs'); " + starts + "console.log('BUILD'); console.log('" + taskMarker + " pid=' + process.pid); const timer = setInterval(() => { if (fs.existsSync('ready-release')) { clearInterval(timer); console.log('READY'); } }, 25); setInterval(() => console.log('TASK_TICK pid=' + process.pid), 500);";
			if (taskScenario === 'background-pending') {
				script = "const fs = require('node:fs'); " + starts + "console.log('BUILD'); console.log('" + taskMarker + " pid=' + process.pid); setInterval(() => console.log('STILL_BUILDING pid=' + process.pid), 100);";
			}
		} else if (taskScenario === 'pages') {
			script = "const fs = require('node:fs'); " + starts + 'process.stdout.write(' + JSON.stringify(pagePayload) + ');';
		} else if (taskScenario === 'truncated') {
			// Keep the initial output intact until the Agent has recorded its actual cursor.
			script = "const fs = require('node:fs'); " + starts + "console.log('" + taskMarker + " INITIAL 😀'); const timer = setInterval(() => { if (!fs.existsSync('flood-release')) return; clearInterval(timer); let step = 0; const input = require('node:readline').createInterface({input:process.stdin}); const emit = () => { step++; process.stdout.write('x'.repeat(65536) + String.fromCharCode(10) + 'TRUNCATION_STEP_' + step + ' 😀' + String.fromCharCode(10)); }; input.on('line', line => { if (line !== 'ACK_' + step) return; if (step < 18) emit(); else { input.close(); process.stdin.pause(); process.stdout.write('TRUNCATION_DONE 😀'); } }); emit(); }, 25);";
		} else if (taskScenario === 'reuse') {
			tasks = [{ ...root, args: ['task-loop.cjs', 'first'] }, { ...root, label: taskLabel + ' Second', args: ['task-loop.cjs', 'second'] }];
			script = "const fs = require('node:fs'); " + starts + 'process.stdout.write(process.argv[2] === "first" ? ' + JSON.stringify(firstPayload) + ' : ' + JSON.stringify(secondPayload) + ');';
		}
		await writeFile(join(directory, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks }));
		await writeFile(join(directory, 'task-loop.cjs'), script);
		await writeFile(join(directory, 'task-starts.jsonl'), '');
		await use(testWorkspace);
	},
	mockModel: async ({ }, use) => {
		const model = new TaskAgentModelFixture();
		await model.start();
		try { await use(model); } finally { await model.close(); }
	},
	taskSession: async ({ application, workbench, testWorkspace, mockModel, taskScenario }, use, testInfo) => {
		const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page, { directoryPermissionsHost: true });
		const { client } = connection;
		let readThread: (() => Promise<Thread>) | undefined;
		try {
			await expect(workbench.page.locator('.ash-sessions-window')).toBeVisible();
			// Reading the full retained output should exercise Task cursors without triggering model compaction.
			const contextWindow = taskScenario === 'truncated' ? 1_000_000 : 272_000;
			const initial = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'task-fixture-provider', expectedRevision: initial.revision, config: {
					connection: taskModel.provider, provider: taskModel.provider, baseUrl: mockModel.baseUrl,
					custom: { name: 'Task regression mock', protocol: 'responses', order: 0, contextWindow },
					modelContext: { [taskModel.model]: { contextWindow } },
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
				await testInfo.attach('mock-model-exchanges', { body: JSON.stringify({ exchanges: mockModel.exchanges, errors: mockModel.errors }, null, 2), contentType: 'application/json' });
				if (readThread) await testInfo.attach('agent-thread', { body: JSON.stringify(await readThread(), null, 2), contentType: 'application/json' });
				if (testInfo.status !== testInfo.expectedStatus && !workbench.page.isClosed()) await testInfo.attach('task-agent-window', { body: await workbench.page.screenshot(), contentType: 'image/png' });
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
	ready: boolean;
	hasMore: boolean;
	truncated: boolean;
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

async function completedTurn(page: Page, read: () => Promise<Thread>, count: number, approve: boolean | 'decline' | (() => Promise<void>), observe?: (turn: Turn) => Promise<void>): Promise<Turn> {
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
		if (turn?.status === 'failed' || turn?.status === 'interrupted') throw new Error('Agent Turn failed: ' + JSON.stringify({ turnId: turn.turnId, status: turn.status, error: turn.error }));
		if (turn && observe) await observe(turn);
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

async function processStarts(directory: string, file = 'task-starts.jsonl'): Promise<{ pid: number; }[]> {
	const text = (await readFile(join(directory, file), 'utf8')).trim();
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

async function cancelTask(session: TaskSession, count: number, runId: string, pid: number): Promise<void> {
	await submit(session.page, 'TASK_FIXTURE_CANCEL: Cancel the original Run ID and read its retained output.');
	const evidence = toolEvidence(await completedTurn(session.page, session.readThread, count, false));
	expect(evidence.map(item => item.name)).toEqual(['tasks_cancel', 'tasks_status', 'tasks_output']);
	for (const item of evidence) expect(item.arguments.run_id).toBe(runId);
	expect(evidence[1]!.result.status).toBe('canceled');
	await processExited(pid);
}

for (const taskKind of ['process', 'shell'] as const) {
	test.describe(taskKind, () => {
		test.use({ taskKind });
		test.describe('dependency failure', () => {
			test.use({ taskScenario: 'dependency-failure' });
			test('Mock Agent Task loop keeps the root unstarted when its dependency fails', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('failed');
				const { page, directory, readThread } = taskSession;
				let childRunId: string | undefined;
				await submit(page, 'TASK_FIXTURE_RUN: Run the existing Task and report a dependency failure.');
				const evidence = toolEvidence(await completedTurn(page, readThread, 1, true, async turn => {
					if (childRunId) return;
					const waiting = toolEvidence(turn).find(item => item.name === 'tasks_status' && item.result.status === 'running' && !item.result.terminalId);
					const children = await processStarts(directory, 'dependency-starts.jsonl');
					if (!waiting || !children.length) return;
					expect(children).toHaveLength(1);
					expect(() => process.kill(children[0]!.pid, 0)).not.toThrow();
					expect(await processStarts(directory)).toEqual([]);
					await showTasks(page);
					const child = page.locator('[data-run-id]').filter({ hasText: 'Mock Agent Prepare — Running' });
					await expect(child).toHaveCount(1);
					childRunId = (await child.getAttribute('data-run-id'))!;
					expect(childRunId).toBeTruthy();
					await writeFile(join(directory, 'failure-release'), 'fail');
				}));
				const root = evidence.filter(item => item.name === 'tasks_status').at(-1)!.result;
				expect(root).toMatchObject({ status: 'failed', terminalId: '', exitCode: null, ready: false });
				expect(evidence.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				expect(evidence.at(-1)!.result.text).toContain("Dependency 'Mock Agent Prepare'");
				expect(evidence.at(-1)!.result.text).toContain('failed');
				await expect(page.locator('[data-run-id="' + root.runId + '"]')).toContainText(taskLabel + ' — Failed');
				mockModel.inspectRun(childRunId!);
				await submit(page, 'TASK_FIXTURE_INSPECT: Read dependency Run ID ' + childRunId + ' status and output.');
				const failed = toolEvidence(await completedTurn(page, readThread, 2, false));
				expect(failed.map(item => item.name)).toEqual(['tasks_status', 'tasks_output']);
				expect(failed[0]!.result).toMatchObject({ runId: childRunId, status: 'failed', exitCode: 17 });
				expect(failed[1]!.result.text).toContain('DEPENDENCY_FAILED_EXIT_17');
				expect(failed[1]!.result.text).not.toContain(taskMarker);
				const children = await processStarts(directory, 'dependency-starts.jsonl');
				await processExited(children[0]!.pid);
				expect(await processStarts(directory)).toEqual([]);
				expect(await readFile(join(directory, 'task-order.txt'), 'utf8')).toBe('');
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('dependency cancellation', () => {
			test.use({ taskScenario: 'dependency-cancel' });
			test('Mock Agent Task loop cancels nested dependencies and both parallel leaf processes', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('preparing');
				const { page, directory, readThread } = taskSession;
				await submit(page, 'TASK_FIXTURE_RUN: Start the dependency chain and report its waiting root Run ID.');
				const evidence = toolEvidence(await completedTurn(page, readThread, 1, async () => {
					const approval = page.locator(':is(.ash-chat-interaction,.ash-cowork-interaction):visible');
					await expect(approval).toContainText('task-middle.cjs');
					await expect(approval).toContainText('task-leaf.cjs');
				}));
				const root = evidence.filter(item => item.name === 'tasks_status').at(-1)!.result;
				expect(root).toMatchObject({ status: 'running', terminalId: '', ready: false, exitCode: null });
				await expect.poll(async () => (await processStarts(directory, 'dependency-starts.jsonl')).length).toBe(2);
				const children = await processStarts(directory, 'dependency-starts.jsonl') as { pid: number; leaf: string; }[];
				expect(children.map(child => child.leaf).sort()).toEqual(['A', 'B']);
				for (const child of children) expect(() => process.kill(child.pid, 0)).not.toThrow();
				expect(await processStarts(directory)).toEqual([]);
				await expect(access(join(directory, 'middle-started'))).rejects.toMatchObject({ code: 'ENOENT' });
				await showTasks(page);
				await expect(page.locator('.ash-task-run.running [data-run-id]')).toHaveCount(3);
				await expect(page.locator('[data-run-id="' + root.runId + '"]')).toContainText(taskLabel + ' — Running');
				await cancelTask(taskSession, 2, root.runId, children[0]!.pid);
				await processExited(children[1]!.pid);
				await showTasks(page);
				await expect(page.locator('.ash-task-run.running [data-run-id]')).toHaveCount(0);
				await expect(page.locator('[data-run-id="' + root.runId + '"]')).toContainText(taskLabel + ' — Canceled');
				expect(await processStarts(directory, 'dependency-starts.jsonl')).toEqual(children);
				expect(await processStarts(directory)).toEqual([]);
				await expect(access(join(directory, 'middle-started'))).rejects.toMatchObject({ code: 'ENOENT' });
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('background never ready', () => {
			test.use({ taskScenario: 'background-pending' });
			test('Mock Agent Task loop keeps a background Task unready until explicit cancellation', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('not-ready');
				const { page, directory, readThread } = taskSession;
				await submit(page, 'TASK_FIXTURE_RUN: Run the background Task and sample its readiness without waiting indefinitely.');
				const evidence = toolEvidence(await completedTurn(page, readThread, 1, true));
				const run = evidence.filter(item => item.name === 'tasks_status').at(-1)!.result;
				const starts = await processStarts(directory);
				expect(starts).toHaveLength(1);
				await expect(page.locator('.ash-terminal-instance:visible')).toContainText('STILL_BUILDING pid=' + starts[0]!.pid);
				mockModel.beginFollowup();
				await submit(page, 'TASK_FIXTURE_INSPECT: Query the same background Run again; it still has no end pattern.');
				const inspected = toolEvidence(await completedTurn(page, readThread, 2, false));
				for (const samples of [evidence, inspected]) {
					const statuses = samples.filter(item => item.name === 'tasks_status' && item.result.terminalId);
					expect(statuses.length).toBeGreaterThanOrEqual(3);
					for (const status of statuses) expect(status.result).toMatchObject({ runId: run.runId, terminalId: run.terminalId, status: 'running', ready: false, exitCode: null });
				}
				expect(inspected.at(-1)!.result.text).toContain('STILL_BUILDING pid=' + starts[0]!.pid);
				expect(() => process.kill(starts[0]!.pid, 0)).not.toThrow();
				await showTasks(page);
				await expect(page.locator('[data-run-id="' + run.runId + '"]')).toContainText(taskLabel + ' — Running');
				await cancelTask(taskSession, 3, run.runId, starts[0]!.pid);
				const canceled = toolEvidence((await readThread()).turns[2]!);
				expect(canceled[1]!.result).toMatchObject({ status: 'canceled', ready: false });
				expect(await processStarts(directory)).toEqual(starts);
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('truncated output', () => {
			test.use({ taskScenario: 'truncated' });
			test('Mock Agent Task loop recovers a stale cursor after Unicode output truncation', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				const { page, directory, readThread } = taskSession;
				await submit(page, 'TASK_FIXTURE_RUN: Start the Task and read its initial output cursor.');
				const initial = toolEvidence(await completedTurn(page, readThread, 1, true));
				const runId = initial.find(item => item.name === 'tasks_run')!.result.runId;
				const first = initial.at(-1)!.result;
				expect(first.text).toContain(taskMarker + ' INITIAL 😀');
				expect(first.truncated).toBe(false);
				const staleCursor = first.nextCursor;
				await writeFile(join(directory, 'flood-release'), 'continue');
				// Use Terminal input for acknowledgments, avoiding workspace file-watch refreshes per chunk.
				const terminal = page.locator('.ash-terminal-instance:visible');
				for (let step = 1; step <= 18; step++) {
					await expect(terminal).toContainText('TRUNCATION_STEP_' + step + ' 😀');
					await terminal.locator('.xterm-helper-textarea').focus();
					await page.keyboard.type('ACK_' + step);
					await page.keyboard.press('Enter');
				}
				mockModel.expectOutcome('succeeded');
				mockModel.readPages(65536, staleCursor);
				mockModel.beginFollowup();
				await submit(page, 'TASK_FIXTURE_INSPECT: Wait for Run ID ' + runId + ' to finish, recover cursor ' + staleCursor + ' if truncated, then read through EOF.');
				const recovered = toolEvidence(await completedTurn(page, readThread, 2, false));
				expect(recovered.filter(item => item.name === 'tasks_status').at(-1)!.result).toMatchObject({ runId, status: 'succeeded', exitCode: 0 });
				const pages = recovered.filter(item => item.name === 'tasks_output');
				const start = pages[0]!.result.cursor;
				expect(start).toBeGreaterThan(staleCursor);
				expect(pages[0]!.arguments.cursor).toBe(staleCursor);
				expect(pages[0]!.result.truncated).toBe(true);
				const retained = pages.map(item => item.result.text).join('');
				expect(retained.length).toBeGreaterThanOrEqual(1_048_575);
				expect(retained.length).toBeLessThanOrEqual(1_048_576);
				expect(retained).not.toContain(taskMarker + ' INITIAL');
				expect(retained).toContain('TRUNCATION_DONE 😀');
				let cursor = staleCursor;
				for (const [index, page] of pages.entries()) {
					expect(page.arguments).toMatchObject({ run_id: runId, cursor, max_characters: 65536 });
					expect(page.result.truncated).toBe(index === 0);
					expect(page.result.cursor).toBe(index === 0 ? start : cursor);
					expect(page.result.nextCursor).toBe(page.result.cursor + page.result.text.length);
					expect(page.result.hasMore).toBe(page.result.nextCursor < start + retained.length);
					if (page.result.text) {
						const first = page.result.text.charCodeAt(0);
						expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false);
						const last = page.result.text.charCodeAt(page.result.text.length - 1);
						expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
					}
					cursor = page.result.nextCursor;
				}
				expect(pages.at(-1)!.result).toMatchObject({ text: '', cursor: start + retained.length, nextCursor: start + retained.length, hasMore: false, truncated: false });
				const starts = await processStarts(directory);
				expect(starts).toHaveLength(1);
				await processExited(starts[0]!.pid);
				expect(recovered.some(item => item.name === 'tasks_run')).toBe(false);
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('dependencies', () => {
			test.use({ taskScenario: 'dependencies' });
			test('Mock Agent Task loop waits for dependency completion before starting the root', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				const { page, directory, readThread } = taskSession;
				let dependencyPid: number | undefined;
				await submit(page, 'TASK_FIXTURE_RUN: Discover and run the existing Task with its dependency.');
				const evidence = toolEvidence(await completedTurn(page, readThread, 1, async () => {
					await expect(page.locator(':is(.ash-chat-interaction,.ash-cowork-interaction):visible')).toContainText('task-prepare.cjs');
				}, async turn => {
					if (dependencyPid) return;
					const waiting = toolEvidence(turn).find(item => item.name === 'tasks_status' && item.result.status === 'running' && !item.result.terminalId);
					const dependencies = await processStarts(directory, 'dependency-starts.jsonl');
					if (!waiting || !dependencies.length) return;
					expect(dependencies).toHaveLength(1);
					dependencyPid = dependencies[0]!.pid;
					expect(() => process.kill(dependencyPid!, 0)).not.toThrow();
					expect(await processStarts(directory)).toEqual([]);
					expect(await readFile(join(directory, 'task-order.txt'), 'utf8')).toBe('prepare-start\n');
					await writeFile(join(directory, 'prepare-release'), 'continue');
				}));
				expect(dependencyPid).toBeDefined();
				await processExited(dependencyPid!);
				expect(await readFile(join(directory, 'task-order.txt'), 'utf8')).toBe('prepare-start\nprepare-finish\nroot-start\n');
				expect(evidence.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				const runId = evidence.find(item => item.name === 'tasks_run')!.result.runId;
				for (const item of evidence.slice(2)) expect(item.arguments.run_id).toBe(runId);
				const [root] = await processStarts(directory);
				expect(root).toBeDefined();
				await expect(page.locator('.ash-terminal-instance:visible')).toContainText(taskMarker + ' pid=' + root!.pid);
				await showTasks(page);
				const status = evidence.find(item => item.name === 'tasks_status' && item.result.terminalId)!.result;
				await expect(page.locator('[data-run-id="' + runId + '"]')).toHaveAttribute('data-terminal-id', status.terminalId);
				await cancelTask(taskSession, 2, runId, root!.pid);
				expect(await processStarts(directory, 'dependency-starts.jsonl')).toEqual([{ pid: dependencyPid }]);
				expect(await processStarts(directory)).toEqual([root]);
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('background ready', () => {
			test.use({ taskScenario: 'background' });
			test('Mock Agent Task loop observes background readiness without process completion', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('ready');
				const { page, directory, readThread } = taskSession;
				let released = false;
				await submit(page, 'TASK_FIXTURE_RUN: Run the background Task and wait for its ready status.');
				const evidence = toolEvidence(await completedTurn(page, readThread, 1, true, async turn => {
					if (released) return;
					const pending = toolEvidence(turn).find(item => item.name === 'tasks_status' && item.result.terminalId && !item.result.ready);
					const starts = await processStarts(directory);
					if (!pending || !starts.length) return;
					expect(pending.result).toMatchObject({ status: 'running', ready: false, exitCode: null });
					expect(() => process.kill(starts[0]!.pid, 0)).not.toThrow();
					// Verify the start marker has reached the real Terminal before ending the watch cycle.
					await expect(page.locator('.ash-terminal-instance:visible')).toContainText('BUILD');
					await writeFile(join(directory, 'ready-release'), 'continue');
					released = true;
				}));
				expect(released).toBe(true);
				const statuses = evidence.filter(item => item.name === 'tasks_status');
				expect(statuses.some(item => item.result.ready === false)).toBe(true);
				const ready = statuses.at(-1)!.result;
				expect(evidence.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				for (const item of evidence.slice(2)) expect(item.arguments.run_id).toBe(ready.runId);
				expect(ready).toMatchObject({ status: 'running', ready: true, exitCode: null });
				const [started] = await processStarts(directory);
				expect(() => process.kill(started!.pid, 0)).not.toThrow();
				await expect(page.locator('.ash-terminal-instance:visible')).toContainText('READY');
				await showTasks(page);
				await expect(page.locator('[data-run-id="' + ready.runId + '"]')).toContainText(taskLabel + ' — Running');
				await expect(page.locator('[data-run-id="' + ready.runId + '"]')).toHaveAttribute('data-terminal-id', ready.terminalId);
				await cancelTask(taskSession, 2, ready.runId, started!.pid);
				expect(await processStarts(directory)).toEqual([started]);
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('output pages', () => {
			test.use({ taskScenario: 'pages' });
			test('Mock Agent Task loop pages Unicode output using returned UTF-16 cursors through EOF', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('succeeded');
				mockModel.readPages(1);
				await submit(taskSession.page, 'TASK_FIXTURE_RUN: Run the finite Task, then read all output pages through EOF.');
				const evidence = toolEvidence(await completedTurn(taskSession.page, taskSession.readThread, 1, true));
				const runId = evidence.find(item => item.name === 'tasks_run')!.result.runId;
				expect(evidence.filter(item => item.name === 'tasks_status').at(-1)!.result).toMatchObject({ status: 'succeeded', exitCode: 0 });
				const [reference, ...pages] = evidence.filter(item => item.name === 'tasks_output');
				expect(reference!.arguments).toMatchObject({ run_id: runId, cursor: 0, max_characters: 65536 });
				expect(reference!.result).toMatchObject({ cursor: 0, hasMore: false, truncated: false });
				// ConPTY may add cursor controls; reconstruct the complete raw stream, including them.
				const completeOutput = reference!.result.text;
				expect(completeOutput).toContain(pagePayload);
				expect(pages.map(item => item.result.text).join('')).toBe(completeOutput);
				let cursor = 0;
				for (const page of pages) {
					expect(page.arguments).toMatchObject({ run_id: runId, cursor, max_characters: 1 });
					expect(page.result.cursor).toBe(cursor);
					expect(page.result.nextCursor).toBe(cursor + page.result.text.length);
					expect(page.result.truncated).toBe(false);
					expect(page.result.hasMore).toBe(page.result.nextCursor < completeOutput.length);
					// A one-unit budget must return a complete supplementary code point.
					for (const point of Array.from(page.result.text)) expect(point.codePointAt(0)! >= 0xD800 && point.codePointAt(0)! <= 0xDFFF).toBe(false);
					cursor = page.result.nextCursor;
				}
				expect(pages.some(item => item.result.text === '😀' && item.result.nextCursor - item.result.cursor === 2)).toBe(true);
				expect(pages.at(-1)!.result).toMatchObject({ text: '', cursor: completeOutput.length, nextCursor: completeOutput.length, hasMore: false });
				const starts = await processStarts(taskSession.directory);
				expect(starts).toHaveLength(1);
				await processExited(starts[0]!.pid);
				expect(mockModel.errors).toEqual([]);
			});
		});

		test.describe('terminal reuse', () => {
			test.use({ taskScenario: 'reuse' });
			test('Mock Agent Task loop isolates retained output after reusing the terminal for another Run', { tag: '@electron-app-server' }, async ({ taskSession, mockModel }) => {
				mockModel.expectOutcome('succeeded');
				const { page, readThread, directory } = taskSession;
				await submit(page, 'TASK_FIXTURE_RUN: Discover and run the first finite Task, then read its output.');
				const first = toolEvidence(await completedTurn(page, readThread, 1, true));
				const old = first.filter(item => item.name === 'tasks_status').at(-1)!.result;
				expect(old.status).toBe('succeeded');
				const firstOutput = first.at(-1)!.result.text;
				expect(firstOutput).toContain(firstPayload);
				expect(firstOutput).not.toContain(secondPayload);
				await expect(page.locator('.ash-terminal-instance:visible')).toContainText(firstPayload);
				const [firstProcess] = await processStarts(directory);
				await processExited(firstProcess!.pid);
				mockModel.selectTask(taskLabel + ' Second');
				mockModel.beginFollowup();
				await submit(page, 'TASK_FIXTURE_RUN: Discover and run ' + taskLabel + ' Second in the shared terminal, then read output.');
				const second = toolEvidence(await completedTurn(page, readThread, 2, true));
				const current = second.filter(item => item.name === 'tasks_status').at(-1)!.result;
				expect(current).toMatchObject({ status: 'succeeded', terminalId: old.terminalId, exitCode: 0 });
				expect(current.runId).not.toBe(old.runId);
				expect(second.at(-1)!.result.text).toContain(secondPayload);
				expect(second.at(-1)!.result.text).not.toContain(firstPayload);
				const terminal = page.locator('.ash-terminal-instance:visible');
				await expect(terminal).toContainText(secondPayload);
				await expect(terminal).not.toContainText(firstPayload);
				await showTasks(page);
				await expect(page.locator('[data-run-id="' + current.runId + '"]')).toHaveAttribute('data-terminal-id', old.terminalId);
				mockModel.inspectRun(old.runId);
				await submit(page, 'TASK_FIXTURE_INSPECT: Read Run ID ' + old.runId + ' status and retained output after terminal reuse.');
				const retained = toolEvidence(await completedTurn(page, readThread, 3, false));
				expect(retained.map(item => item.name)).toEqual(['tasks_status', 'tasks_output']);
				for (const item of retained) expect(item.arguments.run_id).toBe(old.runId);
				expect(retained[0]!.result).toMatchObject({ runId: old.runId, terminalId: old.terminalId, status: 'succeeded', exitCode: 0 });
				expect(retained[1]!.result.text).toBe(firstOutput);
				const starts = await processStarts(directory);
				expect(starts).toHaveLength(2);
				expect(starts[1]!.pid).not.toBe(firstProcess!.pid);
				await processExited(starts[1]!.pid);
				expect(first.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				expect(second.filter(item => item.name === 'tasks_run')).toHaveLength(1);
				expect(mockModel.errors).toEqual([]);
			});
		});

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
