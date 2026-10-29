import { createServer } from 'node:http';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { Workbench } from '../../../automation/workbench.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS, APPROVAL_MODE_DEFINITIONS } from '../../../../.build/protocol/typescript/index.js';

const attachmentMarker = 'k_file_review_attachment_snapshot_20261012';

interface ModelRequest {
	readonly messages?: readonly { readonly role: string; readonly content: unknown; }[];
	readonly tools?: readonly { readonly function?: { readonly name: string; }; }[];
}

// Inspect the existing editor through Chromium's debugger. This reads its real
// model without registering a product API or synthesizing document requests.
async function captureEditorModel(page: Page): Promise<unknown> {
	const debuggerSession = await page.context().newCDPSession(page);
	const objectGroup = 'k-editor-identity';
	try {
		const node = await debuggerSession.send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[data-part="editor"]:not(.ash-sessions-chat-grid) .stanza-editor')].find(node => node.getClientRects().length > 0)?.closest('.stanza-editor-pane')`, objectGroup });
		if (!node.result.objectId) { return { status: 'unavailable', reason: 'The file editor pane has no debugger object' }; }
		const { listeners } = await debuggerSession.send('DOMDebugger.getEventListeners', { objectId: node.result.objectId });
		const queue = listeners.flatMap(listener => listener.handler?.objectId ? [{ id: listener.handler.objectId, depth: 0 }] : []);
		const seen = new Set<string>();
		const inspectedScopes: { depth: number; description: string; }[] = [];
		while (queue.length && seen.size < 80) {
			const entry = queue.shift()!;
			if (seen.has(entry.id)) { continue; }
			seen.add(entry.id);
			const inspected = await debuggerSession.send('Runtime.callFunctionOn', {
				objectId: entry.id, returnByValue: true, silent: true,
				functionDeclaration: `function () {
					const editor = typeof this.getControl === 'function' ? this.getControl() : this;
					const node = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : undefined;
					const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : undefined;
					if (!node || !model || !node.matches('[data-part="editor"]:not(.ash-sessions-chat-grid) .stanza-editor')) return null;
					return { uri: model.uri.toString(), text: model.getValue(), version: model.getVersionId() };
				}`,
			});
			if (inspected.result.value) { return { status: 'recorded', model: inspected.result.value, inspectedObjects: seen.size }; }
			if (entry.depth >= 4) { continue; }
			const properties = await debuggerSession.send('Runtime.getProperties', { objectId: entry.id, ownProperties: true });
			for (const property of [...(properties.internalProperties ?? []), ...properties.result]) {
				const value = property.value;
				if (!value?.objectId || value.subtype === 'node' || /^(Window|Document|global|Global|Script|Module)(\b|$)/u.test(value.description ?? '')) { continue; }
				if (property.name === '[[Prototype]]') { continue; }
				inspectedScopes.push({ depth: entry.depth + 1, description: (value.description ?? value.className ?? value.type).slice(0, 80) });
				const candidate = { id: value.objectId, depth: entry.depth + 1 };
				if (property.name === 'this' || property.name === '[[BoundThis]]') { queue.unshift(candidate); } else { queue.push(candidate); }
			}
		}
		return { status: 'unavailable', reason: 'No existing file editor model found in event listener closures', inspectedObjects: seen.size, inspectedScopes };
	} catch (error) {
		return { status: 'unavailable', reason: String(error) };
	} finally {
		await debuggerSession.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
		await debuggerSession.detach().catch(() => undefined);
	}
}

