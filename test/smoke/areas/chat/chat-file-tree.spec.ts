import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as base } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

const test = base.extend<{ treeModel: Awaited<ReturnType<typeof createTreeModel>>; }>({
	treeModel: async ({ }, use) => {
		const model = await createTreeModel();
		try { await use(model); } finally { await model.close(); }
	},
	backendConfiguration: async ({ testWorkspace, treeModel }, use) => {
		const script = join(testWorkspace.directory, 'tree-mcp.mjs');
		const tree = {
			kind: 'treeData', treeData: {
				label: 'Captured workspace', uri: pathToFileURL(testWorkspace.directory).toString(),
				children: [{ label: 'main.ts', uri: pathToFileURL(join(testWorkspace.directory, 'main.ts')).toString(), type: 'file' }],
			}
		};
		await writeFile(join(testWorkspace.directory, 'main.ts'), 'const treeSnapshot = 42;\n');
		await writeFile(script, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
 const message = JSON.parse(line);
 if (message.id === undefined) continue;
 let result = {};
 if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'captured-tree', version: '1' } };
 if (message.method === 'tools/list') result = { tools: [{ name: 'show_tree', description: 'Show the captured workspace tree', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
 if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'Workspace captured.' }], structuredContent: ${JSON.stringify(tree)} };
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
}
`);
		await use(`schemaVersion = 10
[connections.custom-tree]
provider = "custom-tree"
connection = "custom-tree"
baseUrl = ${JSON.stringify(treeModel.url)}
[connections.custom-tree.custom]
protocol = "chatCompletions"
name = "Tree fixture"
contextWindow = 272000
order = 0
model = "tree-test"
[mcp.servers."user:mcp:trees"]
id = "user:mcp:trees"
displayName = "Captured trees"
enablement = "enabled"
[mcp.servers."user:mcp:trees".transport]
type = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(script)}]
`);
	},
});

async function createTreeModel() {
	let called = false;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: { role: string; content: unknown; }[]; tools?: { function?: { name: string; }; }[]; };
		const mapping = body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Apply the supplied code to the supplied current file.'));
		const name = body.tools?.map(tool => tool.function?.name).find(name => name?.includes('show_tree'));
		const call = !!name && !called;
		called ||= call;
		const delta = mapping ? { content: 'const treeSnapshot = 43;\n' } : call ? { tool_calls: [{ index: 0, id: 'captured-tree-call', type: 'function', function: { name, arguments: '{}' } }] } : { content: 'The workspace tree is captured.\n```ts\nconst treeSnapshot = 43;\n```' };
		const packet = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(packet({ id: 'tree-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
			+ packet({ id: 'tree-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Tree model has no port');
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		get called() { return called; },
		close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
	};
}

for (const surface of ['IDE', 'Agent Window'] as const) {
	test(`${surface} MCP tree snapshots open sources and code blocks stream into review`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, testWorkspace, workbench, treeModel }) => {
		test.setTimeout(90_000);
		const agents = surface === 'Agent Window';
		const page = agents ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		await page.bringToFront();
		if (agents) await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const window = new Workbench(page);
		const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		try {
			await connection.client.request(methods['mcp/server/connect'], { serverId: 'user:mcp:trees' });
			const { session } = await connection.client.request(methods['session/create'], {
				commandId: 'tree-session', kind: 'code', title: 'Captured tree source', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory },
			});
			const threadId = session.threads[0].threadId;
			const read = () => connection.client.request(methods['session/thread/read'], { sessionId: session.sessionId, threadId });
			await connection.client.request(methods['session/request'], {
				sessionId: session.sessionId, commandId: 'tree-turn', request: {
					type: 'startTurn', threadId, expectedSequence: (await read()).thread.sequence,
					// The isolated MCP fixture is the only external tool and only returns this test's snapshot.
					model: { provider: 'custom-tree', model: 'tree-test' }, mode: 'agent', toolMode: 'direct', approvalMode: 'bypassPermissions',
					input: [{ type: 'text', text: 'Show the captured workspace tree.' }],
				},
			});
			if (agents) {
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Captured tree source' }).click();
			} else {
				await window.quickaccess.runCommand('workbench.action.chat.open');
				if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) await window.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar');
				await page.locator('.ash-chat-sessions-sidebar .ash-agent-session-row').filter({ hasText: 'Captured tree source' }).click();
			}
			const chat = page.locator(agents ? '.ash-sessions-chat-slot.active:visible .ash-chat' : '.ash-chat-view-pane .ash-chat:visible').first();
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
			expect((await read()).thread.turns.at(-1)?.items.filter(item => item.type === 'toolResult' && item.isError)).toEqual([]);
			expect(treeModel.called).toBe(true);
			const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
			await input.focus();
			await page.keyboard.insertText('Retain the tree draft');
			await window.quickaccess.runCommand('workbench.action.chat.nextFileTree');
			const tree = chat.getByRole('tree', { name: 'File tree: Captured workspace' });
			await expect(tree).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect(page.getByRole('tab', { name: 'main.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect(page.locator('.ash-editor-group-content:visible .stanza-editor-line-text').filter({ hasText: 'const treeSnapshot = 42;' })).toBeVisible();
			await expect(chat.locator('.ash-chat-input-editor .stanza-editor-line-text')).toHaveText('Retain the tree draft');
			await chat.getByRole('button', { name: 'Apply to editor', exact: true }).click();
			const fileLines = page.locator('.ash-editor-group-content:visible .stanza-editor-line-text');
			await expect(fileLines.filter({ hasText: 'const treeSnapshot = 43;' })).toBeVisible();
			await window.quickaccess.runCommand('chatEditing.rejectAll');
			await expect(fileLines.filter({ hasText: 'const treeSnapshot = 42;' })).toBeVisible();
			await expect(chat.locator('.ash-chat-input-editor .stanza-editor-line-text')).toHaveText('Retain the tree draft');
		} finally { await connection.close(); }
	});
}
