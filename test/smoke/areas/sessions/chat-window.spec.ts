import { expect, test } from '../../../automation/test.js';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { QuickAccess } from '../../../automation/quickaccess.js';

test.use({ electronWindowMode: 'active', electronUserSettings: { 'workbench.locale': 'en' } });

const edgeSelector = (edge: string) => `[data-chat-window-edge="${edge}"]`;

async function bounds(locator: Locator) {
	await expect(locator).toBeVisible();
	return (await locator.boundingBox())!;
}

async function dragTabToEdge(page: Page, tab: Locator, edge: 'left' | 'right' | 'top' | 'bottom') {
	const grid = page.locator('.ash-chat-window-grid');
	const { x, y, width, height } = await bounds(grid);
	const point = {
		left: { x: 5, y: height / 2 },
		right: { x: width - 5, y: height / 2 },
		top: { x: width / 2, y: 5 },
		bottom: { x: width / 2, y: height - 5 },
	}[edge];
	const source = await bounds(tab);
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
	await page.mouse.down();
	try {
		await page.mouse.move(x + point.x, y + point.y, { steps: 16 });
		await page.mouse.move(x + point.x, y + point.y);
		await expect(grid.locator(`.ash-chat-window-edge-drop[data-edge="${edge}"]`)).toBeVisible();
	} finally {
		await page.mouse.up();
	}
}

async function setTerminalPosition(page: Page, label: string) {
	const button = page.getByRole('button', { name: 'Terminal Position', exact: true });
	await button.press('Enter');
	const option = page.getByRole('menuitemradio', { name: label, exact: true }).or(page.getByRole('menuitemcheckbox', { name: label, exact: true }));
	await expect(option).toBeVisible();
	await option.press('Enter');
}