function modelFixture(patches: ReadonlyMap<string, string> = new Map([['Apply the isolated review edit.', '*** Begin Patch\n*** Update File: main.ts\n@@\n-const value = 1;\n+const value = 42;\n*** End Patch']]), measureDirectory = true) {
	const sent = new Set<string>();
	const calls: { tools: string[]; patch: boolean; attachment: boolean; }[] = [];
	const requests: ModelRequest[] = [];
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: 'review-fixture' }] }));
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest;
			requests.push(body);
			const edit = [...patches].reverse().find(([prompt]) => body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes(prompt)));
			const names = body.tools?.map(tool => tool.function?.name ?? '') ?? [];
			const patch = !!edit && !sent.has(edit[0]);
			const attachment = body.messages?.some(message => JSON.stringify(message.content).includes(attachmentMarker)) ?? false;
			calls.push({ tools: names, patch, attachment });
			if (patch && (!names.includes('apply_patch') || (measureDirectory && !names.includes('shell-command')))) { throw new Error('The real model request did not expose apply_patch and shell-command'); }
			const delta = patch ? {
				// A read-only command in this same real editing Turn measures the Tool's
				// selected directory. Relative dot leaves directory choice to its owner.
				tool_calls: [...(measureDirectory ? [{ index: 0, id: 'isolated-cwd', type: 'function', function: { name: 'shell-command', arguments: JSON.stringify({ program: '/bin/pwd', arguments: [], working_directory: '.' }) } }] : []), { index: measureDirectory ? 1 : 0, id: `isolated-edit-${sent.size}`, type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: edit![1] }) } }],
			} : { content: edit ? 'Isolated edit complete.' : 'Review fixture ready.' };
			if (patch) sent.add(edit![0]);
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			const packet = (value: unknown): string => 'data: ' + JSON.stringify(value) + '\n\n';
			response.end(packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
				+ packet({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: patch ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
		} catch (error) {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: { message: String(error), type: 'fixture_error' } }));
		}
	});
	return { server, calls, requests };
}

const documentTest = test.extend<{
	reviewAutoAcceptDelay: number;
	agent: {
		page: Page;
		workbench: Workbench;
		code: Workbench;
		directory: string;
		send(prompt: string, patch: string): Promise<void>;
	};
}>({
	reviewAutoAcceptDelay: 0,
	agent: async ({ application, webAppServer, target, testWorkspace, workbench, reviewAutoAcceptDelay }, use, testInfo) => {
		const patches = new Map<string, string>();
		const { server, calls, requests } = modelFixture(patches, false);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const source = workbench.page;
		let control: Page | undefined;
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		try {
			if (target.kind === 'browser') {
				control = await source.context().newPage();
				await control.goto(source.url(), { waitUntil: 'domcontentloaded' });
			}
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, control ?? source);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('The model fixture has no port');
			const provider = 'custom-editor-review-fixture';
			const model = { provider, model: 'review-fixture' };
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'editor-review-provider', expectedRevision: config.revision,
				config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Editor review fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { 'review-fixture': { contextWindow: 272_000 } } },
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('agents');
			await workbench.settingsEditor.selectCategory('models');
			const enabled = source.getByRole('switch', { name: 'Enable review-fixture', exact: true });
			if (!await enabled.isChecked()) await enabled.press('Space');
			if (reviewAutoAcceptDelay) {
				await workbench.settingsEditor.selectCategory('agent-defaults');
				const setting = source.getByRole('spinbutton', { name: 'Automatically accept Agent changes', exact: true });
				await setting.fill(String(reviewAutoAcceptDelay));
				await setting.press('Tab');
			}
			await source.locator('.ash-modal-editor-close').click();
			const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'editor-review-default', expectedRevision: configured.revision, model });
			const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'editor-review-session', title: 'Editor document fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const root = created.session.threads[0];
			if (!root) throw new Error('The Session has no root Thread');
			const identity = { sessionId: created.session.sessionId, threadId: root.threadId };
			const before = await client.request(APP_SERVER_METHODS['session/thread/read'], identity);
			await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'editor-review-ready', sessionId: identity.sessionId, request: { type: 'startTurn', threadId: identity.threadId, expectedSequence: before.thread.sequence, mode: 'agent', approvalMode: 'manual', model, input: [{ type: 'text', text: 'Return the review fixture ready message without using tools.' }] } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns.at(-1)?.status).toBe('completed');
			if (before.directory?.type !== 'local') throw new Error('The Session has no local directory');
			const page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Editor document fixture' }).click();
			const sessions = new Workbench(page);
			const composer = page.locator('.ash-sessions-chat-slot.active:visible [role=region][data-thread-id]');
			await expect(composer).toHaveAttribute('data-thread-id', identity.threadId);
			await composer.locator('.ash-chat-input-mode-action').click();
			await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true }).click();
			const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions')!;
			await composer.getByRole('button', { name: /^Permissions:/ }).click();
			await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
			await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: bypass.label.english, exact: true }).click();
			await sessions.quickaccess.runCommand('workbench.sessions.auxiliaryBar.filesContainer');
			await use({
				page, workbench: sessions, code: workbench, directory: before.directory.root,
				async send(prompt, patch) {
					patches.set(prompt, patch);
					const count = (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns.length;
					const input = composer.locator('.ash-chat-input-editor .stanza-editor-input');
					await input.focus();
					await page.keyboard.insertText(prompt);
					await expect(input).toBeFocused();
					await input.press('Enter');
					await expect.poll(async () => {
						const turns = (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns;
						const status = turns.at(-1)?.status;
						return { count: turns.length, done: status === 'completed' || status === 'failed' || status === 'interrupted' };
					}, { timeout: 90_000 }).toEqual({ count: count + 1, done: true });
					const turn = (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns.at(-1)!;
					expect(turn.status, JSON.stringify(turn)).toBe('completed');
					const result = turn.items.find(item => item.type === 'toolResult' && item.toolCallId.startsWith('isolated-edit-'));
					expect(result, JSON.stringify(turn)).toBeDefined();
					expect(result).toMatchObject({ type: 'toolResult', isError: false });
				},
			});
		} finally {
			await testInfo.attach('real-document-traffic', { body: JSON.stringify({ calls, requests }), contentType: 'application/json' });
			await connection?.close();
			await control?.close();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	},
});

