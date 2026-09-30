import { expect, test } from "../../../automation/test.js";
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';

test.describe('Notification Center', () => {
	test.use({ openWorkspace: false });
	test('Sessions window does not show an empty Notification Center button', async ({ application, target, workbench }) => {
		test.skip(target.workbenchMode !== 'code', 'Requires Code Sessions');
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) throw new Error('Expected an Electron application');
			const opened = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			page = await opened;
		}
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		const toggle = page.getByRole('button', { name: 'Show Notification Center' });
		await expect(toggle).toBeHidden();
		const center = page.getByRole('region', { name: 'Notification Center' });
		await expect(center).toBeHidden();
	});
});

async function returnFromSessions(page: Page): Promise<void> {
	const accountButton = page.getByRole('button', { name: 'Accounts' });
	await accountButton.click();
	await expect(accountButton).toHaveAttribute('aria-expanded', 'true');
	if (process.platform === 'darwin') {
		// macOS renders this menu outside the web page, so Playwright cannot select its item by role.
		await page.evaluate(() => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			void ipc.invoke('ash:sessions:return-to-workbench');
		});
		return;
	}
	await page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
}

test('Code chat mode menu shows the available icons and selection', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || (target.kind !== 'browser' && target.kind !== 'electron'), 'Requires Code browser or Electron UI');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected an Electron application');
		const sessionPagePromise = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await sessionPagePromise;
	}
	const modeButton = page.locator("[data-action-id='ash.chat.input.mode'] button").first();
	await expect(modeButton).toBeVisible();
	await expect(modeButton.locator('svg[data-ash-icon-id="unlimited"]')).toHaveCount(1);
	const chevron = modeButton.locator('.ash-chat-input-mode-indicator svg[data-ash-icon-id="chevron-down"]');
	await expect(chevron).toBeVisible();
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeVisible();
	const labelBounds = await modeButton.locator('.ash-chat-input-mode-action-label').boundingBox();
	const chevronBounds = await chevron.boundingBox();
	expect(labelBounds).not.toBeNull();
	expect(chevronBounds).not.toBeNull();
	expect(chevronBounds!.x).toBeGreaterThan(labelBounds!.x + labelBounds!.width);
	const inputContainer = page.locator('.ash-chat-input-container').filter({ has: modeButton });
	await inputContainer.evaluate(element => element.style.width = '230px');
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeHidden();
	await expect(modeButton).toHaveAttribute('aria-label', 'Agent');
	await inputContainer.evaluate(element => element.style.width = '');
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeVisible();
	await modeButton.click();
	const menu = page.locator('.ash-chat-input-mode-menu');
	await expect(menu).toBeVisible();
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).hover();
	await page.waitForTimeout(650);
	await expect(page.locator('.ash-hover[role="tooltip"]')).toHaveCount(0);
	for (const [label, iconId] of [
		['Agent', 'unlimited'],
		['Plan', 'plan'],
		['Debug', 'debug'],
		['Multitask', 'multitask'],
		['Ask', 'chat-4'],
	] as const) {
		const item = menu.getByRole('menuitemradio', { name: label, exact: true });
		await expect(item).toBeVisible();
		await expect(item.locator('.ash-menu-leading-slot .ash-icon-label-icon svg.ash-icon')).toHaveCount(iconId ? 1 : 0);
		if (iconId) await expect(item.locator('.ash-menu-leading-slot .ash-icon-label-icon svg.ash-icon')).toHaveAttribute('data-ash-icon-id', iconId);
	}
	await expect(menu.getByRole('menuitemradio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.locator("[data-action-id='ash.chat.input.agent.error']")).toHaveCount(0);
	const selectedAgent = menu.getByRole('menuitemradio', { name: 'Agent' });
	const agentIcon = selectedAgent.locator('.ash-icon-label-icon svg.ash-icon');
	const selectionCheck = selectedAgent.locator('.ash-menu-leading-check > svg.ash-icon');
	await expect(agentIcon).toBeVisible();
	await expect(selectionCheck).toBeVisible();
	const agentIconBounds = await agentIcon.boundingBox();
	const selectionCheckBounds = await selectionCheck.boundingBox();
	expect(agentIconBounds).not.toBeNull();
	expect(selectionCheckBounds).not.toBeNull();
	expect(selectionCheckBounds!.x).toBeGreaterThan(agentIconBounds!.x);
	await menu.getByRole('menuitemradio', { name: 'Plan' }).click();
	await expect(modeButton).toHaveText('Plan');
	await expect(modeButton.locator('svg[data-ash-icon-id="plan"]')).toHaveCount(1);
	await expect(chevron).toBeVisible();
	await page.mouse.move(4, 4);
	await modeButton.focus();
	await page.keyboard.press('ArrowDown');
	await expect(modeButton).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(modeButton).toHaveAttribute('aria-expanded', 'false');
	await expect(modeButton).toBeFocused();
	for (const [label, mode, color] of [
		['Plan', 'plan', '--ash-charts-orange'],
		['Debug', 'debug', '--ash-charts-red'],
		['Multitask', 'multitask', '--ash-charts-purple'],
		['Ask', 'ask', '--ash-charts-green'],
	] as const) {
		if (mode !== 'plan') {
			await modeButton.click();
			await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: label, exact: true }).click();
		}
		await expect(modeButton.locator('..')).toHaveClass(new RegExp(`\\bmode-${mode}\\b`));
		const foreground = await modeButton.evaluate((button, variable) => {
			const probe = document.createElement('span');
			probe.style.color = `var(${variable})`;
			button.append(probe);
			const expected = getComputedStyle(probe).color;
			probe.remove();
			return { actual: getComputedStyle(button).color, expected };
		}, color);
		expect(foreground.actual).toBe(foreground.expected);
	}
});

