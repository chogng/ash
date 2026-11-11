import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import { threadIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import { appServerRequest } from '../../../../src/ash/platform/agentHost/browser/appServerRequest.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { ElectronApplication, Page } from '@playwright/test';
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
						commandId: title, kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory },
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
		const source = (await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'provider-canvas', kind: 'code', title: 'Provider Canvas session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
		const peer = (await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'provider-peer', kind: 'code', title: 'Provider peer session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
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
		await workbench.quickaccess.runCommand('workbench.action.chat.newChat');
		const newChatMenu = () => page.locator('.ash-chat-title-actions [data-action-id="submenu.ChatNewMenu"] .ash-split-action-dropdown button').click();
		const menus = new Menus(page);
		expect((await menus.inspect(application, newChatMenu)).map(item => item.label)).not.toContain('Canvas');
		await expect(page.locator('.ash-chat-title-actions [data-action-id="workbench.action.chat.openCanvas"], .ash-chat-secondary-toolbar [data-action-id="workbench.action.chat.openCanvas"]')).toHaveCount(0);
		if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) { await workbench.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar'); }
		await page.locator('.ash-agent-session-row').filter({ hasText: source.title }).click();
		await expect(page.locator(`[data-thread-id="${source.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		await expect.poll(async () => (await menus.inspect(application, newChatMenu)).some(item => item.label === 'Canvas')).toBe(true);
		const dropdown = page.locator('.ash-chat-title-actions [data-action-id="submenu.ChatNewMenu"] .ash-split-action-dropdown button');
		await dropdown.focus();
		expect((await menus.inspect(application, () => dropdown.press('Enter'))).find(item => item.label === 'Canvas')).toMatchObject({ enabled: true });
		await testInfo.attach('canvas-new-chat-menu', { body: await page.screenshot(), contentType: 'image/png' });
		await expect(dropdown).toBeFocused();
		await installMainChannelTestClient(page);
		const views = () => page.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const chat = page.locator(`[data-thread-id="${source.threads[0]!.threadId}"]:visible`).first();
		const message = chat.getByRole('textbox', { name: 'Chat message', exact: true });
		await message.focus(); await page.keyboard.insertText('Keep my draft while opening Canvas');
		await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await workbench.quickaccess.select('Canvas…');
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
		await menus.select(application, newChatMenu, ['Canvas', 'Fixture board']);
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
		await agentCommands.runCommand('workbench.action.chat.openCanvas');
		await agentCommands.select(agentNative.canvas!.title);
		expect((await agentViews()).filter(view => view.canvas?.canvasId === 'board').map(view => view.id)).toEqual([agentNative.id]);
		expect(agentNative.host.windowId).not.toBe(native.host.windowId);
		await agentCommands.runCommand('workbench.action.agentSessions.addCanvasToSidebar');
		const pin = agents.locator('[data-action-id^="sessions.pinnedCanvas."]').filter({ hasText: agentNative.canvas!.title }).first();
		await expect(pin).toBeVisible();
		await pin.click();
		const fullPage = agents.locator('[data-custom-view-id="sessions.customView.canvas"]');
		await expect(fullPage).toBeVisible();
		await expect(fullPage.locator('h1')).toHaveText(agentNative.canvas!.title);
		await expect.poll(async () => (await agentViews()).find(view => view.id === agentNative.id)?.state.visible).toBe(true);
		const fullBounds = await fullPage.locator('.ash-session-canvas-page').boundingBox();
		expect(fullBounds!.height).toBeGreaterThan(300);
		await expectPinnedCanvasBounds(application as ElectronApplication, agents, agentNative);
		await testInfo.attach('pinned-canvas-full-page', { body: await agents.screenshot(), contentType: 'image/png' });
		await fullPage.getByRole('button', { name: 'Go to Chat', exact: true }).click();
		await expect(fullPage).toHaveCount(0);
		await agents.locator('.ash-sessions-list-item').filter({ hasText: peer.title }).first().click();
		await expect(agents.locator(`[data-thread-id="${peer.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		await pin.click();
		await expect(fullPage).toBeVisible();
		await expect.poll(async () => (await agentViews()).find(view => view.id === agentNative.id)?.state.visible).toBe(true);
		await fullPage.getByRole('button', { name: 'Remove from Sidebar', exact: true }).click();
		await expect(fullPage).toHaveCount(0);
		await expect(pin).toHaveCount(0);
		await expect(agents.locator(`[data-thread-id="${peer.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		expect((await agentViews()).some(view => view.id === agentNative.id)).toBe(true);
		await agents.locator('.ash-sessions-list-item').filter({ hasText: source.title }).first().click();
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
		await page.bringToFront();
		await page.getByRole('searchbox', { name: 'Search extensions', exact: true }).fill('Canvas provider smoke');
		await page.locator('[data-package-id="acme/canvas-smoke"]').click();
		await expect(details).toBeVisible();
		await details.getByRole('switch').focus(); await details.getByRole('switch').press('Space');
		await expect(details.getByRole('switch')).not.toBeChecked();
		await expect.poll(async () => (await views()).some(view => view.id === native.id)).toBe(false);
		await expect.poll(async () => (await agentViews()).some(view => view.id === agentNative.id)).toBe(false);
		await expect.poll(async () => (await menus.inspect(application, newChatMenu)).some(item => item.label === 'Canvas')).toBe(false);
		await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await expect(page.getByRole('option', { name: 'Canvas…', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
	} finally {
		await connection.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
	}
});

test('Agents Canvas skips the pinned page and restores the editor working set', { tag: '@electron-app-server' }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	await using origin = createServer((_request, response) => { response.end('<title>Canvas working set fixture</title>'); });
	await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
	const address = origin.address();
	if (!address || typeof address === 'string') { throw new Error('Missing Canvas fixture origin'); }

	const fileName = 'canvas-working-set.txt';
	const fileText = 'Canvas working set fixture';
	await writeFile(join(testWorkspace.directory, fileName), fileText);
	const root = join(testWorkspace.directory, 'canvas-working-set-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin/plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/canvas-working-set', version: '1.0.0', displayName: 'Canvas working set fixture',
		compatibility: { ash: '>=0.1.0' }, permissions: [],
		contributions: {
			editorExtensions: [{
				id: 'canvas', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['dataChannel'],
			}]
		},
	}));
	await writeEditorExtensionFixture(root, `
const { window } = require('@ash/sdk');
exports.activate = context => {
 const provider = { openCanvas: () => ({ url: 'http://127.0.0.1:${address.port}' }) };
 context.subscriptions.push(window.registerCanvasProvider('board', provider), window.registerCanvasProvider('alternate', provider));
};`);
	const packagePath = join(root, 'package.json');
	const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
	manifest.activationEvents = ['onDemand:dataChannel'];
	manifest.contributes.canvases = [
		{ id: 'board', displayName: 'Fixture board', description: 'Canvas working set fixture' },
		{ id: 'alternate', displayName: 'Alternate Canvas', description: 'Available while the board is pinned' },
	];
	await writeFile(packagePath, JSON.stringify(manifest));

	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
	try {
		const createSession = async (title: string) => {
			const request = {
				commandId: title, kind: 'code' as const, title, agent: { type: 'default' as const },
				executionTarget: { type: 'local' as const, root: testWorkspace.directory },
			};
			return (await connection.client.request(APP_SERVER_METHODS['session/create'], request)).session;
		};
		const source = await createSession('Canvas working set A');
		const peer = await createSession('Canvas working set B');
		await workbench.quickaccess.runCommand('ash.extensions.installLocal');
		const install = workbench.page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await install.getByRole('textbox').fill('canvas-working-set-extension');
		await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('textbox').press('Enter'));
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		await workbench.page.locator('[data-package-id="acme/canvas-working-set"]').click();
		const details = workbench.page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/canvas-working-set' });
		await workbench.dialogs.confirm(application, 'Canvas working set fixture', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
		await expect(details).toHaveAttribute('aria-busy', 'false');
		const toggle = details.getByRole('switch');
		if (!await toggle.isChecked()) { await toggle.press('Space'); }
		await expect(toggle).toBeChecked();

		const agents = await workbench.openAgentsWindow('electron');
		const commands = new QuickAccess(agents);
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const select = async (session: typeof source) => {
			await agents.locator('.ash-sessions-list-item').filter({ hasText: session.title }).first().click();
			await expect(agents.locator(`[data-thread-id="${session.threads[0]!.threadId}"]:visible`).first()).toBeVisible();
		};
		await select(source);
		const activity = agents.getByRole('button', { name: 'Canvas', exact: true });
		await activity.click();
		await commands.select('Fixture board');
		const canvas = agents.locator('[data-part="editor"] .ash-session-canvas:visible');
		await expect(canvas).toBeVisible();
		await expect(agents.locator('[data-part="sessions"] .ash-sessions-chat-slot.active')).toBeVisible();
		await installMainChannelTestClient(agents);
		const views = () => agents.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const native = (await views()).find(view => view.canvas?.canvasId === 'board')!;
		const canvasTab = agents.getByRole('tab', { name: native.canvas!.title, exact: true });

		await test.step('Restore the same Canvas and file after switching A → B → A', async () => {
			const fileTab = agents.getByRole('tab', { name: fileName, exact: true });
			await commands.open(join(testWorkspace.directory, fileName));
			await commands.select(fileName);
			await expect(fileTab).toBeVisible();
			await canvasTab.click();
			await select(peer);
			await expect(canvasTab).toHaveCount(0);
			await expect(fileTab).toHaveCount(0);
			await select(source);
			await expect(canvasTab).toHaveAttribute('aria-selected', 'true');
			await expect(fileTab).toBeVisible();
			await expect.poll(async () => (await views()).filter(view => view.canvas?.canvasId === 'board' && view.state.visible).map(view => view.id)).toEqual([native.id]);
			await fileTab.click();
			await expect(agents.getByRole('tabpanel', { name: fileName, exact: true })).toContainText(fileText);
			await canvasTab.click();
			await testInfo.attach('canvas-working-set-restored', { body: await agents.screenshot(), contentType: 'image/png' });
		});

		await test.step('Skip the pinned Canvas in the Activity Bar and Quick Pick', async () => {
			await commands.runCommand('workbench.action.agentSessions.addCanvasToSidebar');
			const pin = agents.locator('[data-action-id^="sessions.pinnedCanvas."]').filter({ hasText: native.canvas!.title });
			await pin.click();
			const pinnedPage = agents.locator('[data-custom-view-id="sessions.customView.canvas"]');
			await expect(pinnedPage).toBeVisible();
			await expect.poll(async () => (await views()).find(view => view.id === native.id)?.state.visible).toBe(true);
			await expectPinnedCanvasBounds(application as ElectronApplication, agents, native);
			// The sole live Canvas would take the direct-open path if it were still eligible.
			await activity.click();
			await expect(commands.input).toHaveAccessibleName('Open a Canvas from a visible conversation');
			await expect(commands.items).toHaveCount(1);
			await expect(commands.items).toContainText('Alternate Canvas');
			await expect(pinnedPage).toBeVisible();
			await testInfo.attach('pinned-canvas-picker', { body: await agents.screenshot(), contentType: 'image/png' });
			await commands.close();
			await expect.poll(async () => (await views()).filter(view => view.canvas?.canvasId === 'board' && view.state.visible).map(view => view.id)).toEqual([native.id]);
		});
	} finally {
		await connection.close();
		origin.closeAllConnections();
	}
});

test('Agent Canvas provider URL changes retain the old page until the user opens the new source', { tag: '@electron-app-server' }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(120_000);
	const origin = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Provider page</title><button>Provider button</button>'); });
	await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
	const address = origin.address();
	if (!address || typeof address === 'string') { throw new Error('Missing Canvas fixture origin'); }
	const url = `http://127.0.0.1:${address.port}`;
	const root = join(testWorkspace.directory, 'canvas-refresh-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin/plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/canvas-refresh', version: '1.0.0', displayName: 'Canvas refresh fixture', compatibility: { ash: '>=0.1.0' }, permissions: [], contributions: { editorExtensions: [{ id: 'canvas', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['command', 'dataChannel'] }] } }));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk');
exports.activate = context => {
 const changes = new ash.EventEmitter(); let moved = false;
 const resolve = () => ({ url: ${JSON.stringify(url)} + (moved ? '/updated' : '/original'), title: moved ? 'Updated board' : 'Fixture board' });
 context.subscriptions.push(changes, ash.window.registerCanvasProvider('board', { openCanvas: resolve, resolveCanvas: resolve, onDidChangeCanvases: changes.event }),
 ash.commands.register('acme.canvas.move', () => { moved = true; changes.fire(); }));
};`);
	const packagePath = join(root, 'package.json');
	const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
	manifest.activationEvents = ['onDemand:dataChannel'];
	manifest.contributes.canvases = [{ id: 'board', displayName: 'Fixture board', description: 'Canvas refresh fixture' }];
	await writeFile(packagePath, JSON.stringify(manifest));
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
	try {
		const source = (await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'canvas-refresh', kind: 'code', title: 'Canvas refresh session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
		const page = workbench.page;
		await workbench.quickaccess.runCommand('ash.extensions.installLocal');
		const install = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await install.getByRole('textbox').fill('canvas-refresh-extension');
		await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('textbox').press('Enter'));
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		await page.locator('[data-package-id="acme/canvas-refresh"]').click();
		const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/canvas-refresh' });
		await workbench.dialogs.confirm(application, 'Canvas refresh fixture', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
		await expect(details).toHaveAttribute('aria-busy', 'false');
		if (!await details.getByRole('switch').isChecked()) { await details.getByRole('switch').focus(); await details.getByRole('switch').press('Space'); }
		await expect(details.getByRole('switch')).toBeChecked();
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) { await workbench.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar'); }
		await page.locator('.ash-agent-session-row').filter({ hasText: source.title }).click();
		const threadId = source.threads[0]!.threadId;
		await expect(page.locator(`[data-thread-id="${threadId}"]:visible`).first()).toBeVisible();
		const menus = new Menus(page);
		const openMenu = () => page.locator('.ash-chat-title-actions [data-action-id="submenu.ChatNewMenu"] .ash-split-action-dropdown button').click();
		await expect.poll(async () => (await menus.inspect(application, openMenu)).some(item => item.label === 'Canvas')).toBe(true);
		await menus.select(application, openMenu, ['Canvas', 'Fixture board']);
		await expect(page.getByRole('tab', { name: 'Fixture board', exact: true })).toHaveCount(1);
		await installMainChannelTestClient(page);
		const views = () => page.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const selected = (await views()).find(view => view.canvas?.canvasId === 'board')!;
		await page.evaluate(id => globalThis.ashTestMainProcess.call('browserView', 'destroyBrowserView', [id]), selected.id);
		await installBrowserNetworkPolicy(application as ElectronApplication, url);
		const agentPage = await page.evaluate(({ sessionId, threadId, url, canvas, token }) => globalThis.ashTestMainProcess.call<{ targetId: string; }>('browserHost', 'create', {
			id: crypto.randomUUID(), params: { threadId, url, networkToken: token, canvas: { sessionId, instanceId: canvas.instanceId, title: 'Agent board', definition: { extensionId: canvas.extensionId!, canvasId: canvas.canvasId! } } },
		}), { sessionId: source.sessionId, threadId, url: url + '/original', canvas: selected.canvas!, token: browserNetworkToken });
		await expect(page.getByRole('tab', { name: 'Agent board', exact: true })).toHaveCount(1);
		await workbench.quickaccess.runCommand('acme.canvas.move');
		await expect(page.getByRole('article').getByText('Canvas Fixture board has a new address. Open it again from the Canvas menu to load the updated page.', { exact: true })).toBeVisible();
		const retained = (await views()).find(view => view.id === agentPage.targetId)!;
		expect(retained.owner.type).toBe('agent');
		expect(retained.state.url).toBe(url + '/original');
		await expect(page.getByRole('tab', { name: 'Agent board', exact: true })).toHaveCount(1);
		await testInfo.attach('canvas-source-change-retained', { body: await page.screenshot(), contentType: 'image/png' });
		await menus.select(application, openMenu, ['Canvas', 'Fixture board']);
		await expect(page.getByRole('tab', { name: 'Updated board', exact: true })).toHaveCount(1);
		const reopened = (await views()).find(view => view.canvas?.canvasId === 'board')!;
		expect(reopened.owner.type).toBe('user');
		expect(reopened.state.url).toBe(url + '/updated');
		expect((await views()).some(view => view.id === agentPage.targetId)).toBe(false);
		await testInfo.attach('canvas-source-change-reopened', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		await connection.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
	}
});


test('a secondary SSH host presents and pins its own registered Canvas and reconnects the same native identity', { tag: ['@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(180_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const ssh = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'), process.env.ASH_TEST_SSH_ADDRESS);
	const origin = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Remote Canvas</title><button>Remote provider button</button>'); });
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let seed: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
		const port = (origin.address() as import('node:net').AddressInfo).port;
		const localRoot = join(ssh.root, 'local-workspace'), remoteRoot = join(ssh.root, 'remote-workspace');
		await Promise.all([mkdir(localRoot), mkdir(remoteRoot)]);
		const extension = join(remoteRoot, 'remote-canvas');
		await mkdir(join(extension, '.ash-plugin'), { recursive: true });
		await writeFile(join(extension, '.ash-plugin/plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/remote-canvas', version: '1.0.0', displayName: 'Remote Canvas fixture', compatibility: { ash: '>=0.1.0' }, permissions: [], contributions: { editorExtensions: [{ id: 'canvas', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['dataChannel'] }] } }));
		await writeEditorExtensionFixture(extension, `const { window } = require('@ash/sdk'); exports.activate = context => { context.subscriptions.push(window.registerCanvasProvider('board', { openCanvas: source => ({ url: 'http://127.0.0.1:${port}/?thread=' + encodeURIComponent(source.threadId), title: 'Remote board' }), resolveCanvas: source => ({ url: 'http://127.0.0.1:${port}/?thread=' + encodeURIComponent(source.threadId), title: 'Remote board' }), closeCanvas() {} })); };`);
		const manifest = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
		manifest.activationEvents = ['onDemand:dataChannel'];
		manifest.contributes.canvases = [{ id: 'board', displayName: 'Remote board', description: 'SSH Canvas fixture' }];
		await writeFile(join(extension, 'package.json'), JSON.stringify(manifest));
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(ssh.root, 'desktop'), workspaceDirectory: localRoot, workspacePermissions: 'development',
			environment: { ...process.env, ASH_SSH_PATH: ssh.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') }
		});
		const ide = desktop.driver.workbench;
		seed = await connectProfile(desktop.application, undefined, remoteRoot, ide.page, { profileRoot: join(ssh.root, 'remote-profile'), directoryGrantsHost: true });
		const grants = await appServerRequest(seed.client, 'config/directoryGrants/list', {});
		await appServerRequest(seed.client, 'config/directoryGrants/set', { commandId: 'canvas-remote-grant', expectedRevision: grants.revision, path: remoteRoot, permissions: ['readFiles', 'writeFiles', 'executeCommands', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'mutateRepository', 'discoverPlugins'] });
		const plugins = await appServerRequest(seed.client, 'plugin/list', {});
		const installed = await appServerRequest(seed.client, 'plugin/installLocal', { commandId: 'canvas-remote-install', expectedRevision: plugins.revision, path: 'remote-canvas', dirId: null });
		const enabled = await appServerRequest(seed.client, 'plugin/enable', { commandId: 'canvas-remote-enable', expectedRevision: installed.command.revision, id: installed.id, version: installed.version, digest: installed.digest });
		await appServerRequest(seed.client, 'plugin/grant', { commandId: 'canvas-remote-authorize', expectedRevision: enabled.revision, id: installed.id, version: installed.version, digest: installed.digest });
		const source = (await appServerRequest(seed.client, 'session/create', { commandId: 'canvas-remote-session', kind: 'code', title: 'SSH Canvas conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root: remoteRoot } })).session;
		await ide.page.evaluate(connection => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:save', { connection }), { name: 'canvas-ssh-host', host: ssh.host, workspace: remoteRoot });
		const agents = await ide.openAgentsWindow('electron');
		const commands = new QuickAccess(agents);
		const codeMode = agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
		if (!await codeMode.isVisible()) { await agents.locator('[data-part="titlebar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click(); }
		await codeMode.click();
		const connectHost = async () => {
			await commands.runCommand('sessions.action.manageAgentHosts');
			await commands.select('Connect a Saved SSH Host…');
			await commands.select('canvas-ssh-host');
		};
		await connectHost();
		await agents.locator('.ash-sessions-list-item').filter({ hasText: source.title }).first().click();
		const remoteThread = threadIdentity(`ssh-agent-host:${JSON.stringify([ssh.host, remoteRoot])}`, source.threads[0]!.threadId, 'local-agent-host');
		await expect(agents.locator(`[data-thread-id=${JSON.stringify(remoteThread)}]:visible`).first()).toBeVisible();
		await commands.runCommand('workbench.action.chat.openCanvas'); await commands.select('Remote board');
		await expect(agents.locator('.ash-session-canvas:visible')).toBeVisible();
		await installMainChannelTestClient(agents);
		const views = () => agents.evaluate(() => globalThis.ashTestMainProcess.call<IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		const native = (await views()).find(view => view.canvas?.canvasId === 'board')!;
		expect(native.canvas!.providerId).toContain('ssh-agent-host:');
		expect(native.canvas!.sessionId).not.toBe(source.sessionId);
		expect(native.state.url).toContain(encodeURIComponent(source.threads[0]!.threadId));
		expect('network' in native.session && native.session.network?.authority).toContain(ssh.host);
		await expect.poll(async () => (await views()).find(view => view.id === native.id)?.state.visible).toBe(true);
		await commands.runCommand('workbench.action.agentSessions.addCanvasToSidebar');
		const pin = agents.locator('[data-action-id^="sessions.pinnedCanvas."]').filter({ hasText: 'Remote board' }).first();
		await pin.click();
		const fullPage = agents.locator('[data-custom-view-id="sessions.customView.canvas"]');
		await expect(fullPage).toBeVisible();
		await fullPage.locator('.ash-session-canvas-page').focus(); await agents.keyboard.press('Alt+F2');
		await expect(agents.getByRole('dialog').getByRole('textbox')).toHaveValue(/Remote provider button/);
		await agents.keyboard.press('Escape');
		await commands.runCommand('sessions.action.manageAgentHosts'); await commands.select('canvas-ssh-host');
		await expect(fullPage.getByRole('status').filter({ hasText: /reconnect/ })).toBeVisible();
		await expect(pin).toBeVisible();
		await fullPage.getByRole('button', { name: 'Reconnect Canvas', exact: true }).click();
		await commands.select('Connect a Saved SSH Host…'); await commands.select('canvas-ssh-host');
		await expect.poll(async () => (await views()).find(view => view.id === native.id)?.state.visible, { timeout: 30_000 }).toBe(true);
		expect((await views()).filter(view => view.canvas?.canvasId === 'board').map(view => view.id)).toEqual([native.id]);
		await expectPinnedCanvasBounds(desktop.application, agents, native);
		await testInfo.attach('remote-pinned-canvas', { body: await agents.screenshot(), contentType: 'image/png' });
		await fullPage.getByRole('button', { name: 'Close Canvas', exact: true }).click();
		await expect.poll(async () => (await views()).some(view => view.id === native.id)).toBe(false);
		await expect(pin).toHaveCount(0);
	} catch (error) {
		if (desktop) {
			const diagnostics = testInfo.outputPath('remote-canvas-diagnostics.json');
			await writeFile(diagnostics, JSON.stringify({ pageErrors: desktop.diagnostics.pageErrors, consoleErrors: desktop.diagnostics.consoleErrors, pages: await Promise.all(desktop.application.context().pages().map(async page => ({ url: page.url(), text: await page.locator('body').innerText().catch(() => '') }))) }, null, 2));
			await testInfo.attach('remote-canvas-diagnostics', { path: diagnostics, contentType: 'application/json' });
		}
		throw error;
	} finally {
		await seed?.close(); await desktop?.close();
		origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
		await ssh.close();
	}
});


async function expectPinnedCanvasBounds(application: ElectronApplication, page: Page, info: IBrowserViewInfo): Promise<void> {
	await expect.poll(async () => {
		const expected = await page.locator('[data-custom-view-id="sessions.customView.canvas"] .ash-session-canvas-page').boundingBox();
		const actual = await application.evaluate(({ BrowserWindow }, info) => {
			const view = BrowserWindow.fromId(info.host.windowId)?.contentView.children.find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === info.state.url);
			return view?.getBounds();
		}, info);
		return expected && actual ? Math.abs(expected.x - actual.x) + Math.abs(expected.y - actual.y) + Math.abs(expected.width - actual.width) + Math.abs(expected.height - actual.height) : Number.POSITIVE_INFINITY;
	}).toBeLessThan(4);
}