documentTest('Real Agent document callbacks preserve dirty BOM/CRLF text and review open, closed and created files', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ agent }) => {
	test.setTimeout(180_000);
	const { page, workbench, code, directory } = agent;
	const original = 'first\r\nseparator 1\r\nseparator 2\r\nseparator 3\r\nseparator 4\r\nlast';
	const file = join(directory, 'agent-review.txt');
	const closed = join(directory, 'agent-closed.txt');
	const created = join(directory, 'agent-created.txt');
	await writeFile(file, '\uFEFF' + original);
	await writeFile(closed, '\uFEFFclosed original\r\nsecond');
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'agent-review.txt', exact: true }).dblclick();
	const editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-editor-group').first());
	await editor.waitForEditorFocus();
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('ArrowDown');
	await editor.input.press('Home');
	await editor.waitForTypeInEditor('user ');
	await agent.send('Apply the multi-file editor review.', '*** Begin Patch\n*** Update File: agent-review.txt\n@@\n-first\n+agent first\n@@\n-last\n+agent last\n*** Update File: agent-closed.txt\n@@\n-closed original\n+closed agent\n*** End Patch');
	await expect.poll(() => readFile(file)).toEqual(Buffer.from('\uFEFF' + original.replace('first', 'agent first').replace('separator 1', 'user separator 1').replace('last', 'agent last')));
	await expect.poll(() => readFile(closed)).toEqual(Buffer.from('\uFEFFclosed agent\r\nsecond'));
	const review = editor.element.locator('.ash-chat-editing-overlay');
	await expect(review.locator('.ash-chat-editing-count')).toHaveText('1 of 2');
	await expect(editor.element.locator('.ash-chat-editing-deleted')).toHaveText(['first', 'last']);
	await workbench.quickaccess.runCommand('workbench.action.splitEditorRight');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-editor-group').nth(1).locator('.ash-chat-editing-overlay')).toBeVisible();
	expect(await review.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		return [...element.querySelectorAll('button')].every(button => {
			const rect = button.getBoundingClientRect();
			return rect.left >= bounds.left && rect.right <= bounds.right;
		});
	})).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.closeEditorsInGroup');
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await code.quickaccess.runCommand('workbench.action.selectTheme');
		await code.quickaccess.input.fill(theme);
		await code.quickaccess.input.press('Enter');
		await expect(review).toHaveCSS('border-top-style', 'solid');
		await expect.poll(() => review.evaluate(element => parseFloat(getComputedStyle(element).borderTopWidth))).toBeGreaterThan(0);
		await expect(review).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(editor.element.locator('.ash-chat-editing-deleted').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}

	await page.bringToFront();
	await review.getByRole('button', { name: 'Next change', exact: true }).click();
	await expect(review.locator('.ash-chat-editing-count')).toHaveText('2 of 2');
	await review.getByRole('button', { name: 'Previous change', exact: true }).click();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Review Agent changes[\s\S]*Press Escape to return to the editor/);
	await page.keyboard.press('Escape');
	await expect(review.getByRole('button', { name: 'Previous change', exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Before:\nfirst[\s\S]*After:\nagent first/);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await expect(editor.input).toBeFocused();
	await review.getByRole('button', { name: 'Accept change', exact: true }).click();
	await expect(review.locator('.ash-chat-editing-count')).toHaveText('1 of 1');
	await review.getByRole('button', { name: 'Reject file changes', exact: true }).click();
	await expect(review).toBeHidden();
	await expect.poll(() => readFile(file)).toEqual(Buffer.from('\uFEFF' + original.replace('first', 'agent first').replace('separator 1', 'user separator 1')));
	await workbench.quickaccess.runCommand('chatEditing.rejectAll');
	await expect.poll(() => readFile(closed)).toEqual(Buffer.from('\uFEFFclosed original\r\nsecond'));
	await agent.send('Create a reviewable file.', '*** Begin Patch\n*** Add File: agent-created.txt\n+new file\n*** End Patch');
	await expect.poll(() => readFile(created, 'utf8')).toBe('new file\n');
	await workbench.quickaccess.runCommand('chatEditing.rejectAll');
	await expect.poll(() => readFile(created, 'utf8').catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
});

const countdownTest = documentTest.extend({ reviewAutoAcceptDelay: 3 });

documentTest('Real Agent text edits preserve BOM and CRLF through one undo and save', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ agent }) => {
	test.setTimeout(180_000);
	const { page, directory } = agent;
	const path = join(directory, 'agent-undo.txt');
	await writeFile(path, '\uFEFFfirst\r\nsecond');
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'agent-undo.txt', exact: true }).dblclick();
	const editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
	await editor.waitForEditorFocus();
	await editor.input.press('ControlOrMeta+Home');
	await editor.waitForTypeInEditor('unsaved ');
	await agent.send('Apply the undoable edit.', '*** Begin Patch\n*** Update File: agent-undo.txt\n@@\n-unsaved first\n+agent first\n*** End Patch');
	await expect.poll(() => readFile(path)).toEqual(Buffer.from('\uFEFFagent first\r\nsecond'));
	await editor.input.focus();
	await editor.input.press('ControlOrMeta+z');
	await editor.waitForEditorContents(text => text === 'unsaved first\nsecond');
	await editor.input.press('ControlOrMeta+s');
	await expect.poll(() => readFile(path)).toEqual(Buffer.from('\uFEFFunsaved first\r\nsecond'));
});