test('Browser Code Sessions Activity Bar centers icons and changes size and position through its menu', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code', 'Requires the browser Code Sessions page');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const activityBar = page.locator('[data-part="activitybar"]');
	await expect(activityBar).toBeVisible();
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(activityBar.locator('.ash-sessions-activity-top button svg').first()).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	const collaboration = activityBar.getByRole('button', { name: 'Collaboration' });
	const library = activityBar.getByRole('button', { name: 'Library' });
	const chat = activityBar.getByRole('button', { name: 'Chat' });
	await collaboration.click();
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab-filled');
	await expect(collaboration).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
	await expect(page.locator('.ash-sessions-surface-header')).toBeHidden();
	await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
	await library.click();
	await expect(library.locator('svg')).toHaveAttribute('data-ash-icon-id', 'library-filled');
	await expect(library).toHaveAttribute('aria-current', 'page');
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab');
	await chat.click();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
	await expect(page.locator('.ash-sessions-surface-header')).toBeVisible();
	await expect(chat).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(page.locator('.ash-sessions-list-item.selected').first()).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(activityBar.locator('.ash-sessions-activity-bottom button svg').first()).toHaveAttribute('data-ash-icon-id', 'device-mobile');
	const accounts = activityBar.locator('.ash-sessions-activity-bottom button').last();
	await accounts.click();
	await expect(accounts).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(settings).toBeVisible();
	await expect(settings.locator('.ash-dialog-title')).toBeHidden();
	await expect(settings).toHaveCSS('border-top-width', '1px');
	await expect(settings.locator('.ash-sessions-settings')).toHaveCSS('border-top-width', '0px');
	await expect(settings.locator('.ash-sessions-settings-list')).toHaveCSS('border-top-width', '0px');
	const settingsCard = settings.locator('.ash-sessions-settings-list.ash-settings-card');
	await expect(settingsCard).toHaveCSS('border-radius', '8px');
	await expect(settingsCard).toHaveCSS('background-color', /rgb\(/);
	await expect(settingsCard.locator('.ash-configuration-setting').first()).toHaveCSS('border-top-left-radius', '8px');
	await expect(settingsCard.locator('.ash-configuration-setting').last()).toHaveCSS('border-bottom-right-radius', '8px');
	const sidebar = settings.locator('.ash-sessions-settings-sidebar');
	const settingsPage = settings.locator('.ash-sessions-settings-page');
	const sidebarBounds = await sidebar.boundingBox();
	const pageBounds = await settingsPage.boundingBox();
	expect(sidebarBounds).not.toBeNull();
	expect(pageBounds).not.toBeNull();
	expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThanOrEqual(pageBounds!.x + 1);
	expect(sidebarBounds!.y + sidebarBounds!.height).toBeGreaterThanOrEqual(pageBounds!.y + pageBounds!.height - 1);
	await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	for (const [section, categories] of [
		['Basics', ['General', 'Account', 'Appearance', 'Voice', 'Personalization']],
		['Development', ['Agents', 'Models', 'Git & PRs', 'Worktree', 'Browser', 'Tab', 'Code Intelligence', 'Environment']],
		['Management', ['Plugins', 'Keyboard Shortcuts', 'Archived Chats']],
	] as const) {
		const group = navigation.getByRole('group', { name: section });
		for (const category of categories) {
			await expect(group.getByRole('button', { name: category, exact: true }).locator('svg.ash-icon')).toHaveCount(1);
		}
	}
	await expect(navigation.getByRole('button', { name: 'Tab', exact: true }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'keyboard-tab');
	await expect(navigation.getByRole('button', { name: 'Personalization' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'briefcase');
	await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
	await expect(navigation.getByRole('button', { name: 'General' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'Voice' }).click();
	await expect(settings.getByRole('heading', { name: 'Voice' })).toBeVisible();
	for (const key of ['dictation.backend', 'dictation.cloudProvider', 'dictation.localModel']) {
		await expect(settings.locator(`[data-configuration-key="${key}"]`)).toBeVisible();
	}
	const dictationBackend = settings.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox');
	const originalDictationBackend = (await dictationBackend.textContent())!.trim();
	const changedDictationBackend = originalDictationBackend === 'Local' ? 'Cloud' : 'Local';
	await dictationBackend.click();
	await page.getByRole('option', { name: changedDictationBackend }).click();
	await expect(dictationBackend).toHaveText(changedDictationBackend);
	await dictationBackend.click();
	await page.getByRole('option', { name: originalDictationBackend }).click();
	await navigation.getByRole('button', { name: 'Archived Chats' }).click();
	await expect(settingsPage.getByRole('heading')).toHaveCount(0);
	await expect(settingsPage.locator('.ash-configuration-setting')).toHaveCount(0);
	await expect(settings.getByText('No settings found.')).toBeHidden();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
	const searchSettings = settings.getByRole('searchbox', { name: 'Search settings' });
	await expect(settings.locator('.ash-sessions-settings-search svg[data-ash-icon-id="search"]')).toBeVisible();
	await searchSettings.fill('layout');
	await expect(settings.getByRole('heading', { name: 'Search results' })).toBeVisible();
	await expect(settings.locator('.ash-configuration-setting')).toHaveCount(1);
	await searchSettings.fill('unmatched-setting');
	await expect(settings.getByText('No settings found.')).toBeVisible();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const originalViewport = page.viewportSize();
	if (!originalViewport) throw new Error('Browser test requires a viewport');
	await page.setViewportSize({ width: 540, height: 500 });
	const narrowSidebarBounds = await sidebar.boundingBox();
	const narrowPageBounds = await settingsPage.boundingBox();
	expect(narrowSidebarBounds).not.toBeNull();
	expect(narrowPageBounds).not.toBeNull();
	expect(narrowSidebarBounds!.y + narrowSidebarBounds!.height).toBeLessThanOrEqual(narrowPageBounds!.y + 1);
	await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
	await page.setViewportSize(originalViewport);
	const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
	const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
	const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
	await layoutStyle.click();
	await page.getByRole('option', { name: changedLayoutStyle }).click();
	await expect(layoutStyle).toHaveText(changedLayoutStyle);
	await layoutStyle.click();
	await page.getByRole('option', { name: originalLayoutStyle }).click();
	await page.keyboard.press('Escape');
	await expect(settings).toHaveCount(0);
	await expect(accounts).toBeFocused();
	const chatButton = activityBar.locator('button').first();
	const buttonBounds = await chatButton.boundingBox();
	const iconBounds = await chatButton.locator('svg').boundingBox();
	expect(buttonBounds).not.toBeNull();
	expect(iconBounds).not.toBeNull();
	expect(buttonBounds!.width).toBe(36);
	expect(buttonBounds!.height).toBe(36);
	expect(iconBounds!.width).toBe(16);
	expect(iconBounds!.height).toBe(16);
	const collaborationIcon = activityBar.locator('button svg[data-ash-icon-id="colab"]');
	await expect(collaborationIcon).toHaveCSS('width', '16px');
	expect(Math.abs(iconBounds!.x + iconBounds!.width / 2 - (buttonBounds!.x + buttonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Compact' }).click();
	await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
	await expect(collaborationIcon).toHaveCSS('width', '16px');
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(activityBar).toBeHidden();
	const topHost = page.locator('.ash-sessions-activity-host.top');
	await expect(topHost).toBeVisible();
	await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /Chat/);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await expect(topHost).toBeHidden();
	await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expect(activityBar).toBeVisible();
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeHidden();
	await expect(activityBar).toBeHidden();
});

test('Browser Sessions settings scroll each pane independently', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Requires the browser Code Sessions page');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const originalViewport = page.viewportSize();
	if (!originalViewport) throw new Error('Browser test requires a viewport');
	try {
		await page.setViewportSize({ width: 1080, height: 420 });
		const navigationViewport = navigation.locator('.ash-scrollbar-viewport');
		const contentViewport = settings.locator('.ash-sessions-settings-page .ash-scrollbar-viewport');
		await expect(navigationViewport).toHaveCSS('scrollbar-width', 'none');
		await expect(contentViewport).toHaveCSS('scrollbar-width', 'none');
		await expect(navigation.locator('.ash-scrollbar-track-vertical')).toHaveCount(1);
		await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-track-vertical')).toHaveCount(1);
		await expect.poll(() => navigationViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight)).toBe(true);
		await expect.poll(() => contentViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight)).toBe(true);
		await contentViewport.hover({ position: { x: 10, y: 10 } });
		await page.mouse.wheel(0, 300);
		await expect.poll(() => contentViewport.evaluate(viewport => viewport.scrollTop)).toBeGreaterThan(0);
		await expect(navigationViewport).toHaveJSProperty('scrollTop', 0);
		const contentScrollTop = await contentViewport.evaluate(viewport => viewport.scrollTop);
		await navigationViewport.hover({ position: { x: 10, y: 10 } });
		await page.mouse.wheel(0, 300);
		await expect.poll(() => navigationViewport.evaluate(viewport => viewport.scrollTop)).toBeGreaterThan(0);
		await expect(contentViewport).toHaveJSProperty('scrollTop', contentScrollTop);
		await navigation.getByRole('button', { name: 'Voice' }).click();
		await expect(contentViewport).toHaveJSProperty('scrollTop', 0);
	} finally {
		await page.setViewportSize(originalViewport);
	}
});

test('Browser Models Settings controls which models appear in the picker', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires browser Code Sessions with App Server');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const modelButton = page.locator('[data-action-id="ash.chat.input.model"] button').first();
	await expect(modelButton).toBeVisible();
	const accounts = page.locator('.ash-sessions-activity-bottom button').last();
	await accounts.click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	await expect(settings.getByRole('heading', { name: 'Voice input' })).toBeVisible();
	await expect(settings.locator('.ash-sessions-settings-voice-list [data-configuration-key="dictation.localModel"]')).toBeVisible();
	await expect(settings.locator('.ash-sessions-settings-cloud-models')).toContainText('gpt-live-transcribe');
	await expect(settings.getByRole('heading', { name: 'API connections' })).toBeVisible();
	const apiConnection = settings.locator('.ash-sessions-settings-api-row').first();
	await expect(apiConnection).toBeVisible();
	await expect(apiConnection.locator('input[type="password"]')).toBeVisible();
	const apiName = (await apiConnection.locator('.ash-sessions-settings-api-name').textContent())!.trim();
	const modelRows = settings.locator('.ash-sessions-settings-model-row');
	await expect(modelRows.first()).toBeVisible();
	const firstModel = modelRows.first();
	const modelName = (await firstModel.locator('.ash-sessions-settings-model-name').textContent())!.trim();
	const modelSearch = settings.getByRole('searchbox', { name: 'Search models and APIs' });
	await modelSearch.fill('no-such-model');
	await expect(settings.getByText('No matching models or APIs.')).toBeVisible();
	await expect(modelRows.first()).toBeHidden();
	await modelSearch.fill(apiName);
	await expect(apiConnection).toBeVisible();
	await modelSearch.fill(modelName);
	await expect(firstModel).toBeVisible();
	const visibility = firstModel.getByRole('switch', { name: `Show ${modelName} in model picker` });
	await expect(visibility).toHaveAttribute('aria-checked', 'true');
	await firstModel.locator('.ash-switch-track').click();
	await expect(visibility).toHaveAttribute('aria-checked', 'false');
	await page.keyboard.press('Escape');
	await modelButton.click();
	await expect(page.locator('.ash-chat-model-picker').getByText(modelName, { exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await accounts.click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	const restoredVisibility = settings.getByRole('switch', { name: `Show ${modelName} in model picker` });
	await expect(restoredVisibility).toHaveAttribute('aria-checked', 'false');
	await restoredVisibility.locator('..').locator('.ash-switch-track').click();
	await expect(restoredVisibility).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await modelButton.click();
	await expect(page.locator('.ash-chat-model-picker').getByText(modelName, { exact: true })).toBeVisible();
});

test('Electron Code Sessions Activity Bar follows its position and size settings', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const page = await sessionPagePromise;
	const original = await page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (location: string, compact: boolean): Promise<void> => {
		await page.evaluate(async values => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['sessions.activityBar.location'] = values.location;
			settings['sessions.activityBar.compact'] = values.compact;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, { location, compact });
	};
	try {
		await updateSettings('default', false);
		const collaboration = page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Collaboration' });
		const library = page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Library' });
		await collaboration.click();
		await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab-filled');
		await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
		await library.click();
		await expect(library.locator('svg')).toHaveAttribute('data-ash-icon-id', 'library-filled');
		await expect(page.locator('.ash-sessions-surface-header')).toBeHidden();
		await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
		await page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Chat' }).click();
		await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
		const chatButton = page.locator('[data-part="activitybar"] button').first();
		await expect(chatButton).toBeVisible();
		await chatButton.click({ button: 'right' });
		await page.keyboard.press('Escape');
		await updateSettings('default', true);
		await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
		await updateSettings('top', true);
		await expect(page.locator('[data-part="activitybar"]')).toBeHidden();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await page.reload();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await updateSettings('bottom', true);
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	} finally {
		await page.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Electron Sessions account menu opens the Sessions settings page', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	if (process.platform === 'darwin') {
		// The system menu is outside Playwright's page DOM; use the product's custom menu for this UI flow.
		await workbench.page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['window.menuStyle'] = 'custom';
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		});
	}
	const sessionPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const page = await sessionPagePromise;
	const accountButton = page.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last();
	await accountButton.click();
	await expect(accountButton).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(settings).toBeVisible();
	await expect(settings.locator('.ash-sessions-settings-list.ash-settings-card')).toHaveCSS('border-radius', '8px');
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await expect(navigation.locator('.ash-scrollbar-viewport')).toHaveCSS('scrollbar-width', 'none');
	await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-viewport')).toHaveCSS('scrollbar-width', 'none');
	await expect(navigation.locator('.ash-scrollbar-track-vertical')).toHaveCount(1);
	await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-track-vertical')).toHaveCount(1);
	const sidebarBounds = await settings.locator('.ash-sessions-settings-sidebar').boundingBox();
	const scrollTrackBounds = await navigation.locator('.ash-scrollbar-track-vertical').boundingBox();
	expect(sidebarBounds).not.toBeNull();
	expect(scrollTrackBounds).not.toBeNull();
	expect(Math.abs(sidebarBounds!.x + sidebarBounds!.width - scrollTrackBounds!.x - scrollTrackBounds!.width)).toBeLessThanOrEqual(2);
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'Voice' }).click();
	await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="dictation.localModel"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'General' }).click();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
	await navigation.getByRole('button', { name: 'Models' }).click();
	await expect(settings.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
	await expect(settings.getByRole('searchbox', { name: 'Search models and APIs' })).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'Voice input' })).toBeVisible();
	await expect(settings.locator('.ash-sessions-settings-voice-list [data-configuration-key="dictation.localModel"]')).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'API connections' })).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(settings.locator('.ash-sessions-settings-api-row').first().locator('input[type="password"]')).toBeVisible();
		const firstModel = settings.locator('.ash-sessions-settings-model-row').first();
		await expect(firstModel).toBeVisible();
		const visibility = firstModel.getByRole('switch');
		await expect(visibility).toHaveAttribute('aria-checked', 'true');
		await firstModel.locator('.ash-switch-track').click();
		await expect(visibility).toHaveAttribute('aria-checked', 'false');
		await firstModel.locator('.ash-switch-track').click();
		await expect(visibility).toHaveAttribute('aria-checked', 'true');
	}
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
	const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
	const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
	await layoutStyle.click();
	await page.getByRole('option', { name: changedLayoutStyle }).click();
	await expect(layoutStyle).toHaveText(changedLayoutStyle);
	await layoutStyle.click();
	await page.getByRole('option', { name: originalLayoutStyle }).click();
	await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
	const dialogBounds = await settings.boundingBox();
	expect(dialogBounds).not.toBeNull();
	await page.mouse.click(dialogBounds!.x - 8, dialogBounds!.y - 8);
	await expect(settings).toHaveCount(0);
	await expect(accountButton).toBeFocused();
});

