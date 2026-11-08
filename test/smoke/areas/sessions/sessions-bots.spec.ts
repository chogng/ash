import { createServer } from 'node:http';
import { expect, test as base } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

const test = base.extend<{ reviewModelUrl: string; }>({
	reviewModelUrl: async ({ }, use) => {
		let count = 0;
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/responses') {
				response.writeHead(404).end();
				return;
			}
			let body = '';
			for await (const chunk of request) body += chunk;
			const call = body.includes('Source-only prompt') && !body.includes('function_call_output') && !body.includes('Check the order');
			const answer = body.includes('Explain the next step') ? 'Follow-up from Code Review'
				: body.includes('Check the order') ? 'Review reply from Code Review' : 'Source-only answer';
			const result = {
				type: 'response.completed',
				response: {
					id: 'review-fixture-' + ++count, status: 'completed',
					output: call ? [{
						type: 'function_call', id: 'fixture-write', call_id: 'fixture-write', name: 'shell-command',
						arguments: JSON.stringify({
							program: process.execPath, working_directory: '.',
							arguments: ['-e', 'require("node:fs").writeFileSync("review.ts", "const answer = 42;\\n")'],
						}),
					}] : [{
						type: 'message', id: 'answer-' + count, role: 'assistant', phase: 'final_answer',
						content: [{ type: 'output_text', text: answer }],
					}],
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			};
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.end(`event: response.completed\ndata: ${JSON.stringify(result)}\n\n`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected review fixture address');
		try { await use(`http://127.0.0.1:${address.port}/v1`); }
		finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	},
	backendConfiguration: async ({ reviewModelUrl }, use) => {
		await use(`schemaVersion = 10
[agent.model]
provider = "custom-bots-fixture"
model = "gpt-6.1-sol"
[connections.custom-bots-fixture]
provider = "custom-bots-fixture"
connection = "custom-bots-fixture"
baseUrl = ${JSON.stringify(reviewModelUrl)}
[connections.custom-bots-fixture.custom]
protocol = "responses"
name = "Code Review fixture"
contextWindow = 272000
order = 0
model = "gpt-6.1-sol"
`);
	},
});
test.use({ gitRepository: true });

test('Code Review sends and continues a Bots thread with its saved line comparison', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const setup = await connectProfile(application, webAppServer, testWorkspace.directory, page, { directoryGrantsHost: !!webAppServer });
	try {
		if (webAppServer) {
			const grants = await setup.client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
			await setup.client.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
				commandId: 'bots-fixture-directory', expectedRevision: grants.revision, path: testWorkspace.directory,
				permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository'],
			});
		}
		const config = await setup.client.request(APP_SERVER_METHODS['config/read'], {});
		await setup.client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], {
			commandId: 'bots-fixture-shell', expectedRevision: config.revision,
			rule: {
				id: 'bots-fixture-shell', selector: { type: 'source', source: 'built_in_tool', sourceId: 'shell-command' },
				effect: { type: 'allowUnsandboxed' }, justification: 'This test writes one file in its isolated repository.',
			},
		});
	} finally { await setup.close(); }
	// The browser connection seeds changes in the same directory runtime that the UI reads.
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	const { client } = connection;
	try {
		const created = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'bots-fixture-session', kind: 'code', title: 'Code Review source', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0]!.threadId;
		const source = { sessionId, threadId };
		const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], source);
		await client.request(APP_SERVER_METHODS['session/request'], {
			sessionId, commandId: 'bots-fixture-source-turn',
			request: {
				type: 'startTurn', threadId, expectedSequence: (await read()).thread.sequence,
				input: [{ type: 'text', text: 'Source-only prompt' }],
				model: { provider: 'custom-bots-fixture', model: 'gpt-6.1-sol' },
				mode: 'agent', approvalMode: 'bypassPermissions', toolMode: 'direct',
			},
		});
		await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], source)).changeSets.some(change => change.captureState === 'sealed' && change.statistics.additions > 0)).toBe(true);
		const modeControl = page.locator('.ash-window-mode-control');
		const code = modeControl.getByRole('button', { name: 'Code', exact: true });
		await code.click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Code Review source' }).click();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Bots', exact: true }).click();
		const bots = page.locator('.ash-bots-page');
		await bots.getByRole('button', { name: 'Review Changes', exact: true }).click();
		const detail = bots.getByRole('region', { name: 'Comparison', exact: true });
		await expect(detail).toContainText('const answer = 42;');
		await expect(modeControl).toBeHidden();
		await detail.locator('.stanza-diff-editor-side.modified .line-numbers').getByText('1', { exact: true }).hover({ force: true });
		await detail.getByRole('button', { name: 'Add comment on line 1', exact: true }).click();
		await detail.getByRole('textbox', { name: 'Comment for the agent' }).fill('Check the order');
		await detail.getByRole('button', { name: 'Save Draft', exact: true }).click();
		await detail.getByRole('button', { name: 'Send to Code Review', exact: true }).click();
		await expect(detail).toBeHidden();
		const transcript = bots.getByRole('log', { name: 'Chat transcript' });
		await expect(transcript).toContainText('Review reply from Code Review');
		await expect(modeControl).toBeHidden();
		const pageBackground = await page.locator('.ash-desktop-editor-area').evaluate(element => getComputedStyle(element).backgroundColor);
		await expect(bots.locator('.ash-chat')).toHaveCSS('background-color', pageBackground);
		await expect(transcript).not.toContainText('Source-only prompt');
		await expect(bots.getByRole('heading', { name: 'Review review.ts' })).toBeVisible();
		const reference = transcript.getByRole('button', { name: 'review.ts · Line 1' });
		await reference.click();
		await expect(detail).toContainText('Saved comparison');
		await expect(detail).toContainText('Check the order');
		await expect(detail).toContainText('const answer = 42;');
		await detail.getByRole('button', { name: 'Close Comparison' }).press('Escape');
		await expect(detail).toBeHidden();
		await expect(reference).toBeFocused();
		const composer = new Editor(bots.locator('.ash-chat-input-part'));
		await composer.waitForEditorFocus();
		await composer.waitForTypeInEditor('Explain the next step');
		await composer.input.press('Enter');
		await expect(transcript).toContainText('Follow-up from Code Review');
		const assistant = bots.locator('.ash-chat-item-agentMessage .ash-chat-participant').first();
		const user = bots.locator('.ash-chat-user-message .ash-chat-participant').first();
		await expect(assistant).toHaveText('Code Review');
		await expect(user).toHaveText('You');
		const assistantAvatar = await assistant.locator('.ash-chat-participant-avatar').boundingBox();
		const userAvatar = await user.locator('.ash-chat-participant-avatar').boundingBox();
		expect(assistantAvatar!.x + assistantAvatar!.width).toBeLessThan(userAvatar!.x);
		expect((await read()).thread.turns).toHaveLength(1);
		await testInfo.attach('bots-review', { body: await page.screenshot(), contentType: 'image/png' });
		const sidebar = page.getByRole('region', { name: 'Bots', exact: true });
		await sidebar.getByRole('button', { name: 'Back', exact: true }).press('Enter');
		await expect(bots).toBeHidden();
		await expect(code).toBeVisible();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
	} finally { await connection.close(); }
});