countdownTest('Real Agent countdown preserves focus, cancels, and accepts a subsequent turn', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ agent }) => {
	test.setTimeout(180_000);
	const { page, directory } = agent;
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	const editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
	await editor.waitForEditorFocus();
	await agent.send('Apply the first countdown edit.', '*** Begin Patch\n*** Update File: main.ts\n@@\n-const value = 1;\n+const value = 2;\n*** End Patch');
	const review = editor.element.locator('.ash-chat-editing-overlay');
	const cancel = review.getByRole('button', { name: 'Cancel automatic acceptance', exact: true });
	await expect(cancel).toBeVisible();
	await cancel.focus();
	await expect(review.locator('.ash-chat-editing-auto-accept')).toHaveText('Accepting in 2s');
	await expect(cancel).toBeFocused();
	await cancel.press('Enter');
	// Cross the actual configured deadline after cancellation. Keeping the real
	// clock running also exercises composer and document callbacks in the next Turn.
	await page.waitForTimeout(3100);
	await expect(review).toBeVisible();
	await expect(cancel).toHaveCount(0);
	await agent.send('Apply the next countdown edit.', '*** Begin Patch\n*** Update File: main.ts\n@@\n-const value = 2;\n+const value = 3;\n*** End Patch');
	await expect(cancel).toBeVisible();
	await expect(review).toBeHidden();
	await expect.poll(() => readFile(join(directory, 'main.ts'), 'utf8')).toBe('const value = 3;\n');
});