test('Sessions and IDE layout styles switch independently', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const sessionsWindow = sessionsPage.locator('.ash-sessions-window');
	await expect(sessionsWindow).toBeVisible();
	const original = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (values: Record<string, string>): Promise<void> => {
		await sessionsPage.evaluate(async changes => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			for (const [key, value] of Object.entries(changes)) settings[key] = value;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, values);
	};
	const gap = () => sessionsPage.evaluate(() => {
		const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]');
		const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]');
		if (!sidebar || !sessions) throw new Error('Sessions regions are missing');
		return Math.round(sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right);
	});
	try {
		await updateSettings({ 'workbench.layoutStyle': 'modern', 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCSS('border-top-left-radius', '8px');
		await updateSettings({ 'workbench.layoutStyle': 'flat' });
		await expect(workbench.element).toHaveAttribute('data-layout-style', 'flat');
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await updateSettings({ 'sessions.layoutStyle': 'flat' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '0px');
		await sessionsPage.reload();
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await updateSettings({ 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '0px');
		await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCSS('border-top-left-radius', '8px');
	} finally {
		await sessionsPage.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Sessions applies an installed extension color theme', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires Code Sessions and App Server extension resources');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const openSessions = workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	const sessionPagePromise = application.waitForEvent('window');
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'extension-vscode-theme-defaults-visual-studio-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => sessionsPage.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
});

test('Open in Agents moves the IDE chat draft into the Agents Window', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the Code Electron chat shell');
	if (target.kind !== 'electron' || !('windows' in application)) throw new Error('Agents Window handoff requires Electron');

	const workbenchPage = workbench.page;
	if (!await workbenchPage.locator('.ash-chat-view-pane').isVisible()) {
		await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const sourceChat = workbenchPage.locator('.ash-chat-view-pane .ash-chat').first();
	const sourceDraft = sourceChat.getByRole('textbox', { name: 'Chat message' });
	const sourceLine = sourceChat.locator('.ash-chat-input-editor .stanza-editor-line-text').first();
	await sourceDraft.focus();
	await workbenchPage.keyboard.insertText('Continue reviewing this change in Agents Window');
	await workbenchPage.getByRole('button', { name: 'Hide Secondary Side Bar', exact: true }).click();
	const auxiliaryBar = workbenchPage.locator('[data-part="auxiliarybar"]');
	await expect(auxiliaryBar).toBeHidden();

	const sessionsPagePromise = application.waitForEvent('window');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const targetDraft = sessionsPage.locator('.ash-sessions-chat-slot.active').getByRole('textbox', { name: 'Chat message' });
	await expect(targetDraft).toHaveValue('Continue reviewing this change in Agents Window');
	await expect(auxiliaryBar).toBeHidden();
	await expect(sourceLine).toHaveText('');

	await sessionsPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+W' : 'Control+Alt+W');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/workbench/workbench.html'))).toBe(true);
	await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	await sourceDraft.focus();
	await workbenchPage.keyboard.insertText('Keep this second draft in the IDE');
	await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	await expect(targetDraft).toHaveValue('Continue reviewing this change in Agents Window');
	await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
});

