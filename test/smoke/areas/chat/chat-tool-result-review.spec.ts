import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// Model responses are synthetic; MCP execution, durable interactions and Desktop are real.
test('Desktop reviews only opted-in tool results and preserves effects when skipping', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(120_000);
	const provider = 'custom-result-review-fixture';
	const model = { provider, model: 'result-review-model' };
	const mcpId = 'user:mcp:result-review-fixture';
	const modelInputs: unknown[] = [];
	const server = createServer(async (request, response) => {
		try {
			if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] })); return; }
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { name: string; }[]; };
			modelInputs.push(body);
			const index = Math.ceil(modelInputs.length / 2);
			const name = body.tools?.find(tool => tool.name?.includes('capture_result'))?.name;
			if (modelInputs.length % 2 === 1 && !name) throw new Error('Review fixture tool is missing');
			const output = modelInputs.length % 2 === 1
				? [{ type: 'function_call', id: `review-call-${index}`, call_id: `review-call-${index}`, name, arguments: JSON.stringify({ index, review: index < 3 }) }]
				: [{ type: 'message', id: `final-${index}`, role: 'assistant', content: [{ type: 'output_text', text: `Finished result ${index}.` }] }];
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `review-response-${modelInputs.length}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`);
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing model service address');
	const script = join(testWorkspace.directory, 'result-review-mcp.cjs');
	const effects = join(testWorkspace.directory, 'executed-results.txt');
	await writeFile(script, `const readline = require('node:readline');
const fs = require('node:fs');
let negotiated = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line);
 if (message.id === undefined) return;
 try {
  let result = {};
  if (message.method === 'initialize') {
   negotiated = message.params.capabilities.extensions?.['ash/resultReview']?.versions?.includes(1);
   result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'result-review-fixture', version: '1' } };
  }
  if (message.method === 'tools/list') result = { tools: [{ name: 'capture_result', description: 'Execute and optionally request result disclosure review.', inputSchema: { type: 'object', properties: { index: { type: 'integer' }, review: { type: 'boolean' } }, required: ['index', 'review'], additionalProperties: false } }] };
  if (message.method === 'tools/call') {
   if (!negotiated) throw new Error('Host did not negotiate result review v1');
   const { index, review } = message.params.arguments;
   fs.appendFileSync(${JSON.stringify(effects)}, index + '\\n');
   result = { content: [{ type: 'text', text: 'private-result-' + index + ' <img src=x>' }] };
   if (review) result._meta = { 'ash/resultReview': { version: 1, reason: 'Review captured result ' + index } };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
 } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }) + '\\n'); }
});`);
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		let page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		const { client } = connection;
		let config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['mcp/server/upsert'], { commandId: 'review-mcp', expectedRevision: config.revision, server: { id: mcpId, displayName: 'Result review fixture', transport: { type: 'stdio', command: process.execPath, args: [script] }, credential: { type: 'unauthenticated' }, enablement: 'enabled' } });
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['mcp/server/status'], {})).servers.find(server => server.id === mcpId)?.toolCount).toBe(1);
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'review-model', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Result review fixture', protocol: 'responses', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-review-key' });
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'review-session', kind: 'code', title: 'Result disclosure review', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0]!.threadId;
		const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Result disclosure review' }).click();
		for (const index of [1, 2, 3]) {
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: `review-turn-${index}`, sessionId, request: { type: 'startTurn', threadId, expectedSequence: (await read()).sequence, mode: 'agent', approvalMode: 'bypassPermissions', model, input: [{ type: 'text', text: `Capture result ${index} using the configured tool.` }] } });
			if (index < 3) {
				const review = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat-tool-result-review');
				await expect(review()).toBeVisible();
				await expect(review().getByRole('region', { name: 'Results awaiting review' })).toHaveText(`private-result-${index} <img src=x>`);
				await expect(review().locator('img')).toHaveCount(0);
				expect(modelInputs).toHaveLength(index * 2 - 1);
				expect((await read()).turns.at(-1)?.items.some(item => item.type === 'toolResult')).toBe(false);
				if (index === 1) {
					page = await workbench.reopenAgentsWindow(application, page);
					await expect(review()).toBeVisible();
					await expect(review().getByRole('region')).toHaveText('private-result-1 <img src=x>');
				}
				await page.screenshot({ path: testInfo.outputPath(`review-${index}.png`) });
				await review().getByRole('button', { name: index === 1 ? 'Skip results' : 'Share results', exact: true }).click();
				await expect(review()).toHaveCount(0);
			}
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			expect(modelInputs).toHaveLength(index * 2);
			const delivered = JSON.stringify(modelInputs.at(-1));
			if (index === 1) { expect(delivered).not.toContain('private-result-1'); expect(delivered).toContain('chose not to share'); }
			else { expect(delivered).toContain(`private-result-${index}`); }
			expect(await readFile(effects, 'utf8')).toBe(Array.from({ length: index }, (_, i) => `${i + 1}\n`).join(''));
		}
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