test('Agent file edits preserve user text and a failed review save remains retryable after reload', { tag: ['@browser-app-server', '@electron-app-server', '@darwin', '@linux'] }, async ({ application, webAppServer, target, testWorkspace, workbench }, testInfo) => {
	test.setTimeout(180_000);
	const { server, calls, requests } = modelFixture();
	const diagnostics: Record<string, unknown> = {};
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const source = workbench.page;
	// The seeding connection survives the product reload; the actual editing Turn
	// is sent by the product composer so Rust binds its document requests to that renderer.
	let control: Page | undefined;
	let sessionFile: string | undefined;
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		if (target.kind === 'browser') {
			control = await source.context().newPage();
			await control.goto(source.url(), { waitUntil: 'domcontentloaded' });
		}
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, control ?? source);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('The model fixture has no port'); }
		const provider = 'custom-k-review-fixture';
		const model = { provider, model: 'review-fixture' };
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'k-review-provider', expectedRevision: config.revision,
			config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated review fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { 'review-fixture': { contextWindow: 272_000 } } },
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		const enabled = source.getByRole('switch', { name: 'Enable review-fixture', exact: true });
		if (!await enabled.isChecked()) { await enabled.press('Space'); }
		await expect(enabled).toBeChecked();
		await source.locator('.ash-modal-editor-close').click();
		const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'k-review-default', expectedRevision: configured.revision, model });
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'k-review-session', title: 'K file review fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const root = created.session.threads[0];
		if (!root) { throw new Error('The session has no root Thread'); }
		const identity = { sessionId: created.session.sessionId, threadId: root.threadId };
		const before = await client.request(APP_SERVER_METHODS['session/thread/read'], identity);
		diagnostics.identity = identity;
		diagnostics.publicSessionCreated = created;
		diagnostics.publicThreadBeforeTurn = before;
		await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'k-review-ready', sessionId: identity.sessionId, request: { type: 'startTurn', threadId: identity.threadId, expectedSequence: before.thread.sequence, mode: 'agent', approvalMode: 'manual', model, input: [{ type: 'text', text: 'Return the review fixture ready message without using tools.' }] } });
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns.at(-1)?.status).toBe('completed');
		if (before.directory?.type !== 'local') { throw new Error('The review Session has no local directory'); }
		const file = join(before.directory.root, 'main.ts');
		sessionFile = file;
		expect(sessionFile).not.toBe(testWorkspace.file);
		let page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'K file review fixture' }).click();
		let sessions = new Workbench(page);
		await sessions.quickaccess.runCommand('workbench.sessions.auxiliaryBar.filesContainer');
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		let editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+End');
		await editor.waitForTypeInEditor('// unsaved user note');
		if (target.kind === 'electron' && 'windows' in application) {
			const window = await application.browserWindow(page);
			await window.evaluate(window => window.close());
			const save = page.getByRole('dialog', { name: 'Save Changes', exact: true });
			await expect(save).toContainText('Do you want to save the changes you made to main.ts?');
			await save.getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(save).toBeHidden();
			await editor.waitForEditorContents(text => text.includes('// unsaved user note'));
		}
		if (target.kind === 'browser') { diagnostics.dirtyEditorModel = await captureEditorModel(page).catch(error => ({ status: 'unavailable', reason: String(error) })); }
		expect(await readFile(file, 'utf8')).toBe('const value = 1;\n');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
		const composer = page.locator('.ash-sessions-chat-slot.active:visible [role=region][data-thread-id]');
		await expect(composer).toHaveAttribute('data-thread-id', identity.threadId);
		await composer.locator('.ash-chat-input-mode-action').click();
		await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true }).click();
		const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions');
		if (!bypass) { throw new Error('The profile has no bypass permission definition'); }
		await composer.getByRole('button', { name: /^Permissions:/ }).click();
		// Sessions owns a BrowserDialogHandler on both hosts. Assert and accept that real dialog.
		await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Confirm', exact: true });
		await expect(dialog).toBeVisible();
		const confirmation = { message: await dialog.locator('.ash-dialog-message').innerText() };
		await dialog.getByRole('button', { name: bypass.label.english, exact: true }).click();
		expect(confirmation.message).toBe('Skip most permission approvals?');
		await composer.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const upload = page.waitForEvent('filechooser');
		const attachments = page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox');
		await attachments.fill('Attach files');
		await attachments.press('Enter');
		await (await upload).setFiles({ name: 'review-input.txt', mimeType: 'text/plain', buffer: Buffer.from(attachmentMarker) });
		await expect(composer.locator('.ash-chat-code-reference').filter({ hasText: 'review-input.txt' })).toBeVisible();
		const input = composer.locator('.ash-chat-input-editor .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('Apply the isolated review edit.');
		await input.press('Enter');
		await expect.poll(async () => {
			const turns = (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.turns;
			return { count: turns.length, status: turns.at(-1)?.status };
		}, { timeout: 90_000 }).toEqual({ count: 2, status: 'completed' });
		const edited = (await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread;
		diagnostics.publicThreadAfterTurn = edited;
		await testInfo.attach('agent-file-identity-before-review', { body: JSON.stringify({ ...diagnostics, modelRequests: requests, traffic: calls }), contentType: 'application/json' });
		const pwdResult = edited.turns.at(-1)?.items.find(item => item.type === 'toolResult' && item.toolCallId === 'isolated-cwd');
		if (!pwdResult || pwdResult.type !== 'toolResult') { throw new Error('The editing Turn has no actual pwd Tool result'); }
		const pwd = JSON.parse(pwdResult.text) as { result: { exit_code: number; stdout: string; managed_scope: boolean; }; };
		expect(pwdResult.isError).toBe(false);
		expect(pwd.result).toMatchObject({ exit_code: 0, managed_scope: true });
		expect(pwd.result.stdout).toBe(before.directory.root + '\n');
		const editingRequests = requests.filter(request => request.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Apply the isolated review edit.')));
		const modelCwds = editingRequests.map(request => request.messages?.flatMap(message => {
			const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
			return [...content.matchAll(/<cwd>([^<]+)<\/cwd>/gu)].map(match => match[1]);
		}) ?? []);
		expect(editingRequests.length).toBeGreaterThan(0);
		// Compare the actual model environment and process output from this same
		// Turn; neither the source workspace nor a configured cwd can substitute.
		expect(modelCwds).toEqual(editingRequests.map(() => [pwd.result.stdout.slice(0, -1)]));
		expect(edited.turns.at(-1)?.items.filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: 'review-input.txt', content: attachmentMarker }]);
		expect(calls.some(call => call.patch && call.attachment)).toBe(true);
		await expect(composer.getByText('Isolated edit complete.', { exact: true })).toBeVisible();
		await expect(composer.locator('.ash-chat-code-reference')).toHaveCount(0);
		await expect.poll(() => readFile(file, 'utf8')).toBe('const value = 42;\n// unsaved user note');
		await expect(editor.element.locator('.ash-chat-editing-overlay')).toBeVisible();
		await chmod(file, 0o444);
		await editor.element.locator('.ash-chat-editing-overlay').getByRole('button', { name: 'Reject file changes', exact: true }).click();
		const pending = editor.element.locator('.ash-chat-editing-overlay').getByRole('button', { name: 'Retry saving reviewed changes', exact: true });
		await expect(pending).toBeEnabled();
		const failure = page.locator('.ash-notification-message:visible').filter({ hasText: 'Could not review changes:' });
		await expect(failure).toHaveCount(1);
		await expect(failure).toContainText(/read.only/i);
		expect(await readFile(file, 'utf8')).toBe('const value = 42;\n// unsaved user note');
		page = await workbench.reopenAgentsWindow(application, page);
		sessions = new Workbench(page);
		editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
		const reopened = page;
		const retry = editor.element.locator('.ash-chat-editing-overlay').getByRole('button', { name: 'Retry saving reviewed changes', exact: true });
		await expect(retry).toBeVisible();
		await editor.waitForEditorContents(text => text.includes('const value = 1;') && text.includes('// unsaved user note'));
		await chmod(file, 0o644);
		await retry.focus();
		await retry.press('Enter');
		await expect.poll(() => readFile(file, 'utf8')).toBe('const value = 1;\n// unsaved user note');
		await expect(editor.element.locator('.ash-chat-editing-overlay')).toBeHidden();
		// History cannot overwrite a dirty editor in the owning Session directory.
		const sourceRead = await client.request(APP_SERVER_METHODS['session/thread/read'], identity);
		await editor.input.press('ControlOrMeta+End');
		await editor.input.press('Enter');
		await editor.waitForTypeInEditor('// preserve this dirty source');
		await sessions.quickaccess.runCommand('workbench.action.chat.undoEdit');
		await expect(page.locator('.ash-notification-host').getByText('Save or revert unsaved files in this chat directory before changing its history.', { exact: true })).toBeVisible();
		expect((await client.request(APP_SERVER_METHODS['session/thread/read'], identity)).thread.sequence).toBe(sourceRead.thread.sequence);
		expect(await readFile(file, 'utf8')).toBe('const value = 1;\n// unsaved user note');
		const points = (await client.request(APP_SERVER_METHODS['session/thread/checkpoints'], identity)).checkpoints.filter(point => point.workspace.type !== 'unavailable');
		const finalTurn = sourceRead.thread.turns.at(-1);
		const selected = points.reduce((selected, point, index) => point.turnId === finalTurn?.turnId ? index : selected, -1);
		if (selected < 0) { throw new Error('The real editing Turn has no restorable checkpoint'); }
		await sessions.quickaccess.runCommand('workbench.action.chat.restoreCheckpoint');
		await page.getByRole('option').filter({ has: page.getByText(`After checkpoint ${selected + 1}`, { exact: true }) }).click();
		const title = `Restored checkpoint: ${points[selected]!.itemId}`;
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/read'], { sessionId: identity.sessionId })).session.threads.some(thread => thread.title === title)).toBe(true);
		const restoredSession = (await client.request(APP_SERVER_METHODS['session/read'], { sessionId: identity.sessionId })).session;
		const restoredThread = restoredSession.threads.find(thread => thread.title === title)!;
		expect(restoredThread.threadId).not.toBe(identity.threadId);
		await expect(page.locator('.ash-sessions-chat-slot.active:visible [role=region][data-thread-id]')).toHaveAttribute('data-thread-id', restoredThread.threadId);
		const restoredRead = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId: identity.sessionId, threadId: restoredThread.threadId });
		if (restoredRead.directory?.type !== 'local') { throw new Error('The restored checkpoint has no local directory'); }
		expect(restoredRead.directory.root).not.toBe(before.directory.root);
		expect(await readFile(join(restoredRead.directory.root, 'main.ts'), 'utf8')).toBe('const value = 42;\n// unsaved user note');
		expect(await readFile(file, 'utf8')).toBe('const value = 1;\n// unsaved user note');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
		expect(calls.filter(call => call.patch)).toHaveLength(1);
		await testInfo.attach('real-agent-file-review', { body: JSON.stringify({ identity, traffic: calls, text: await readFile(file, 'utf8') }), contentType: 'application/json' });
		const screenshot = testInfo.outputPath('agent-review-saved.png');
		await reopened.screenshot({ path: screenshot });
		await testInfo.attach('agent-review-saved', { path: screenshot, contentType: 'image/png' });
	} finally {
		await testInfo.attach('agent-file-identity-diagnostics', { body: JSON.stringify({ ...diagnostics, modelRequests: requests, traffic: calls }), contentType: 'application/json' });
		if (sessionFile) { await chmod(sessionFile, 0o644); }
		await connection?.close();
		await control?.close();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