test('Open in Agents selects the same session thread in the Agents Window', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires Code Electron with App Server');
	if (target.kind !== 'electron' || !('windows' in application)) throw new Error('Agents Window handoff requires Electron');

	const workbenchPage = workbench.page;
	if (!await workbenchPage.locator('.ash-chat-view-pane').isVisible()) {
		await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const sourceChat = workbenchPage.locator('.ash-chat-view-pane .ash-chat:visible');
	await sourceChat.getByRole('textbox', { name: 'Chat message' }).focus();
	await workbenchPage.keyboard.insertText('Create a session for the window handoff test');
	await sourceChat.locator('[data-action-id="ash.chat.input.send"] button').click();
	await expect(sourceChat).toHaveAttribute('data-session-id', /.+/u);
	const sessionId = await sourceChat.getAttribute('data-session-id');
	const threadId = await sourceChat.getAttribute('data-thread-id');
	expect(sessionId).toBeTruthy();
	expect(threadId).toBeTruthy();

	const sessionsPagePromise = application.waitForEvent('window');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const targetChat = sessionsPage.locator('.ash-sessions-chat-slot.active .ash-chat');
	await expect(targetChat).toHaveAttribute('data-session-id', sessionId!);
	await expect(targetChat).toHaveAttribute('data-thread-id', threadId!);
});