test('restores chat window edge editors, input-only layout, and terminal position after restarting Ash', { tag: ['@electron-app-server'] }, async ({ application, workbench, target, testWorkspace, restartWorkbench }, testInfo) => {
	if (target.kind !== 'electron' || !('windows' in application)) return;
	test.setTimeout(100_000);
	const agents = await workbench.openAgentsWindow('electron');
	await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await agents.locator('[data-action-id="sessions.newSession"] button').click();
	const slot = agents.locator('.ash-sessions-chat-slot.active:visible');
	const input = slot.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.focus();
	await agents.keyboard.insertText('First restored draft');
	await agents.locator('.ash-sessions-list:visible [data-item^="untitled:"] .ash-sessions-list-item').click({ button: 'right' });
	const [popup] = await Promise.all([
		application.waitForEvent('window'),
		agents.getByRole('menuitem', { name: 'Open in new window', exact: true }).click(),
	]);
	const chats = '.ash-chat-window-editor:visible';
	await expect(popup.locator(chats)).toContainText('First restored draft');
	await popup.getByRole('button', { name: 'New Chat Tab', exact: true }).click();
	await expect(popup.getByRole('tab')).toHaveCount(2);
	await popup.locator(chats).getByRole('textbox', { name: 'Chat message', exact: true }).focus();
	await popup.keyboard.insertText('Second restored draft');
	await expect(popup.locator(chats)).toContainText('Second restored draft');
	const firstTabItem = popup.locator('.ash-editor-tabs-control .ash-tab').filter({ has: popup.getByRole('tab', { name: /New Chat/ }) }).first();
	await firstTabItem.hover();
	await firstTabItem.locator('.ash-tab-close-action button').click();
	await expect(popup.getByRole('tab')).toHaveCount(1);
	const pickerButton = popup.getByRole('button', { name: 'Open Chat in This Window', exact: true });
	// Unsent drafts share their default title. Find the captured draft by its content.
	await pickerButton.click();
	const drafts = popup.getByRole('option', { name: /New Chat/ });
	await expect(drafts.first()).toBeVisible();
	const draftCount = await drafts.count();
	for (let index = 0; index < draftCount; index++) {
		if (index > 0) await pickerButton.click();
		await drafts.nth(index).click();
		await expect(popup.getByRole('tab')).toHaveCount(2);
		if ((await popup.locator(chats).textContent())?.includes('First restored draft')) break;
		const added = popup.locator('.ash-editor-tabs-control .ash-tab').filter({ has: popup.getByRole('tab', { selected: true }) });
		await added.hover();
		await added.locator('.ash-tab-close-action button').click();
		await expect(popup.getByRole('tab')).toHaveCount(1);
	}
	await expect(popup.getByRole('tab')).toHaveCount(2);
	await expect(popup.locator(chats)).toContainText('First restored draft');
	await popup.getByRole('tab', { name: /New Chat/ }).first().click();
	await expect(popup.locator(chats)).toContainText('Second restored draft');
	const file = join(testWorkspace.directory, 'chat-window.txt');
	await writeFile(file, 'File restored beside Chat');
	const original = await application.evaluate(({ dialog }, filePath) => {
		const original = dialog.showOpenDialog;
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
		return original;
	}, file);
	try {
		await popup.getByRole('button', { name: 'Open File Beside Chat', exact: true }).click();
		await expect(popup.getByRole('tab', { name: /chat-window\.txt/ })).toBeVisible();
		await popup.getByRole('button', { name: 'Split Right', exact: true }).click();
		await expect(popup.getByRole('tab', { name: /chat-window\.txt/ })).toHaveCount(2);
	} finally {
		await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, original);
	}
	await popup.getByRole('button', { name: 'New Terminal in Chat Window', exact: true }).click();
	const terminalRows = '.ash-terminal-editor:visible .xterm-rows';
	const prompt = /[$#%>❯]\s*$/u;
	await expect(popup.locator(terminalRows)).toContainText(prompt, { timeout: 20_000 });
	const terminal = popup.locator('.ash-terminal-editor:visible');
	const chat = popup.locator(chats);
	const editorTab = popup.getByRole('tab', { name: /chat-window\.txt/ }).last();
	const marker = 'ASH_EDGE_TERMINAL';
	const terminalInput = terminal.locator('.xterm-helper-textarea');
	await terminalInput.pressSequentially("node -e \"console.log(['ASH','EDGE','TERMINAL'].join('_'))\"");
	await terminalInput.press('Enter');
	await expect(popup.locator(terminalRows)).toContainText(marker);

	await setTerminalPosition(popup, 'Terminal Under Chat');
	await expect.poll(async () => Math.abs((await bounds(terminal)).x - (await bounds(chat)).x)).toBeLessThan(6);
	expect(Math.abs((await bounds(terminal)).width - (await bounds(chat)).width)).toBeLessThan(6);
	expect((await bounds(editorTab)).x).toBeGreaterThan((await bounds(terminal)).x + (await bounds(terminal)).width - 6);
	await setTerminalPosition(popup, 'Terminal Across Window');
	const grid = popup.locator('.ash-chat-window-grid');
	await expect.poll(async () => Math.abs((await bounds(terminal)).width - (await bounds(grid)).width)).toBeLessThan(6);
	await setTerminalPosition(popup, 'Terminal Under Editor');
	await expect.poll(async () => (await bounds(terminal)).x - (await bounds(chat)).x).toBeGreaterThan(100);
	await expect(popup.locator(terminalRows)).toContainText(marker);

	await dragTabToEdge(popup, editorTab, 'left');
	const edgeTab = (edge: string) => popup.locator(edgeSelector(edge)).getByRole('tab', { name: /chat-window\.txt/ });
	await expect(edgeTab('left')).toBeVisible();
	for (const edge of ['right', 'top', 'bottom'] as const) {
		const previous = edge === 'right' ? 'left' : edge === 'top' ? 'right' : 'top';
		await dragTabToEdge(popup, edgeTab(previous), edge);
		await expect(edgeTab(edge)).toBeVisible();
		await expect(popup.locator(edgeSelector(previous))).toHaveCount(0);
	}
	await edgeTab('bottom').click();
	const commands = new QuickAccess(popup);
	await commands.open('>Move Editor to Right Window Edge');
	await expect(commands.items.filter({ hasText: 'Move Editor to Right Window Edge' })).toBeVisible();
	await popup.keyboard.press('Enter');
	await expect(edgeTab('right')).toBeVisible();
	await expect(popup.locator(edgeSelector('bottom'))).toHaveCount(0);

	await popup.getByRole('button', { name: 'Toggle Chat Window Split Layout', exact: true }).click();
	const sash = popup.getByRole('separator', { name: 'Resize Chat Conversation' });
	const sashBounds = await bounds(sash);
	const chatBounds = await bounds(chat);
	await popup.mouse.move(sashBounds.x + sashBounds.width / 2, sashBounds.y + sashBounds.height / 2);
	await popup.mouse.down();
	await popup.mouse.move(sashBounds.x + sashBounds.width / 2, chatBounds.y + chatBounds.height - 5, { steps: 12 });
	await popup.mouse.up();
	await expect(popup.getByRole('button', { name: 'Show Chat Conversation', exact: true })).toBeVisible();
	await expect(chat.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible();
	const collapsedHeight = (await bounds(chat)).height;
	await sash.press('ArrowUp');
	await expect(popup.getByRole('button', { name: 'Show Chat Input Only', exact: true })).toBeVisible();
	await expect.poll(async () => (await bounds(chat)).height).toBeGreaterThan(collapsedHeight + 40);
	await popup.getByRole('button', { name: 'Show Chat Input Only', exact: true }).press('Enter');
	await expect(popup.getByRole('button', { name: 'Show Chat Conversation', exact: true })).toBeVisible();
	await expect.poll(async () => Math.abs((await bounds(chat)).height - collapsedHeight)).toBeLessThan(6);
	await expect(chat.locator('.ash-chat-list-widget')).toBeHidden();
	await testInfo.attach('chat-window-before-restart', { body: await popup.screenshot(), contentType: 'image/png' });

	const workbenchWindow = await application.browserWindow(workbench.page);
	try { await workbenchWindow.evaluate(window => window.focus()); }
	finally { await workbenchWindow.dispose(); }
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	if (!('windows' in application)) throw new Error('Expected Electron after restart');
	const main = await workbench.openAgentsWindow('electron');
	await expect.poll(async () => {
		for (const candidate of application.windows()) {
			if (await candidate.locator('.ash-chat-auxiliary-window').isVisible().catch(() => false)) return true;
		}
		return false;
	}).toBe(true);
	const restored = application.windows().find(candidate => candidate.url() === 'about:blank')!;
	await expect(restored.locator('.ash-chat-window-body').getByRole('tab')).toHaveCount(3);
	const documentTab = restored.getByRole('tab', { name: /chat-window\.txt/ });
	await expect(documentTab).toHaveCount(2);
	await expect(restored.locator(edgeSelector('right')).getByRole('tab', { name: /chat-window\.txt/ })).toBeVisible();
	await expect(restored.getByRole('button', { name: '显示聊天对话', exact: true })).toBeVisible();
	await expect(restored.locator(chats)).toContainText('Second restored draft');
	const restoredChat = restored.locator(chats);
	const editorBounds = await bounds(documentTab.first());
	expect((await bounds(restoredChat)).y).toBeGreaterThan(editorBounds.y + 100);
	await expect(restored.locator(terminalRows)).toContainText(prompt, { timeout: 20_000 });
	await restored.getByRole('button', { name: '切换聊天窗口的分栏方向', exact: true }).press('Enter');
	await expect.poll(async () => (await bounds(restored.locator('.ash-terminal-editor:visible'))).x - (await bounds(restoredChat)).x)
		.toBeGreaterThan(100);
	await restored.locator('.ash-chat-window-editor:visible').locator('xpath=ancestor::section[contains(@class,"ash-editor-group")]').getByRole('tab').last().click();
	await expect(restored.locator(chats)).toContainText('First restored draft');
	const terminalMenuButton = restored.getByRole('button', { name: '终端位置', exact: true });
	await terminalMenuButton.press('Enter');
	await expect(restored.getByRole('menuitemradio', { name: '终端位于编辑器下方', exact: true })).toHaveAttribute('aria-checked', 'true');
	await restored.keyboard.press('Escape');
	await testInfo.attach('chat-window-after-restart', { body: await restored.screenshot(), contentType: 'image/png' });
	const closed = restored.waitForEvent('close');
	await restored.getByRole('button', { name: '返回主窗口', exact: true }).click().catch(error => {
		if (!restored.isClosed()) throw error;
	});
	await closed;
	await expect(main.getByRole('tab', { name: /chat-window\.txt/ }).first()).toBeVisible();
	await expect(main.locator(terminalRows)).toContainText(prompt);
});
