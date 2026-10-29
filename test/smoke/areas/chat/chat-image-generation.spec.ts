import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// Only the model and image service are controlled. MCP, Core, persistence and the Desktop UI are real.
test(
	'Desktop image generation shows live progress, downloads the result and restores without replay',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		const provider = 'custom-image-generation-fixture';
		const model = { provider, model: 'image-fixture-model' };
		const mcpId = 'user:mcp:image-fixture';
		let modelRequests = 0;
		let imageResponse: ServerResponse | undefined;
		let imageData = '';
		const server = createServer(async (request, response) => {
			try {
				if (request.url === '/image') {
					imageResponse = response;
					return;
				}
				if (request.method === 'GET') {
					response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { name: string }[] };
				modelRequests++;
				const name = body.tools?.find(tool => tool.name?.includes('imagegen'))?.name;
				if (modelRequests === 1 && !name) throw new Error(`Image tool missing from model request: ${JSON.stringify(body.tools)}`);
				const output =
					modelRequests === 1
						? [
								{
									type: 'function_call',
									id: 'generated-call',
									call_id: 'generated-call',
									name,
									arguments: '{"prompt":"two synthetic color fields"}',
								},
							]
						: [
								{
									type: 'message',
									id: 'final-message',
									role: 'assistant',
									content: [{ type: 'output_text', text: 'Image ready.' }],
								},
							];
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end(
					`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: `image-response-${modelRequests}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
				);
			} catch (error) {
				response.writeHead(500).end(String(error));
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing synthetic service address');
		const endpoint = `http://127.0.0.1:${address.port}`;
		const script = join(testWorkspace.directory, 'image-mcp.cjs');
		await writeFile(
			script,
			`const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', async line => {
 const message = JSON.parse(line);
 if (message.id === undefined) return;
 try {
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'image-generation-fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'imagegen', description: 'Generate the synthetic image for this test.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false } }] };
  if (message.method === 'tools/call') result = await (await fetch('${endpoint}/image')).json();
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
 } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }) + '\\n'); }
});`,
		);
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		let imagePage: Page | undefined;
		let readThread: (() => Promise<unknown>) | undefined;
		const capture = async (page: Page, name: string): Promise<void> => {
			const path = testInfo.outputPath(name);
			await page.screenshot({ path });
			await testInfo.attach(name, { path, contentType: 'image/png' });
		};
		try {
			let page = await workbench.openAgentsWindow(target.kind);
			imagePage = page;
			imageData = await page.evaluate(() => {
				const canvas = document.createElement('canvas');
				canvas.width = 360;
				canvas.height = 220;
				const context = canvas.getContext('2d')!;
				context.fillStyle = '#e5a738';
				context.fillRect(0, 0, 180, 220);
				context.fillStyle = '#537ac9';
				context.fillRect(180, 0, 180, 220);
				return canvas.toDataURL('image/png').split(',')[1]!;
			});
			connection = await connectProfile(application, undefined, testWorkspace.directory, page);
			const { client } = connection;
			let config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['mcp/server/upsert'], {
				commandId: 'image-mcp',
				expectedRevision: config.revision,
				server: {
					id: mcpId,
					displayName: 'Synthetic image generation',
					transport: { type: 'stdio', command: process.execPath, args: [script] },
					credential: { type: 'unauthenticated' },
					enablement: 'enabled',
				},
			});
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['mcp/server/status'], {})).servers.find(server => server.id === mcpId)?.toolCount).toBe(1);
			config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'image-model',
				expectedRevision: config.revision,
				config: {
					connection: provider,
					provider,
					baseUrl: `${endpoint}/v1`,
					custom: {
						name: 'Synthetic image fixture',
						protocol: 'responses',
						order: 0,
						contextWindow: 272_000,
					},
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				},
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], {
				connection: provider,
				apiKey: 'synthetic-image-fixture-key',
			});
			const created = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'image-session',
				title: 'Generated image test',
				agent: { type: 'default' },
				executionTarget: { type: 'local', root: testWorkspace.directory },
			});
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0]!.threadId;
			const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			readThread = async () => {
				const thread = await read();
				return {
					sequence: thread.sequence,
					turns: thread.turns.map(turn => ({ turnId: turn.turnId, status: turn.status, items: turn.items })),
				};
			};
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Generated image test' }).click();
			const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: 'image-turn',
				sessionId,
				request: {
					type: 'startTurn',
					threadId,
					expectedSequence: (await read()).sequence,
					mode: 'agent',
					approvalMode: 'bypassPermissions',
					model,
					input: [{ type: 'text', text: 'Generate a synthetic image using the configured imagegen tool.' }],
				},
			});
			await expect.poll(() => !!imageResponse).toBe(true);
			await expect(chat.locator('.ash-chat-image-generation-placeholder')).toBeVisible();
			await capture(page, 'image-generating.png');
			const summary = chat.locator('.ash-chat-tool-invocation summary').filter({ hasText: 'Generating image' });
			await summary.focus();
			imageResponse!.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					content: [
						{ type: 'text', text: 'Generated synthetic image' },
						{ type: 'image', data: imageData, mimeType: 'image/png' },
					],
				}),
			);
			const images = chat.locator('.ash-chat-generated-image-result');
			await expect.poll(() => images.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(360);
			await expect(chat.locator('.ash-chat-tool-invocation summary').filter({ hasText: 'Generated image' })).toBeFocused();
			await expect(chat.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			if (!('windows' in application)) throw new Error('This scenario requires Electron');
			const downloadPath = testInfo.outputPath('generated.png');
			await application.evaluate(
				({ BrowserWindow }, { url, path }) => {
					const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
					if (!owner) throw new Error('Image result window is missing');
					owner.webContents.session.once('will-download', (_event, item) => item.setSavePath(path));
				},
				{ url: page.url(), path: downloadPath },
			);
			await images.getByRole('button', { name: 'Download', exact: true }).click();
			await expect.poll(async () => (await readFile(downloadPath).catch(() => Buffer.alloc(0))).toString('base64')).toBe(imageData);
			await capture(page, 'image-completed.png');
			page = await workbench.reopenAgentsWindow(application, page);
			imagePage = page;
			await expect(page.locator('.ash-chat-generated-image-result img')).toBeVisible();
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await capture(page, 'image-restored.png');
		} catch (error) {
			const statePath = testInfo.outputPath('image-state.json');
			await writeFile(
				statePath,
				JSON.stringify(
					{
						thread: await readThread?.(),
						dom: await imagePage?.evaluate(() =>
							[...document.querySelectorAll('.ash-chat-generated-image-result')].map(element => ({
								text: element.textContent,
								images: [...element.querySelectorAll('img')].map(image => ({
									source: image.src.slice(0, 160),
									width: image.naturalWidth,
									hidden: image.hidden,
								})),
							})),
						),
					},
					null,
					2,
				),
			);
			await testInfo.attach('image-state.json', { path: statePath, contentType: 'application/json' });
			if (imagePage && !imagePage.isClosed()) {
				const screenshotPath = testInfo.outputPath('image-failed.png');
				await imagePage.screenshot({ path: screenshotPath });
				await testInfo.attach('image-failed.png', { path: screenshotPath, contentType: 'image/png' });
			}
			throw error;
		} finally {
			imageResponse?.destroy();
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	},
);
