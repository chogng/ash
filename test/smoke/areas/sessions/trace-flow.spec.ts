import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { expect, test as base } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { parseAgentTrace, parseAgentTraceDiagnostics, type AgentTraceEvent } from '../../../../src/ash/workbench/services/chat/common/agentTrace.js';
import { connectTraceAppServer } from './traceFixture.js';

type FixtureRequest = { input: Array<Record<string, unknown>>; tools?: Array<{ name: string; }>; };
interface TraceModelFixture {
	readonly url: string;
	readonly requests: FixtureRequest[];
	readonly held: ServerResponse[];
}

function fixtureToolOutput(output: unknown): Record<string, unknown> {
	// The Responses adapter sends tool results as input_text blocks. Parse that
	// actual wire shape so a malformed fixture cannot silently select null IDs.
	const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map(block => {
		if (block.type !== 'input_text' || typeof block.text !== 'string') { throw new Error('Expected fixture input_text tool output'); }
		return block.text;
	}).join('') : undefined;
	if (!text) { throw new Error('Expected fixture tool output text'); }
	return JSON.parse(text) as Record<string, unknown>;
}

/** Only the provider HTTP responses are scripted; Core, tools, child Threads,
 * persistence, diagnostic recording and renderer RPCs use the product runtime. */
const test = base.extend<{ traceModelFixture: TraceModelFixture; }>({
	traceModelFixture: async ({ }, use) => {
		const requests: FixtureRequest[] = [];
		const held: ServerResponse[] = [];
		const children: ServerResponse[] = [];
		const respond = (response: ServerResponse, output: unknown[]): void => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'trace-fixture-response', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`);
		};
		const message = (text: string): unknown[] => [{ type: 'message', id: 'fixture-answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }];
		const call = (id: string, name: string, args: unknown): unknown => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) });
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
			try {
				let text = '';
				for await (const chunk of request) { text += chunk; }
				const body = JSON.parse(text) as FixtureRequest;
				requests.push(body);
				const prompt = JSON.stringify(body.input.filter(item => item.role === 'user'));
				if (prompt.includes('trace-fixture-cancel')) { held.push(response); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return; }
				if (prompt.includes('trace-fixture-failure')) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'trace-fixture-deliberate-failure', type: 'invalid_request_error' } })); return; }
				if (prompt.includes('trace-fixture-child-task')) {
					children.push(response);
					// Both real child model requests must overlap before either can finish.
					if (children.length === 2) { for (const child of children) { respond(child, message('trace-fixture-child-result')); } }
					return;
				}
				const results = body.input.filter(item => item.type === 'function_call_output');
				if (results.length === 0) {
					respond(response, [
						call('fixture-shell', 'shell-command', { program: process.execPath, arguments: ['-e', 'console.log("trace-fixture-tool-result")'], working_directory: '.' }),
						...['a', 'b'].map(id => call(`fixture-spawn-${id}`, 'spawn_agent', { task: `trace-fixture-child-task-${id}`, name: `Trace fixture child ${id}`, agent: { type: 'default', name: null, source: null }, context: null, team_run_id: null, member_id: null })),
					]);
					return;
				}
				if (!results.some(item => item.call_id === 'fixture-wait')) {
					const delegationIds = results.filter(item => String(item.call_id).startsWith('fixture-spawn-')).map(item => {
						const id = fixtureToolOutput(item.output).delegation_id;
						if (typeof id !== 'string') { throw new Error('Expected actual spawn delegation ID'); }
						return id;
					});
					respond(response, [call('fixture-wait', 'wait_agent', { delegation_id: null, delegation_ids: delegationIds, policy: 'all', quorum: null, timeout_ms: 10_000 })]);
					return;
				}
				const joined = fixtureToolOutput(results.find(item => item.call_id === 'fixture-wait')!.output);
				if (joined.status !== 'satisfied' || !Array.isArray(joined.results) || joined.results.length !== 2) { throw new Error('Expected real satisfied join with two child results'); }
				respond(response, message('trace-fixture-parent-final'));
			} catch (error) { console.error('Controlled model fixture response failed', error); response.writeHead(500).end(String(error)); }
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Expected fixture HTTP address'); }
		try { await use({ url: `http://127.0.0.1:${address.port}/v1`, requests, held }); }
		finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
	},
	backendConfiguration: async ({ testWorkspace, traceModelFixture }, use) => {
		await use(`schemaVersion = 10\n[agent.trace]\nenabled = true\ndirectory = ${JSON.stringify(join(testWorkspace.directory, 'fixture-trace-recordings'))}\n[connections.custom-trace-fixture]\nprovider = "custom-trace-fixture"\nconnection = "custom-trace-fixture"\nbaseUrl = ${JSON.stringify(traceModelFixture.url)}\n[connections.custom-trace-fixture.custom]\nprotocol = "responses"\nname = "Controlled Trace fixture"\ncontextWindow = 272000\norder = 0\nmodel = "gpt-6.1-sol"\n`);
	},
});