test("Code opens Sessions in a dedicated Electron window and returns to Workbench", async ({ application, target, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.workbenchMode !== "code",
		"This scenario verifies the Code Electron Sessions window.",
	);
	if (target.kind !== "electron") {
		return;
	}
	if (!("windows" in application)) {
		throw new Error("Dedicated Sessions window verification requires Electron");
	}

	const workbenchPage = workbench.page;
	const openSessions = workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	await expect(openSessions).toBeVisible();
	const sessionPagePromise = application.waitForEvent("window");
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await sessionsPage.waitForLoadState("domcontentloaded");
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toBeVisible();
	const resources = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly revision: number; readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		return { configurationRevision: configuration.revision, keybindingsRevision: keybindings.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind };
	});
	expect(resources).toEqual({ configurationRevision: expect.any(Number), keybindingsRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local' });
	const childWindowOperations = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const windows = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly id: number; readonly title: string }[];
		const sessions = windows.find(window => window.title.includes('Sessions'));
		if (!sessions) throw new Error('Sessions window is missing from window list');
		const zoomChange = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:window:zoom-changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(value as number);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Dedicated window zoom change was not delivered'));
			}, 2_000);
		});
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 1 });
		const changedZoom = await zoomChange;
		const zoom = await ipc.invoke('ash:window:operation', { kind: 'getZoom' });
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		return { count: windows.length, changedZoom, zoom };
	});
	expect(childWindowOperations).toEqual({ count: 2, changedZoom: 1, zoom: 1 });
	await sessionsPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+W' : 'Control+Alt+W');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/workbench/workbench.html'))).toBe(true);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/sessions/sessions-code.html'))).toBe(true);
	const configurationChange = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const before = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const changed = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:configuration:changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve((value as { readonly revision: number }).revision);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Sessions configuration change was not delivered'));
			}, 2_000);
		});
		const updated = await ipc.invoke('ash:configuration:update', {
			expectedRevision: before.revision,
			document: { ...before.document, source: `${before.document.source}\n` },
		}) as { readonly revision: number };
		const notifiedRevision = await changed;
		await ipc.invoke('ash:configuration:update', { expectedRevision: updated.revision, document: before.document });
		return { updatedRevision: updated.revision, notifiedRevision };
	});
	expect(configurationChange.updatedRevision).toBe(configurationChange.notifiedRevision);
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-mode", "code");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-runtime", "electron");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-state", "empty");
	await sessionsPage.emulateMedia({ colorScheme: "dark" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-dark");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#1e1e1e");
	await sessionsPage.emulateMedia({ colorScheme: "light" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-light");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#ffffff");
	const originalThemeSettings = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'ash-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
		return snapshot.document;
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await sessionsPage.emulateMedia({ colorScheme: 'dark' });
	await sessionsPage.evaluate(async document => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document });
	}, originalThemeSettings);
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	const titlebar = sessionsPage.locator("[data-part='titlebar']");
	await expect(titlebar).toBeVisible();
	await expect(titlebar).toHaveCSS('-webkit-app-region', 'drag');
	await expect(titlebar.getByRole('button').first()).toHaveCSS('-webkit-app-region', 'no-drag');
	await expect(titlebar.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
	await expect(titlebar.locator('.ash-sessions-titlebar-title, .ash-sessions-titlebar-avatar')).toHaveCount(0);
	const titlebarButtons = titlebar.locator('.ash-action-bar[role="toolbar"] button');
	await expect(titlebar.locator('.ash-action-bar[role="toolbar"]')).toHaveAttribute('aria-label', 'Title bar left actions');
	await expect(titlebarButtons).toHaveCount(4);
	const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
	await expect(titlebar.getByRole('navigation', { name: 'Chat and Code' })).toHaveCount(0);
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(sessionsPage.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	const titlebarActionNames = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
	expect(titlebarActionNames).toEqual(['Application menu', 'Hide sidebar', 'Back', 'Forward']);
	await expect(titlebar).toHaveCSS('height', '35px');
	await expect(titlebar).toHaveCSS('border-bottom-width', '0px');
	const titlebarBounds = await titlebar.boundingBox();
	const buttonBounds = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
	expect(buttonBounds.every((button, index) => button.right < titlebarBounds!.x + titlebarBounds!.width / 2 && (index === 0 || button.left > buttonBounds[index - 1].left))).toBe(true);
	if (process.platform === 'darwin') {
		const spacer = sessionsPage.locator('.ash-sessions-window-controls-spacer');
		await expect(spacer).toBeVisible();
		const [spacerBounds, controlsBounds] = await Promise.all([
			spacer.boundingBox(),
			titlebarButtons.first().boundingBox(),
		]);
		expect(controlsBounds!.x).toBeGreaterThanOrEqual(spacerBounds!.x + spacerBounds!.width);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: -2 });
		});
		await expect.poll(() => spacer.evaluate(element => Number.parseFloat(getComputedStyle(element).width))).toBeGreaterThan(90);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		});
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(true);
		});
		await expect(sessionsPage.locator('#app')).toHaveClass(/ash-sessions-fullscreen/u);
		await expect(spacer).toBeHidden();
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(false);
		});
		await expect(spacer).toBeVisible();
	}
	await expect(sessionsPage.locator("[data-part='activitybar']")).toBeVisible();
	const activityButtons = sessionsPage.locator("[data-part='activitybar'] button");
	expect(await activityButtons.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['chat-2-filled', 'colab', 'library', 'device-mobile', 'account']);
	await expect(sessionsPage.locator('.ash-sessions-activity-bottom button')).toHaveCount(2);
	const chatButton = activityButtons.first();
	const chatButtonBounds = await chatButton.boundingBox();
	const chatIconBounds = await chatButton.locator('svg').boundingBox();
	expect(chatButtonBounds).not.toBeNull();
	expect(chatIconBounds).not.toBeNull();
	expect(chatButtonBounds!.width).toBe(36);
	expect(chatButtonBounds!.height).toBe(36);
	expect(Math.abs(chatIconBounds!.x + chatIconBounds!.width / 2 - (chatButtonBounds!.x + chatButtonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(chatIconBounds!.y + chatIconBounds!.height / 2 - (chatButtonBounds!.y + chatButtonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await expect(activityButtons.nth(1)).toBeEnabled();
	await expect(activityButtons.nth(2)).toBeEnabled();
	await expect(activityButtons.nth(3)).toBeDisabled();
	if (target.appServerMode === 'required') {
		await activityButtons.nth(4).click();
		await expect(activityButtons.nth(4)).toHaveAttribute('aria-expanded', 'true');
		if (process.platform !== 'darwin') {
			await expect(sessionsPage.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
			await expect(sessionsPage.getByRole('menuitem', { name: 'Return to Workbench' })).toBeVisible();
			await expect(sessionsPage.getByRole('menuitem', { name: 'Sign in with ChatGPT' })).toHaveCount(0);
		}
		await sessionsPage.keyboard.press('Escape');
	}
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeVisible();
	const sidebarToggle = titlebar.getByRole('button', { name: 'Hide sidebar' });
	await expect(sidebarToggle.locator('svg[data-ash-icon-id="layout-sidebar-left-2"]')).toBeVisible();
	const divider = await sessionsPage.evaluate(() => {
		const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]')!;
		const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]')!;
		return {
			gap: sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right,
			sidebarRadius: getComputedStyle(sidebar).borderTopRightRadius,
			sessionsRadius: getComputedStyle(sessions).borderTopLeftRadius,
		};
	});
	expect(divider).toEqual({ gap: 0, sidebarRadius: '0px', sessionsRadius: '0px' });
	await sidebarToggle.click();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeHidden();
	const showSidebar = titlebar.getByRole('button', { name: 'Show sidebar' });
	await expect(showSidebar.locator('svg[data-ash-icon-id="layout-sidebar-left-off-2"]')).toBeVisible();
	await showSidebar.click();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await titlebar.getByRole('button', { name: 'Application menu' }).click();
	await expect(titlebar.getByRole('button', { name: 'Application menu' })).toHaveAttribute('aria-expanded', 'true');
	await expect(sessionsPage.getByRole('menuitem', { name: 'File' })).toBeVisible();
	await sessionsPage.keyboard.press('Escape');
	await expect(sessionsPage.locator(".ash-sessions-list")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-sessions-chat-slot").first()).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-chat-input-part")).toBeVisible();
	const search = sessionsPage.getByRole('searchbox', { name: 'Search sessions' });
	await search.fill('no matching session title');
	await expect(sessionsPage.locator('.ash-sessions-empty')).toHaveText('No matching sessions');
	await search.clear();
	await sessionsPage.locator('.ash-sessions-list-add').click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(2);
	await expect(sessionsPage.locator(".ash-sessions-chat-slot.active")).toHaveCount(1);
	await sessionsPage.locator(".ash-sessions-chat-slot-close").last().click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(1);
	await expect.poll(() => application.windows().length).toBe(2);

	const sessionWindowState = await application.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return windows.map((window: { readonly id: number; getTitle(): string; readonly webContents: { getURL(): string } }) => ({
			id: window.id,
			title: window.getTitle(),
			url: window.webContents.getURL(),
		}));
	});
	expect(sessionWindowState).toHaveLength(2);
	expect(sessionWindowState.some((window: { readonly url: string }) => window.url.includes("sessions-code.html"))).toBe(true);
	const windowIds = sessionWindowState.map((window: { readonly id: number }) => window.id).sort((left: number, right: number) => left - right);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id).sort((left, right) => left - right))).toEqual(windowIds);
	await sessionsPage.reload();
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.windows().length).toBe(2);
	const reloadedIpc = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		let childCannotOpen = false;
		try { await ipc.invoke('ash:native-host:open-agents-window'); } catch { childCannotOpen = true; }
		return { configurationRevision: configuration.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind, childCannotOpen };
	});
	expect(reloadedIpc).toEqual({ configurationRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local', childCannotOpen: true });
	await expect(workbenchPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:sessions:return-to-workbench');
	})).rejects.toThrow(/Untrusted renderer IPC sender/);
	const expectedBounds = await application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		if (!child) throw new Error('Sessions window is missing');
		child.setBounds({ ...child.getBounds(), width: 1000, height: 700 });
		return child.getBounds();
	});

	const closed = sessionsPage.waitForEvent("close");
	await returnFromSessions(sessionsPage);
	await closed;
	await expect.poll(() => application.windows().length).toBe(1);
	await expect(workbenchPage.locator(".ash-workbench")).toBeVisible();
	await openSessions.click();
	await expect.poll(() => application.windows().length).toBe(2);
	const reopenedPage = application.windows().find(page => page !== workbenchPage);
	if (!reopenedPage) throw new Error('Reopened Sessions window is missing');
	await expect(reopenedPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		return child?.getBounds();
	})).toEqual(expectedBounds);
	const reopenedClosed = reopenedPage.waitForEvent('close');
	await returnFromSessions(reopenedPage);
	await reopenedClosed;
	const parentClosed = workbenchPage.waitForEvent('close');
	await application.evaluate(({ BrowserWindow }) => {
		const parent = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL().includes('workbench.html'));
		if (!parent) throw new Error('Workbench window is missing');
		parent.close();
	});
	await parentClosed;
});

