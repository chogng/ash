import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// The model is controlled; catalogue binding, policy, MCP execution and navigation use Desktop owners.
test('Desktop binds streamed calls to rich approvals and navigates typed results on their host', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const presentations = [
		{ type: 'modifiedFiles', files: [{ path: 'proposed.ts', original: 'old evidence', modified: '<script>proposed evidence</script>' }] },
		{ type: 'agentFeedbackReview', message: '<script>review feedback</script>' },
		{ type: 'extensionsInstall', extensions: ['publisher.fixture'] },
		{ type: 'sandboxPrerequisite', dependencies: ['fixture dependency'], remediations: ['Review fixture remediation'] },
		{ type: 'authentication', provider: 'Fixture identity' },
	];
	const evidence = ['<script>proposed evidence</script>', '<script>review feedback</script>', 'publisher.fixture', 'fixture dependency', 'Sign in to Fixture identity'];
	let calls = 0;
	let finishArguments: (() => void) | undefined;
	let destination: { sessionId: string; threadId: string; };
	const automationId = 'presentation-automation';
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'presentations-model' }] })); return; }
		const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { function?: { name?: string; }; }[]; };
		const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'presentations', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		if (++calls !== 1) { response.end(chunk({ content: 'Presentation calls completed.' }, 'stop') + 'data: [DONE]\n\n'); return; }
		const name = body.tools?.find(tool => tool.function?.name?.includes('review_fixture'))?.function?.name;
		if (!name) { response.end(); return; }
		response.write(chunk({ tool_calls: presentations.map((_, index) => ({ index, id: `presentation-${index}`, type: 'function', function: { name, arguments: '{"presentation":' } })) }, null));
		finishArguments = () => {
			response.end(chunk({ tool_calls: presentations.map((presentation, index) => ({ index, function: { arguments: JSON.stringify({ type: 'confirmation', presentation }) + ',"destination":' + JSON.stringify(destination) + ',"index":' + index + '}' } })) }, 'tool_calls') + 'data: [DONE]\n\n');
		};
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const script = join(testWorkspace.directory, 'presentations-mcp.cjs');
	const effects = join(testWorkspace.directory, 'approved-presentations.txt');
	await writeFile(script, `const readline = require('node:readline'); const fs = require('node:fs');
readline.createInterface({input: process.stdin}).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return; let result = {};
 if (m.method === 'initialize') result = {protocolVersion: m.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:'presentations',version:'1'}};
 if (m.method === 'tools/list') result = {tools:[{name:'review_fixture',description:'Review literal fixture evidence',inputSchema:{type:'object',properties:{presentation:{type:'object'},destination:{type:'object'},index:{type:'integer'}},required:['presentation','destination','index']},_meta:{'ash/activity':{version:1,argumentPointer:'/presentation'}}}]};
 if (m.method === 'tools/call') { const a = m.params.arguments; fs.appendFileSync(${JSON.stringify(effects)}, a.index+'\\n'); result = {content:[{type:'text',text:'Approved fixture '+a.index},{type:'resource',resource:{uri:'docs://fixture/'+a.index,mimeType:'text/markdown',text:'# Fixture report\\n\\nLiteral evidence'}}],_meta:{'ash/resultPresentation':{version:1,target:a.index === 4 ? {type:'automationConfigured',automationId:'presentation-automation',label:'Fixture automation'} : {type:'sessionTarget',...a.destination,label:'Fixture destination'}}}}; }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const page = await workbench.openAgentsWindow(target.kind);
		await page.setViewportSize({ width: 1100, height: 900 });
		connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		const { client } = connection;
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture model address missing');
		let config = await client.request(methods['config/read'], {});
		await client.request(methods['mcp/server/upsert'], { commandId: 'presentations-mcp', expectedRevision: config.revision, server: { id: 'user:mcp:presentations', displayName: 'Presentations fixture', transport: { type: 'stdio', command: process.execPath, args: [script] }, credential: { type: 'unauthenticated' }, enablement: 'enabled' } });
		await expect.poll(async () => (await client.request(methods['mcp/server/status'], {})).servers.find(server => server.id === 'user:mcp:presentations')?.toolCount).toBe(1);
		config = await client.request(methods['config/read'], {});
		const provider = 'custom-presentations-fixture'; const model = { provider, model: 'presentations-model' };
		await client.request(methods['provider/configure'], { commandId: 'presentations-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Presentations fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'fixture-key' });
		const create = (commandId: string, title: string) => client.request(methods['session/create'], { commandId, kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const child = await create('presentation-child', 'Fixture destination');
		destination = { sessionId: child.session.sessionId, threadId: child.session.threads[0]!.threadId };
		const created = await create('presentation-source', 'Rich presentation source');
		const sessionId = created.session.sessionId; const threadId = created.session.threads[0]!.threadId;
		const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
		await client.request(methods['automation/write'], { commandId: 'presentation-automation', id: automationId, expectedRevision: 0, status: 'paused', definition: { title: 'Fixture automation', prompt: 'Keep this fixture disabled.', directory: testWorkspace.directory, session: { type: 'continue', sessionId, threadId }, schedule: { type: 'interval', anchor: Date.now() + 3_600_000, minutes: 60 } } });
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Rich presentation source' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await client.request(methods['session/request'], { commandId: 'presentation-turn', sessionId, request: { type: 'startTurn', threadId, expectedSequence: (await read()).sequence, mode: 'agent', approvalMode: 'manual', model, input: [{ type: 'text', text: 'Review the five fixture actions.' }] } });
		await expect(chat.locator('.ash-chat-tool-invocation > summary').filter({ hasText: 'Receiving arguments' })).toHaveCount(5);
		const first = await chat.locator('.ash-chat-tool-invocation').first().elementHandle();
		expect((await read()).turns.at(-1)?.startedToolCallIds ?? []).toHaveLength(0);
		finishArguments!();
		finishArguments = undefined;
		for (let index = 0; index < presentations.length; index++) {
			const approval = chat.locator('.ash-chat-interaction');
			await expect(approval).toContainText(evidence[index]!);
			await expect(approval.locator('script')).toHaveCount(0);
			const current = (await read()).turns.at(-1)!;
			expect(current.pendingInteraction?.kind).toBe('approval');
			expect(current.startedToolCallIds?.length ?? 0).toBe(index);
			if (index === 0) {
				expect(await chat.locator('.ash-chat-tool-invocation').first().evaluate((element, first) => element === first, first)).toBe(true);
				await approval.getByRole('button', { name: 'Next tool', exact: true }).click();
				await expect(approval.getByRole('button', { name: 'Approve once', exact: true })).toBeHidden();
				await approval.getByRole('button', { name: 'Return to current approval', exact: true }).click();
			}
			if (index === 0) {
				await approval.getByText('proposed.ts', { exact: true }).click();
				await expect(approval.getByRole('region', { name: 'proposed.ts: Proposed content', exact: true })).toBeVisible();
			}
			const bounds = await approval.boundingBox();
			for (const button of await approval.getByRole('button').all()) {
				if (!await button.isVisible()) continue;
				const rect = await button.boundingBox();
				expect(rect!.x).toBeGreaterThanOrEqual(bounds!.x);
				expect(rect!.x + rect!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
			}
			await page.screenshot({ path: testInfo.outputPath(`typed-approval-${index}.png`) });
			await approval.getByRole('button', { name: 'Approve once', exact: true }).click();
		}
		await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
		expect(await readFile(effects, 'utf8')).toBe('0\n1\n2\n3\n4\n');
		const automation = chat.locator('.ash-chat-tool-invocation').last();
		await automation.locator(':scope > summary').click();
		await automation.getByRole('button', { name: 'Review automation', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Fixture automation');
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		const tool = chat.locator('.ash-chat-tool-invocation').first();
		await tool.locator(':scope > summary').click();
		await tool.getByRole('button', { name: 'Open conversation', exact: true }).click();
		await expect(page.locator('.ash-sessions-chat-slot.active:visible .ash-chat')).toHaveAttribute('data-thread-id', destination.threadId);
		await first?.dispose();
	} finally {
		finishArguments?.();
		await connection?.close(); server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