async function selectRecord(viewer: Locator, eventId: string): Promise<void> {
	const filter = viewer.getByRole('textbox', { name: 'Filter execution events' });
	await filter.fill(eventId);
	await viewer.locator(`.ash-agent-trace-event[data-event-id="${eventId}"]`).click();
	await filter.fill('');
}

function completedItem(events: readonly AgentTraceEvent[], type: string, callId: string): AgentTraceEvent {
	const record = events.find(record => record.event.type === 'itemCompleted' && typeof record.event.item === 'object' && record.event.item !== null && (record.event.item as Record<string, unknown>).type === type && (record.event.item as Record<string, unknown>).toolCallId === callId);
	expect(record).toBeDefined();
	return record!;
}

test('Execution Trace follows a controlled model through real tools, parallel children, returns and offline reopening', async ({ target, application, workbench, testWorkspace, traceModelFixture }, testInfo) => {
	test.skip(target.appServerMode !== 'required', 'Needs the product App Server.');
	const page = await workbench.openAgentsWindow(target.kind);
	const connection = await connectTraceAppServer(application, page, testWorkspace.directory);
	const { client } = connection;
	let fixtureSessionId: string | undefined;
	try {
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'fixture-session', title: 'Trace controlled execution', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		fixtureSessionId = sessionId;
		expect(created.session.threads).toHaveLength(1);
		const threadId = created.session.threads[0].threadId;
		const thread = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
		await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'fixture-start', sessionId, request: { type: 'startTurn', threadId, expectedSequence: thread.thread.sequence, input: [{ type: 'text', text: 'trace-fixture-parent-task: run the controlled demonstration.' }], model: { provider: 'custom-trace-fixture', model: 'gpt-6.1-sol' }, mode: 'agent', approvalMode: 'bypassPermissions', toolMode: 'direct' } });
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace controlled execution' }).click();
		await new QuickAccess(page).runCommand('sessions.trace.open');
		const viewer = page.locator('.ash-agent-trace');
		await expect(viewer.getByRole('status')).toContainText('Live');
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
		const durable = parseAgentTrace((await client.request(APP_SERVER_METHODS['session/trace/read'], { sessionId, after: {}, limit: 500 })).trace);
		const diagnostics = parseAgentTraceDiagnostics((await client.request(APP_SERVER_METHODS['session/trace/diagnostics/read'], { sessionId, after: 0, limit: 500 })).diagnostics);
		const events = durable.threads.find(thread => thread.threadId === threadId)!.events;
		const shell = completedItem(events, 'toolCall', 'fixture-shell');
		const result = completedItem(events, 'toolResult', 'fixture-shell');
		expect(result.event.item).toMatchObject({ isError: false, text: expect.stringContaining('trace-fixture-tool-result') });
		expect(durable.threads).toHaveLength(3);
		expect(events.filter(record => record.event.type === 'delegationResultReceived')).toHaveLength(2);
		expect(events.some(record => record.event.type === 'agentJoinSatisfied')).toBe(true);
		const attempts = diagnostics.events.filter(record => record.threadId === threadId && record.event.type === 'modelAttemptStarted');
		expect(attempts).toHaveLength(3);
		expect(diagnostics.events.filter(record => record.event.type === 'modelAttemptCompleted')).toHaveLength(5);
		const parentRequests = traceModelFixture.requests.filter(request => JSON.stringify(request.input).includes('trace-fixture-parent-task'));
		expect(parentRequests).toHaveLength(3);
		expect(parentRequests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'fixture-shell' })]));
		expect(JSON.stringify(parentRequests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'fixture-shell')?.output)).toContain('trace-fixture-tool-result');
		await selectRecord(viewer, attempts[1].eventId);
		await viewer.getByRole('tab', { name: 'Input', exact: true }).click();
		await expect(viewer.getByRole('button', { name: 'Saved body', exact: true })).toBeVisible();
		await viewer.getByRole('button', { name: 'Saved body', exact: true }).click();
		// Saved bodies use a virtual readonly editor; Find reveals evidence beyond its viewport.
		await viewer.locator('.stanza-editor-input:visible').press('ControlOrMeta+F');
		const find = viewer.getByRole('dialog', { name: 'Find and replace', exact: true }).getByRole('textbox', { name: 'Find', exact: true });
		await find.fill('trace-fixture-tool-result');
		await expect.poll(async () => (await viewer.locator('.view-lines').innerText()).replace(/\s/gu, '')).toContain('trace-fixture-tool-result');
		await viewer.getByRole('dialog', { name: 'Find and replace', exact: true }).getByRole('button', { name: 'Close find', exact: true }).click();
		await expect(viewer.getByRole('dialog', { name: 'Find and replace', exact: true })).toBeHidden();
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Result present in model input' }).filter({ hasText: 'fixture-shell' }).click();
		await expect(viewer.getByRole('treeitem', { selected: true }).locator('.ash-agent-trace-event')).toHaveAttribute('data-event-id', result.eventId);
		await selectRecord(viewer, attempts[0].eventId);
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Model requested tool' }).filter({ hasText: 'shell-command' }).click();
		await expect(viewer.getByRole('treeitem', { selected: true }).locator('.ash-agent-trace-event')).toHaveAttribute('data-event-id', shell.eventId);
		const returned = events.find(record => record.event.type === 'delegationResultReceived')!;
		await selectRecord(viewer, returned.eventId);
		await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('trace-fixture-child-result');
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Child result returned' }).click();
		await expect(viewer.getByRole('treeitem', { selected: true }).locator('.ash-agent-trace-event')).toHaveAttribute('data-thread-id', String((returned.event.result as Record<string, unknown>).childThreadId));
		await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('delegationResultProduced');
		const satisfied = events.find(record => record.event.type === 'agentJoinSatisfied')!;
		await selectRecord(viewer, satisfied.eventId);
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await expect(viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Join satisfied' })).toHaveCount(3);
		await page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
		await new QuickAccess(page).runCommand('sessions.trace.open');
		await expect(viewer.getByRole('status')).toContainText('Live');
		await selectRecord(viewer, returned.eventId);
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await expect(viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Child result returned' })).toHaveCount(1);
		let exportedPath: string;
		const menu = new Menus(page);
		if ('windows' in application) {
			exportedPath = testInfo.outputPath('controlled-model.trace.json');
			await application.evaluate(({ BrowserWindow }, path) => { BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => item.setSavePath(path)); }, exportedPath);
			await menu.select(application, () => viewer.locator('.ash-toolbar-more-actions button').click(), ['Export trace']);
			await expect.poll(async () => { try { return JSON.parse(await readFile(exportedPath, 'utf8')).threads.length; } catch { return 0; } }).toBe(3);
		} else {
			const download = page.waitForEvent('download');
			await menu.select(application, () => viewer.locator('.ash-toolbar-more-actions button').click(), ['Export trace']);
			exportedPath = (await (await download).path())!;
		}
		const artifact = await readFile(exportedPath);
		await writeFile(testInfo.outputPath('controlled-model.trace.json'), artifact);
		const exported = parseAgentTrace(JSON.parse(artifact.toString()));
		expect(exported.threads).toEqual(durable.threads);
		expect(exported.diagnostics?.events).toEqual(diagnostics.events);
		expect(exported.diagnostics?.payloads && Object.keys(exported.diagnostics.payloads)).toHaveLength(15);
		await viewer.locator('input[type=file]').setInputFiles({ name: 'controlled-model.trace.json', mimeType: 'application/json', buffer: artifact });
		await expect(viewer.getByRole('status')).toHaveText('Imported · controlled-model.trace.json');
		await selectRecord(viewer, returned.eventId);
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await expect(viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Child result returned' })).toHaveCount(1);
		const boundary = JSON.stringify({ fixture: 'local HTTP Responses provider; no paid account', threadCount: durable.threads.length, parentAttempts: attempts.length, childAttempts: 2, shellToolCall: 'fixture-shell', childReturns: 2, joinSatisfied: true, savedPayloads: 15 });
		await writeFile(testInfo.outputPath('controlled-model-boundary.json'), boundary + '\n');
		await testInfo.attach('controlled-model-boundary', { path: testInfo.outputPath('controlled-model-boundary.json'), contentType: 'application/json' });
	} catch (error) {
		if (fixtureSessionId && !page.isClosed() && testInfo.status !== 'timedOut') {
			try {
				const history = await client.request(APP_SERVER_METHODS['session/trace/read'], { sessionId: fixtureSessionId, after: {}, limit: 500 });
				await writeFile(testInfo.outputPath('controlled-model-failure-evidence.json'), JSON.stringify({ history, requests: traceModelFixture.requests }) + '\n');
				await testInfo.attach('controlled-model-failure-evidence', { path: testInfo.outputPath('controlled-model-failure-evidence.json'), contentType: 'application/json' });
			} catch (evidenceError) { console.warn('Trace failure evidence unavailable', String(evidenceError)); }
		}
		throw error;
	} finally { await connection.close(); }
});