test('Sessions titlebar aligns its application menu and actions', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const toolbar = sessionsPage.locator('[data-part="titlebar"] .ash-toolbar');
	const buttons = toolbar.getByRole('button');
	await expect(buttons).toHaveCount(4);
	await expect(toolbar).toHaveCSS('-webkit-app-region', 'no-drag');
	await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
	const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page');
	await expect(sessionsPage.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(sessionsPage.locator('.ash-sessions-surface-header')).toBeHidden();
	await activityNavigation.getByRole('button', { name: 'Chat' }).click();
	await expect(sessionsPage.locator('.ash-sessions-surface-header')).toBeVisible();
	expect(await buttons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Application menu', 'Hide sidebar', 'Back', 'Forward']);
	const columnOffset = await sessionsPage.evaluate(() => {
		const menu = document.querySelector<HTMLElement>('[data-action-id="ash.applicationMenu"] button')!;
		const chat = document.querySelector<HTMLElement>('[data-part="activitybar"] button')!;
		const menuBounds = menu.getBoundingClientRect();
		const chatBounds = chat.getBoundingClientRect();
		return menuBounds.x + menuBounds.width / 2 - (chatBounds.x + chatBounds.width / 2);
	});
	if (process.platform !== 'darwin') expect(Math.abs(columnOffset)).toBeLessThanOrEqual(1);
	const iconOffsets = await buttons.evaluateAll(buttons => buttons.map(button => {
		const buttonBounds = button.getBoundingClientRect();
		const iconBounds = button.querySelector('svg')!.getBoundingClientRect();
		return {
			x: iconBounds.x + iconBounds.width / 2 - (buttonBounds.x + buttonBounds.width / 2),
			y: iconBounds.y + iconBounds.height / 2 - (buttonBounds.y + buttonBounds.height / 2),
		};
	}));
	expect(Math.max(...iconOffsets.map(({ x, y }) => Math.max(Math.abs(x), Math.abs(y))))).toBeLessThanOrEqual(1);
	await toolbar.getByRole('button', { name: 'Hide sidebar' }).click();
	await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeHidden();
	await toolbar.getByRole('button', { name: 'Show sidebar' }).click();
	await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeVisible();
	await toolbar.getByRole('button', { name: 'Application menu' }).click();
	await expect(toolbar.getByRole('button', { name: 'Application menu' })).toHaveAttribute('aria-expanded', 'true');
	const closed = sessionsPage.waitForEvent('close');
	if (process.platform === 'darwin') {
		await sessionsPage.keyboard.press('Escape');
		await returnFromSessions(sessionsPage);
	} else {
		await sessionsPage.getByRole('menuitem', { name: 'File' }).hover();
		await expect(sessionsPage.getByRole('menuitem', { name: 'New Session' })).toHaveCount(0);
		await sessionsPage.getByRole('menuitem', { name: 'Return to Workbench' }).click();
	}
	await closed;
});

test('Browser Sessions application menu uses Sessions actions', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code');
	await workbench.page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const menu = workbench.page.getByRole('button', { name: 'Application menu' });
	await menu.click();
	await workbench.page.getByRole('menuitem', { name: 'File' }).hover();
	await expect(workbench.page.getByRole('menuitem', { name: 'Return to Workbench' })).toBeVisible();
	await expect(workbench.page.getByRole('menuitem', { name: 'New Session' })).toHaveCount(0);
	await workbench.page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
	await expect(workbench.page).toHaveURL(/\/workbench\/workbench\.html$/u);
});

