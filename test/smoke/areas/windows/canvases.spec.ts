import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { browserNetworkToken, installBrowserNetworkPolicy } from '../../../automation/browserNetwork.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import type { IBrowserViewInfo } from '../../../../src/ash/platform/browserView/common/browserView.js';
import { Menus } from '../../../automation/menus.js';

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe('Conversation Canvases ' + locale, () => {
		test.use({ electronUserSettings: { 'workbench.locale': locale } });
		test('Canvases retain their native page across tab dismissal and isolate conversation switching in ' + locale,
			{ tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
				test.setTimeout(180_000);
				const electron = application as ElectronApplication;
				const origin = createServer((_request, response) => {
					response.setHeader('Content-Type', 'text/html');
					response.end('<title>Canvas fixture</title><button onclick="this.textContent=\'Clicked\'">Counter</button><p>Interactive Canvas fixture</p>');
				});
				await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
				const address = origin.address();
				if (!address || typeof address === 'string') { throw new Error('Missing Canvas fixture origin'); }
				const url = `http://127.0.0.1:${address.port}`;
				const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
				try {
					await installBrowserNetworkPolicy(electron, url);
					const create = async (title: string) => (await connection.client.request(APP_SERVER_METHODS['session/create'], {
						commandId: title, title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory },
					})).session;
					const source = await create('Canvas source fixture');
					const other = await create('Canvas other fixture');
					const threadId = source.threads[0]!.threadId;
					const windowIds = new Set<number>();
					for (const mode of ['ide', 'agents'] as const) {
						const page = mode === 'ide' ? workbench.page : await workbench.openAgentsWindow('electron');
						await installMainChannelTestClient(page);
						const commands = new QuickAccess(page);
						const select = async (title: string, expectedThread: string) => {
							if (mode === 'ide') {
								await commands.runCommand('workbench.action.chat.open');
								if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) { await commands.runCommand('agentSessions.toggleAgentSessionsSidebar'); }
								await page.locator('.ash-agent-session-row').filter({ hasText: title }).click();
							} else {
								await page.locator('.ash-sessions-list-item').filter({ hasText: title }).first().click();
							}
							await expect(page.locator(`[data-thread-id="${expectedThread}"]:visible`).first()).toBeVisible();
						};
						await select(source.title, threadId);
						const open = (title: string) => page.evaluate(async ({ sessionId, threadId, url, title, token }) => {
							return globalThis.ashTestMainProcess.call<{ targetId: string; }>('browserHost', 'create', {
								id: crypto.randomUUID(), params: { threadId, url, networkToken: token, canvas: { sessionId, instanceId: 'preview', title } },
							});
						}, { sessionId: source.sessionId, threadId, url: url + '/' + mode, title, token: browserNetworkToken });
						const views = () => page.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
						const first = await open('Interactive preview');
						const canvas = page.locator('.ash-session-canvas:visible');
						await expect(canvas).toBeVisible();
						await expect(page.locator('.ash-browser-editor')).toHaveCount(0);
						await expect.poll(async () => (await views()).find(view => view.id === first.targetId)?.state.visible).toBe(true);
						windowIds.add((await views()).find(view => view.id === first.targetId)!.host.windowId);
						const bounds = await canvas.locator('.ash-session-canvas-page').boundingBox();
						const nativeBounds = await electron.evaluate(({ BrowserWindow }, url) => {
							const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url);
							if (!view) { throw new Error('Missing native Canvas'); }
							return view.getBounds();
						}, url + '/' + mode);
						expect(Math.abs(nativeBounds.x - bounds!.x) + Math.abs(nativeBounds.y - bounds!.y) + Math.abs(nativeBounds.width - bounds!.width) + Math.abs(nativeBounds.height - bounds!.height)).toBeLessThan(4);
						const native = await electron.evaluateHandle(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)!, url + '/' + mode);
						try {
							const button = await native.evaluate(contents => contents.executeJavaScript("(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()"));
							await native.evaluate((contents, position) => {
								contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
								contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
							}, button);
							expect(await native.evaluate(contents => contents.executeJavaScript("document.querySelector('button').textContent"))).toBe('Clicked');
							await commands.runCommand('workbench.action.closeActiveEditor');
							await expect(canvas).toHaveCount(0);
							expect((await views()).some(view => view.id === first.targetId)).toBe(true);
							await commands.runCommand('workbench.action.chat.reopenCanvas');
							await commands.select('Interactive preview');
							await expect(canvas).toBeVisible();
							expect(await native.evaluate(contents => contents.executeJavaScript("document.querySelector('button').textContent"))).toBe('Clicked');
							const updated = await open('Updated preview');
							expect(updated.targetId).toBe(first.targetId);
							await expect(page.getByRole('tab', { name: 'Updated preview', exact: true })).toHaveCount(1);
							await select(other.title, other.threads[0]!.threadId);
							await expect.poll(async () => (await views()).find(view => view.id === first.targetId)?.state.visible).toBe(false);
							await select(source.title, threadId);
							await expect(canvas).toBeVisible();
							await page.getByRole('tab', { name: 'Updated preview', exact: true }).click();
							await canvas.locator('.ash-session-canvas-page').focus();
							await page.keyboard.press('Alt+F1');
							const help = page.getByRole('dialog');
							await expect(help.getByRole('textbox')).toHaveValue(locale === 'en' ? /interactive page owned by its conversation/ : /所属会话的交互页面/);
							await help.press('Escape');
							await canvas.locator('.ash-session-canvas-page').focus();
							await page.keyboard.press('Alt+F2');
							const content = page.getByRole('dialog');
							await expect(content.getByRole('textbox')).toHaveValue(/Interactive Canvas fixture/);
							await content.press('Escape');
							await expect.poll(async () => (await views()).find(view => view.id === first.targetId)?.state.visible).toBe(true);
							await testInfo.attach(`canvas-${mode}-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
							const pixels = await native.evaluate(async contents => (await contents.capturePage()).toPNG().toString('base64'));
							await testInfo.attach(`canvas-page-${mode}-${locale}`, { body: Buffer.from(pixels, 'base64'), contentType: 'image/png' });
							await commands.runCommand('workbench.action.chat.closeCanvas');
							await expect.poll(async () => (await views()).some(view => view.id === first.targetId)).toBe(false);
							await expect(canvas).toHaveCount(0);
						} finally { await native.dispose(); }
					}
					expect(windowIds.size).toBe(2);
				} finally {
					await connection.close();
					origin.closeAllConnections();
					await new Promise<void>(resolve => origin.close(() => resolve()));
				}
			});
	});
}

test('registered Canvas providers open through the SDK, hydrate without revealing dismissed tabs, and retire with their extension', { tag: '@electron-app-server' }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const origin = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Provider page</title><button>Provider button</button>'); });
	await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
	const address = origin.address();
	if (!address || typeof address === 'string') { throw new Error('Missing Canvas fixture origin'); }
	const url = `http://127.0.0.1:${address.port}`;
	const root = join(testWorkspace.directory, 'canvas-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin/plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/canvas-smoke', version: '1.0.0', displayName: 'Canvas provider smoke', compatibility: { ash: '>=0.1.0' }, permissions: [], contributions: { editorExtensions: [{ id: 'canvas', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['command', 'dataChannel'] }] } }));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, window } = ash;
exports.activate = context => {
 const changes = new ash.EventEmitter(); let state = 'ready';
 const resolve = source => state === 'pending' ? undefined : state === 'removed' ? null : { url: ${JSON.stringify(url)} + '/?thread=' + encodeURIComponent(source.threadId), title: state === 'updated' ? 'Updated board' : 'Fixture board', status: 'Ready' };
 context.subscriptions.push(changes, window.registerCanvasProvider('board', {
  openCanvas: resolve, resolveCanvas: resolve, closeCanvas() { state = 'removed'; }, onDidChangeCanvases: changes.event
 }), window.registerCanvasProvider('input-required', { openCanvas() { throw new Error('Input-required Canvas was offered'); } }),
 commands.register('acme.canvas.pending', () => { state = 'pending'; changes.fire(); }),
 commands.register('acme.canvas.ready', () => { state = 'updated'; changes.fire(); }));
};`);
	const packagePath = join(root, 'package.json');
	const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
	manifest.activationEvents = ['onDemand:dataChannel'];
	manifest.contributes.canvases = [{ id: 'board', displayName: 'Fixture board', description: 'Registered Canvas fixture' }, { id: 'input-required', displayName: 'Needs input', requiresInput: true }];
	await writeFile(packagePath, JSON.stringify(manifest));
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
	try {
		const source = (await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'provider-canvas', title: 'Provider Canvas session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
		const peer = (await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'provider-peer', title: 'Provider peer session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
		const page = workbench.page;
		await workbench.quickaccess.runCommand('ash.extensions.installLocal');
		const install = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await install.getByRole('textbox').fill('canvas-extension');
		await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('textbox').press('Enter'));
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		await page.locator('[data-package-id="acme/canvas-smoke"]').click();
		const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/canvas-smoke' });
		await workbench.dialogs.confirm(application, 'Canvas provider smoke', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
		await expect(details).toHaveAttribute('aria-busy', 'false');
		if (!await details.getByRole('switch').isChecked()) { await details.getByRole('switch').focus(); await details.getByRole('switch').press('Space'); }
		await expect(details.getByRole('switch')).toBeChecked();
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) { await workbench.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar'); }
		await page.locator('.ash-agent-session-row').filter({ hasText: source.title }).click();
		await expect(page.locator(`[data-thread-id="${source.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		await installMainChannelTestClient(page);
		const views = () => page.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const chat = page.locator(`[data-thread-id="${source.threads[0]!.threadId}"]:visible`).first();
		const message = chat.getByRole('textbox', { name: 'Chat message', exact: true });
		await message.focus(); await page.keyboard.insertText('Keep my draft while opening Canvas');
		await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await workbench.quickaccess.select('Open Canvas…');
		await expect(page.getByRole('option', { name: /Needs input/ })).toHaveCount(0);
		await workbench.quickaccess.select('Fixture board');
		const canvas = page.locator('.ash-session-canvas:visible');
		await expect(canvas).toBeVisible();
		await expect.poll(async () => (await chat.locator('.ash-chat-input-editor .stanza-editor-line-text').allTextContents()).join(' ').replace(/\s+/g, ' ').trim()).toBe('Keep my draft while opening Canvas');
		await expect(chat.getByRole('button', { name: /^Remove /u })).toHaveCount(0);
		await expect(page.getByRole('tab', { name: 'Fixture board', exact: true })).toHaveCount(1);
		const native = (await views()).find(view => view.canvas?.canvasId === 'board')!;
		expect(native.canvas?.sessionId).toBe(source.sessionId);
		expect(native.canvas?.threadId).toBe(source.threads[0]!.threadId);
		expect(native.state.url).toContain(encodeURIComponent(source.threads[0]!.threadId));
		await canvas.locator('.ash-session-canvas-page').focus();
		await page.keyboard.press('Alt+F2');
		await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(/Provider button/);
		await page.keyboard.press('Escape');
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(canvas).toHaveCount(0);
		await workbench.quickaccess.runCommand('acme.canvas.pending');
		await workbench.quickaccess.runCommand('acme.canvas.ready');
		await expect(canvas).toHaveCount(0);
		await workbench.quickaccess.runCommand('workbench.action.chat.openCanvas');
		await workbench.quickaccess.select('Updated board');
		await expect(canvas).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Updated board', exact: true })).toHaveCount(1);
		await expect(page.locator('.ash-browser-editor')).toHaveCount(0);
		await testInfo.attach('registered-canvas', { body: await page.screenshot(), contentType: 'image/png' });
		const agents = await workbench.openAgentsWindow('electron');
		await agents.locator('.ash-sessions-list-item').filter({ hasText: source.title }).first().click();
		await expect(agents.locator(`[data-thread-id="${source.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		const agentCommands = new QuickAccess(agents);
		await agents.getByRole('button', { name: 'Canvas', exact: true }).click();
		await agentCommands.select('Fixture board');
		await expect(agents.locator('.ash-session-canvas:visible')).toBeVisible();
		await installMainChannelTestClient(agents);
		const agentViews = () => agents.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const agentNative = (await agentViews()).find(view => view.canvas?.canvasId === 'board')!;
		await new Menus(agents).select(application, () => agents.locator('[data-part="editor"] .ash-editor-title-control:visible').getByRole('button', { name: 'Add tab', exact: true }).click(), ['Canvas', 'Fixture board']);
		expect((await agentViews()).filter(view => view.canvas?.canvasId === 'board').map(view => view.id)).toEqual([agentNative.id]);
		expect(agentNative.host.windowId).not.toBe(native.host.windowId);
		await agentCommands.runCommand('acme.canvas.pending');
		await expect(agents.locator('.ash-session-canvas-message:visible')).toContainText('reconnecting');
		await agents.locator('.ash-sessions-list-item').filter({ hasText: peer.title }).first().click();
		await expect(agents.locator(`[data-thread-id="${peer.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		await agents.locator('.ash-sessions-list-item').filter({ hasText: source.title }).first().click();
		await expect(agents.locator('.ash-session-canvas-message:visible')).toContainText('reconnecting');
		await agentCommands.runCommand('acme.canvas.ready');
		await expect(agents.locator('.ash-session-canvas-page:visible')).toBeVisible();
		await expect.poll(async () => (await agentViews()).find(view => view.id === agentNative.id)?.state.visible).toBe(true);
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		await page.locator('[data-package-id="acme/canvas-smoke"]').dblclick();
		await details.getByRole('switch').focus(); await details.getByRole('switch').press('Space');
		await expect(details.getByRole('switch')).not.toBeChecked();
		await expect.poll(async () => (await views()).some(view => view.id === native.id)).toBe(false);
		await expect.poll(async () => (await agentViews()).some(view => view.id === agentNative.id)).toBe(false);
	} finally {
		await connection.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
	}
});