test('Execution Trace retains real model failure and cancellation during concurrent Threads and reopening', async ({ target, application, workbench, testWorkspace, traceModelFixture }) => {
	test.skip(target.appServerMode !== 'required', 'Needs the product App Server.');
	const page = await workbench.openAgentsWindow(target.kind);
	const connection = await connectTraceAppServer(application, page, testWorkspace.directory);
	const { client } = connection;
	try {
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'fixture-session', title: 'Trace interrupted execution', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const start = async (kind: 'failure' | 'cancel'): Promise<string> => {
			const result = await client.request(APP_SERVER_METHODS['session/request'], { commandId: `fixture-${kind}`, sessionId, request: { type: 'createThread', title: `Trace fixture ${kind}` } });
			if (result.type !== 'thread') { throw new Error('Expected fixture Thread'); }
			const threadId = result.value.threadId;
			const read = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: `start-${kind}`, sessionId, request: { type: 'startTurn', threadId, expectedSequence: read.thread.sequence, input: [{ type: 'text', text: `trace-fixture-${kind}` }], model: { provider: 'custom-trace-fixture', model: 'gpt-6.1-sol' }, mode: 'agent', approvalMode: 'bypassPermissions', toolMode: 'direct' } });
			return threadId;
		};
		const cancelThread = await start('cancel');
		await expect.poll(() => traceModelFixture.held.length).toBe(1);
		const failureThread = await start('failure');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace interrupted execution' }).click();
		await new QuickAccess(page).runCommand('sessions.trace.open');
		const viewer = page.locator('.ash-agent-trace');
		const running = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: cancelThread });
		await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'fixture-interrupt', sessionId, request: { type: 'interruptTurn', threadId: cancelThread, turnId: running.thread.turns.at(-1)!.turnId, expectedSequence: running.thread.sequence } });
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: cancelThread })).thread.turns.at(-1)?.status).toBe('interrupted');
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: failureThread })).thread.turns.at(-1)?.status).toBe('failed');
		const diagnostics = parseAgentTraceDiagnostics((await client.request(APP_SERVER_METHODS['session/trace/diagnostics/read'], { sessionId, after: 0, limit: 500 })).diagnostics);
		const failed = diagnostics.events.find(record => record.threadId === failureThread && record.event.type === 'modelAttemptFailed')!;
		const cancelled = diagnostics.events.find(record => record.threadId === cancelThread && record.event.type === 'modelAttemptCancelled')!;
		expect(failed.event.error).toBe('model request was invalid');
		expect(cancelled).toBeDefined();
		await selectRecord(viewer, failed.eventId);
		await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('model request was invalid');
		await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
		await expect(viewer.locator(`.ash-agent-trace-event[data-event-id="${failed.eventId}"]`)).toBeVisible();
		await expect(viewer.locator(`.ash-agent-trace-event[data-event-id="${cancelled.eventId}"]`)).toHaveCount(0);
		await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
		await selectRecord(viewer, cancelled.eventId);
		await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('modelAttemptCancelled');
		await page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
		await new QuickAccess(page).runCommand('sessions.trace.open');
		await selectRecord(viewer, cancelled.eventId);
		await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('modelAttemptCancelled');
	} finally { await connection.close(); }
});
