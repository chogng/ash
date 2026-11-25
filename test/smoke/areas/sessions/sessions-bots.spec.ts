import { createServer } from 'node:http';
import { expect, test as base } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

const reviewLine = 160;
const reviewedText = 'const reviewedAnswer = 43;';
const reviewFile = ['const answer = 42;',
	...Array.from({ length: reviewLine - 2 }, (_, index) => `// Review fixture line ${index + 2}`), reviewedText,
	...Array.from({ length: 40 }, (_, index) => `// Review fixture line ${reviewLine + index + 1}`), ''].join('\n');
const reviewPatch = ['*** Begin Patch', '*** Add File: review.ts',
	...reviewFile.trimEnd().split('\n').map(line => `+${line}`), '*** End Patch'].join('\n');

const test = base.extend<{ reviewModelUrl: string; }>({
	reviewModelUrl: async ({ }, use) => {
		let applied = false;
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { role: string; content: unknown; }[]; };
			// The provider can append other user-role messages after the fixture prompt.
			const hasPrompt = (phrase: string): boolean => messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(phrase));
			const applyPatch = !applied && hasPrompt('Source-only prompt');
			const answer = hasPrompt('Explain the next step') ? 'Follow-up from Code Review'
				: hasPrompt('Check the order') ? 'Review reply from Code Review' : 'Source-only answer';
			const delta = applyPatch ? {
				tool_calls: [{
					index: 0, id: 'fixture-write', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: reviewPatch }) },
				}]
			} : { content: answer };
			applied ||= applyPatch;
			const packet = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
				+ packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: applyPatch ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
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
protocol = "chatCompletions"
name = "Code Review fixture"
contextWindow = 272000
order = 0
model = "gpt-6.1-sol"
`);
	},
});
// Every line in the fixture is added. Keep the desktop scenario focused on range navigation.
test.use({ gitRepository: true, electronUserSettings: { 'diffEditor.hideUnchangedRegions.enabled': false } });

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
		await setup.client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: 'custom-bots-fixture', apiKey: 'isolated-bots-fixture-key' });
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
				approvalMode: 'bypassPermissions',
			},
		});
		await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
		const results = (await read()).thread.turns.at(-1)!.items.filter(item => item.type === 'toolResult');
		expect(results).toEqual([expect.objectContaining({ isError: false })]);
		const changeSets = async () => (await client.request(APP_SERVER_METHODS['turnChanges/list'], source)).changeSets;
		await expect.poll(async () => (await changeSets())[0]?.captureState).toBe('sealed');
		const capture = (await changeSets())[0]!;
		const comparison = await client.request(APP_SERVER_METHODS['turnChanges/read'], { ...source, changeSetId: capture.changeSetId });
		expect(comparison.files.map(file => file.path)).toEqual(['review.ts']);
		const modeControl = page.locator('.ash-window-mode-control');
		const code = modeControl.getByRole('button', { name: 'Code', exact: true });
		await code.click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Code Review source' }).click();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Bots', exact: true }).click();
		const bots = page.locator('.ash-bots-page');
		await bots.getByRole('button', { name: 'Review Changes', exact: true }).click();
		const detail = bots.getByRole('region', { name: 'Comparison', exact: true });
		const multiDiff = detail.locator('.stanza-multi-diff-editor');
		const modifiedLines = detail.locator('.stanza-diff-editor-side.modified .view-line');
		const reviewedLine = modifiedLines.filter({ hasText: reviewedText });
		await expect(detail).toContainText('const answer = 42;');
		await expect(modeControl).toBeHidden();
		await expect(reviewedLine).not.toBeInViewport();
		const lineHeight = await modifiedLines.filter({ hasText: 'const answer = 42;' }).evaluate(element => element.getBoundingClientRect().height);
		await multiDiff.hover();
		await page.mouse.wheel(0, (reviewLine - 6) * lineHeight);
		await expect(reviewedLine).toBeInViewport();
		await detail.locator('.stanza-diff-editor-side.modified .line-numbers').getByText(String(reviewLine), { exact: true }).hover({ force: true });
		await detail.getByRole('button', { name: `Add comment on line ${reviewLine}`, exact: true }).click();
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
		const reference = transcript.getByRole('button', { name: `review.ts · Line ${reviewLine}` });
		await reference.click();
		await expect(detail).toContainText('Saved comparison');
		await expect(reviewedLine).toBeInViewport();
		await expect.poll(() => multiDiff.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await expect(multiDiff.getByText('Check the order', { exact: true })).toBeInViewport();
		await testInfo.attach('code-review-deep-line', { body: await detail.screenshot(), contentType: 'image/png' });
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