test('Sessions Activity Bar switches Chat and Code with the keyboard without losing the draft', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await opened;
	}
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expect(page.locator('[data-part="titlebar"] .ash-sessions-chat-code-switch')).toHaveCount(0);
	await expect(page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
	const draft = page.getByRole('textbox', { name: 'Chat message' }).first();
	await draft.fill('Keep this draft');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Library' }).focus();
	await page.keyboard.press('Tab');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toBeFocused();
	await page.keyboard.press('Enter');
	if (target.kind === 'browser') await expect(page).toHaveURL(/sessions-code\.html$/u);
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).not.toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(page.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(page.locator('.ash-sessions-surface-header')).toBeHidden();
	await expect(page.locator('.ash-sessions-list')).toBeVisible();
	await activityNavigation.getByRole('button', { name: 'Chat' }).focus();
	await page.keyboard.press('Space');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-surface-header')).toBeVisible();
	await expect(draft).toHaveValue('Keep this draft');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Collaboration' }).click();
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await expect(page.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(page.locator('.ash-sessions-list')).toBeVisible();
	await expect(activityNavigation.getByRole('button', { name: 'Collaboration' })).not.toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Chat' }).click();
	await expect(draft).toHaveValue('Keep this draft');
});

test('closing the Workbench keeps Sessions usable and Return to Workbench reopens the workspace', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-dedicated-close-'));
	try {
		const { application, driver, close } = await launchElectron({ appServerMode: target.appServerMode, workbenchMode: 'code', userDataDirectory });
		try {
			const parent = driver.workbench.page;
			const childPromise = application.waitForEvent('window');
			await parent.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const child = await childPromise;
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			await parent.close();
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			const windows = await child.evaluate(async () => {
				const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				const list = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly title: string }[];
				const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
				const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
				return { titles: list.map(window => window.title), configurationRevision: configuration.revision, connectionKind: connection.kind };
			});
			expect(windows).toEqual({ titles: [expect.stringContaining('Sessions')], configurationRevision: expect.any(Number), connectionKind: 'local' });
			const workbenchPromise = application.waitForEvent('window');
			await returnFromSessions(child);
			const reopened = await workbenchPromise;
			await expect(reopened.locator('.ash-workbench')).toBeVisible();
			await expect.poll(() => application.windows().length).toBe(1);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('Code registers and releases a user system-wide Open Agents Window shortcut', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-shortcut-'));
	const profileDirectory = join(userDataDirectory, 'profile');
	const resourcePath = join(profileDirectory, 'keybindings.json');
	await mkdir(profileDirectory);
	await writeFile(resourcePath, JSON.stringify([{
		key: 'ctrl+alt+shift+f24',
		command: 'workbench.action.openAgentsWindow',
		systemWide: true,
	}]));
	try {
		const { application, close } = await launchElectron({ appServerMode: 'disabled', workbenchMode: 'code', userDataDirectory, profileDirectory });
		try {
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(true);
			await writeFile(resourcePath, '[]\n');
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(false);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
