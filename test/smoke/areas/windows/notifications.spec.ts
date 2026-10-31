import { readUserSettings } from '../../../automation/settings.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { Workbench } from '../../../automation/workbench.js';
import { expect, test } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';
import { DEFAULT_MENU_STYLE, DEFAULT_TITLE_BAR_STYLE, resolveContextMenuStyle } from '../../../../src/ash/platform/window/common/window.js';

// Genuine OS popups need a focused owner for keyboard input and cancellation callbacks.
const focusTest = test.extend({
	electronWindowMode: async ({ target }, use) => {
		const systemMenu = resolveContextMenuStyle(DEFAULT_MENU_STYLE, DEFAULT_TITLE_BAR_STYLE, process.platform === 'darwin' ? 'macos' : 'desktop') === 'system';
		await use(target.appServerMode === 'required' && systemMenu ? 'active' : undefined);
	}
});
const macFocusTest = test.extend({
	electronWindowMode: async ({ target }, use) => {
		await use(process.platform === 'darwin' && target.appServerMode === 'required' ? 'active' : undefined);
	}
});

async function notificationClipboard(application: PlaywrightApplication, page: Page): Promise<{ read(): Promise<string>; }> {
	// Start with a fixture value; never read or retain the user's previous clipboard.
	const marker = 'ash-notification-copy-fixture';
	if ('windows' in application) {
		await application.evaluate(({ clipboard }, marker) => clipboard.writeText(marker), marker);
		return { read: () => application.evaluate(({ clipboard }) => clipboard.readText()) };
	}
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.evaluate(marker => navigator.clipboard.writeText(marker), marker);
	return { read: () => page.evaluate(() => navigator.clipboard.readText()) };
}

async function useCustomNotificationMenu(application: PlaywrightApplication, workbench: Workbench): Promise<void> {
	if (!('windows' in application)) return;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('layout');
	await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
	await workbench.page.getByRole('option', { name: 'Custom', exact: true }).click();
	await workbench.page.keyboard.press('Escape');
}

async function focusNotificationWindow(application: PlaywrightApplication, page: Page): Promise<void> {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	// OS keyboard delivery also requires activation of this isolated macOS application.
	if (process.platform === 'darwin') await application.evaluate(({ app }) => app.focus({ steal: true }));
	const window = await application.browserWindow(page);
	try { await window.evaluate(window => window.focus()); }
	finally { await window.dispose(); }
	await waitForElectronWindowState(application, page, { focused: true });
}

async function pressNotificationContextMenuKey(application: PlaywrightApplication, row: Locator): Promise<void> {
	if (!('windows' in application) || process.platform !== 'darwin') { await row.press('Shift+F10'); return; }
	const pid = application.process().pid;
	assert.ok(Number.isSafeInteger(pid));
	// Exercise AppKit's keyboard input when reopening a macOS system menu.
	// Renderer-injected keys do not enter the same OS event loop.
	await new Promise<void>((resolve, reject) => execFile('osascript', ['-e', `tell application "System Events"\n tell first application process whose unix id is ${pid}\n  key code 109 using {shift down}\n end tell\nend tell`], { timeout: 10_000 }, error => { if (error) reject(error); else resolve(); }));
}

for (const presentation of ['center', 'toast'] as const) {
	for (const input of ['mouse', 'ContextMenu', 'Shift+F10'] as const) {
		test(`notification ${presentation} Copy Text via ${input} writes the message through the host clipboard and retains history`, async ({ application, workbench }) => {
			const page = workbench.page;
			const clipboard = await notificationClipboard(application, page);
			await workbench.quickaccess.runCommand('notifications.clearAll');
			await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
			if (presentation === 'center') await workbench.quickaccess.runCommand('notifications.showList');
			const row = page.locator(`${presentation === 'center' ? '.ash-notifications-center' : '.ash-notification-host'} [data-notification-id]`);
			const id = await row.getAttribute('data-notification-id');
			const message = await row.locator('.ash-notification-message').textContent();
			await workbench.menus.select(application, async () => {
				await row.focus();
				if (input === 'mouse') await row.click({ button: 'right' });
				else await row.press(input);
			}, ['Copy Text']);
			await expect.poll(() => clipboard.read()).toBe(message);
			await expect(row).toHaveAttribute('data-notification-id', id!);
			await expect(row.getByRole('button', { name: 'Always Enable', exact: true })).toBeVisible();
			if (presentation === 'center') await expect(page.locator('.ash-notifications-center')).toBeVisible();
			else await expect(page.locator('.ash-notifications-center')).toBeHidden();
		});
	}
}

test('notification Copy Text reports the real browser clipboard permission rejection once', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ target, application, workbench }, testInfo) => {
	const page = workbench.page;
	await notificationClipboard(application, page);
	const session = await page.context().newCDPSession(page);
	const { targetInfo } = await session.send('Target.getTargetInfo');
	const browserContextId = targetInfo.browserContextId;
	assert.ok(browserContextId);
	try {
		await page.context().clearPermissions();
		// Browser-domain permission commands need the page's isolated context. Deny
		// both clipboard variants rather than retain the marker's read/write grant.
		for (const allowWithoutSanitization of [false, true]) {
			await session.send('Browser.setPermission', { browserContextId, permission: { name: 'clipboard-write', allowWithoutSanitization }, setting: 'denied', origin: new URL(page.url()).origin });
		}
		const permission = await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state);
		expect(permission).toBe('denied');
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('notifications.showList');
		const center = page.locator('.ash-notifications-center');
		const id = await center.locator('[data-notification-id]').first().getAttribute('data-notification-id');
		const row = center.locator(`[data-notification-id="${id}"]`);
		await row.focus();
		await row.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Copy Text', exact: true }).click();
		await expect(center.locator('[data-notification-id]')).toHaveCount(2);
		await expect(center.locator('.ash-notification-message').filter({ hasText: /denied|not allowed|permissions/i })).toHaveCount(1);
		await expect(row.getByRole('button', { name: 'Always Enable', exact: true })).toBeVisible();
		await testInfo.attach('notification-clipboard-permission', { body: JSON.stringify({ browserContextId, permission, messages: await center.locator('.ash-notification-message').allTextContents() }), contentType: 'application/json' });
	} finally {
		try { await page.context().clearPermissions(); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
		finally { await session.detach(); }
	}
});

test('notification Copy Text copies a real backend action error without its controls', async ({ application, workbench }) => {
	const page = workbench.page;
	const clipboard = await notificationClipboard(application, page);
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('notifications.showList');
	const failure = await blockConfigurationWrite(page, application);
	try {
		const center = page.locator('.ash-notifications-center');
		await center.getByRole('button', { name: 'Always Enable', exact: true }).click();
		const row = center.locator('[data-notification-id]').filter({ has: page.locator('.ash-notification-message').filter({ hasText: failure.message }) });
		await expect(row).toHaveCount(1);
		const message = await row.locator('.ash-notification-message').textContent();
		await workbench.menus.select(application, async () => { await row.focus(); await row.press('Shift+F10'); }, ['Copy Text']);
		await expect.poll(() => clipboard.read()).toBe(message);
		await expect(center.locator('[data-notification-id]')).toHaveCount(2);
		await failure.assertUnchanged();
	} finally {
		try { await failure.assertUnchanged(); } finally { await failure.dispose(); }
	}
});

test('notification Copy Text menu Escape restores the row before center Escape restores its origin', async ({ application, workbench }) => {
	const page = workbench.page;
	await useCustomNotificationMenu(application, workbench);
	const clipboard = await notificationClipboard(application, page);
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const origin = page.getByRole('button', { name: /^Show Notification Center/ });
	await origin.focus();
	await origin.press('Enter');
	const center = page.locator('.ash-notifications-center');
	const row = center.locator('[data-notification-id]');
	await row.focus();
	await row.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy Text', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(row).toBeFocused();
	await expect(center).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(center).toBeHidden();
	await expect(origin).toBeFocused();
	expect(await clipboard.read()).toBe('ash-notification-copy-fixture');
});

interface NotificationPopupEvidence {
	readonly windowId: number;
	readonly windowFocused: boolean;
	readonly windowVisible: boolean;
	readonly windowBounds: { x: number; y: number; width: number; height: number; } | undefined;
	readonly contentBounds: { x: number; y: number; width: number; height: number; } | undefined;
	readonly zoom: number | undefined;
	readonly x: number | undefined;
	readonly y: number | undefined;
	readonly positioningItem: number | undefined;
	readonly frameRoutingId: number | undefined;
	readonly labels: readonly string[];
	readonly popupOrder: number;
	popupReturnOrder?: number;
	showOrder?: number;
	closeEventOrder?: number;
	callback: boolean;
	callbackOrder?: number;
	closeCalls: number;
	closeRequestOrder?: number;
	closeReturnOrder?: number;
}

interface NotificationPopupProbe {
	readonly evidence: NotificationPopupEvidence[];
	readonly writes: { text: string; order: number; }[];
	restore(): void;
}

async function notificationPopupProbe(application: PlaywrightApplication): Promise<{ read(): Promise<Pick<NotificationPopupProbe, 'evidence' | 'writes'>>; restore(): Promise<void>; }> {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	await application.evaluate(({ Menu, clipboard, BrowserWindow }) => {
		const state = globalThis as typeof globalThis & { ashNotificationPopupProbe?: NotificationPopupProbe; };
		if (state.ashNotificationPopupProbe) throw new Error('Another notification popup probe is active');
		const popup = Menu.prototype.popup;
		const close = Menu.prototype.closePopup;
		const write = clipboard.writeText;
		const opened: { menu: InstanceType<typeof Menu>; window: Parameters<typeof close>[0]; record: NotificationPopupEvidence; removeListeners(): void; }[] = [];
		const evidence: NotificationPopupEvidence[] = [];
		const writes: NotificationPopupProbe['writes'] = [];
		let order = 0;
		Menu.prototype.popup = function (options) {
			const window = options?.window;
			const record: NotificationPopupEvidence = {
				windowId: window?.id ?? -1,
				windowFocused: window?.isFocused() ?? false,
				windowVisible: window?.isVisible() ?? false,
				windowBounds: window?.getBounds(),
				contentBounds: window?.getContentBounds(),
				zoom: window instanceof BrowserWindow ? window.webContents.getZoomFactor() : undefined,
				x: options?.x,
				y: options?.y,
				positioningItem: options?.positioningItem,
				frameRoutingId: options?.frame?.routingId,
				labels: this.items.map(item => item.label),
				popupOrder: ++order,
				callback: false,
				closeCalls: 0,
			};
			evidence.push(record);
			const show = (): void => { record.showOrder = ++order; };
			const closed = (): void => { record.closeEventOrder = ++order; };
			this.once('menu-will-show', show);
			this.once('menu-will-close', closed);
			opened.push({ menu: this, window: options?.window, record, removeListeners: () => { this.off('menu-will-show', show); this.off('menu-will-close', closed); } });
			// Keep the actual OS popup and callback; observing them must not settle the product request.
			try { return popup.call(this, { ...options, callback: () => { record.callbackOrder = ++order; record.callback = true; options?.callback?.(); } }); }
			finally { record.popupReturnOrder = ++order; }
		};
		Menu.prototype.closePopup = function (window) {
			const current = opened.find(item => item.menu === this);
			if (current) { current.record.closeCalls++; current.record.closeRequestOrder = ++order; }
			close.call(this, window);
			if (current) current.record.closeReturnOrder = ++order;
		};
		clipboard.writeText = function (text) {
			writes.push({ text, order: ++order });
			return write.call(this, text);
		};
		state.ashNotificationPopupProbe = {
			evidence, writes,
			restore() {
				Menu.prototype.popup = popup;
				Menu.prototype.closePopup = close;
				clipboard.writeText = write;
				for (const item of opened) {
					item.removeListeners();
					if (!item.record.callback) close.call(item.menu, item.window);
				}
				delete state.ashNotificationPopupProbe;
			},
		};
	});
	return {
		read: () => application.evaluate(() => {
			const { evidence, writes } = (globalThis as typeof globalThis & { ashNotificationPopupProbe: NotificationPopupProbe; }).ashNotificationPopupProbe;
			return { evidence, writes };
		}),
		restore: () => application.evaluate(() => (globalThis as typeof globalThis & { ashNotificationPopupProbe: NotificationPopupProbe; }).ashNotificationPopupProbe.restore()),
	};
}

macFocusTest('notification Copy Text selected in a genuine Electron popup writes after its OS callback', { tag: ['@electron-app-server', '@darwin'] }, async ({ target, application, workbench }, testInfo) => {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	test.skip(!await workbench.menus.isSystemMenu(application), 'Requires the system menu configuration.');
	const page = workbench.page;
	const clipboard = await notificationClipboard(application, page);
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('notifications.showList');
	const row = page.locator('.ash-notifications-center [data-notification-id]');
	const id = await row.getAttribute('data-notification-id');
	const message = await row.locator('.ash-notification-message').textContent();
	const probe = await notificationPopupProbe(application);
	try {
		await focusNotificationWindow(application, page);
		await row.focus();
		await pressNotificationContextMenuKey(application, row);
		await expect.poll(async () => (await probe.read()).evidence).toMatchObject([{ labels: ['Copy Text'], callback: false, closeCalls: 0 }]);
		const pid = application.process().pid;
		assert.ok(Number.isSafeInteger(pid));
		// Playwright's renderer key events do not drive the macOS popup. Send real
		// input only to this fixture's process and leave OS dispatch unchanged.
		await new Promise<void>((resolve, reject) => execFile('osascript', ['-e', `tell application "System Events"\n tell first application process whose unix id is ${pid}\n  set frontmost to true\n  key code 125\n  key code 36\n end tell\nend tell`], { timeout: 10_000 }, error => { if (error) reject(error); else resolve(); }));
		await expect.poll(() => clipboard.read()).toBe(message);
		const result = await probe.read();
		expect(result.evidence).toMatchObject([{ labels: ['Copy Text'], callback: true, closeCalls: 0 }]);
		expect(result.writes.map(write => write.text)).toEqual([message]);
		expect(result.evidence[0].callbackOrder).toBeLessThan(result.writes[0].order);
		await expect(row).toHaveAttribute('data-notification-id', id!);
		await expect(row.getByRole('button', { name: 'Always Enable', exact: true })).toBeVisible();
	} finally {
		try { await testInfo.attach('notification-real-popup-selection', { body: JSON.stringify(await probe.read()), contentType: 'application/json' }); }
		finally { await probe.restore(); }
	}
});

for (const waitForShow of [false, true]) {
	focusTest(`notification backend completion cancels a genuine Electron popup and releases the next presentation${waitForShow ? ' after its OS show event' : ''}`, { tag: ['@electron-app-server'] }, async ({ target, application, workbench }, testInfo) => {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		test.skip(!await workbench.menus.isSystemMenu(application), 'Requires the system menu configuration.');
		const page = workbench.page;
		const clipboard = await notificationClipboard(application, page);
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('notifications.showList');
		const failure = await blockConfigurationWrite(page, application);
		const probe = await notificationPopupProbe(application);
		const evidence = async () => (await probe.read()).evidence;
		try {
			const center = page.locator('.ash-notifications-center');
			const row = center.locator('[data-notification-id]').first();
			await focusNotificationWindow(application, page);
			await row.focus();
			await pressNotificationContextMenuKey(application, row);
			await expect.poll(async () => (await evidence()).length).toBe(1);
			// DOM click starts the real producer while the OS popup remains open. Its actual
			// failed persistence adds a record, replaces the anchor, and cancels this request.
			await row.getByRole('button', { name: 'Always Enable', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
			await expect(center.locator('.ash-notification-message').filter({ hasText: failure.message })).toHaveCount(1);
			await expect.poll(async () => (await evidence())[0]).toMatchObject({ labels: ['Copy Text'], callback: true, closeCalls: 1 });
			const nextRow = center.locator('[data-notification-id]').first();
			// Confirm ownership stayed with this window without reactivating the app between popups.
			await waitForElectronWindowState(application, page, { focused: true });
			await nextRow.focus();
			await pressNotificationContextMenuKey(application, nextRow);
			await expect.poll(async () => (await evidence()).length).toBe(2);
			if (waitForShow) await expect.poll(async () => Boolean((await evidence())[1].showOrder)).toBe(true);
			await center.getByRole('button', { name: 'Clear All', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
			await expect.poll(async () => (await evidence())[1]).toMatchObject({ labels: ['Copy Text'], callback: true, closeCalls: 1 });
			const records = await evidence();
			for (const record of records) expect(record.closeRequestOrder).toBeLessThan(record.callbackOrder!);
			expect(records[0].callbackOrder).toBeLessThan(records[1].popupOrder);
			expect(await clipboard.read()).toBe('ash-notification-copy-fixture');
			await failure.assertUnchanged();
		} finally {
			try {
				await testInfo.attach('notification-real-popup', { body: JSON.stringify(await probe.read()), contentType: 'application/json' });
			}
			finally {
				try {
					await probe.restore();
				}
				finally {
					try {
						await failure.assertUnchanged();
					} finally {
						await failure.dispose();
					}
				}
			}
		}
	});
}

test('notification copy menu cancellation preserves a genuine DialogService modal focus', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench }) => {
	const page = workbench.page;
	await useCustomNotificationMenu(application, workbench);
	expect(await workbench.menus.isSystemMenu(application)).toBe(false);
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('notifications.showList');
	const row = page.locator('.ash-notifications-center [data-notification-id]');
	await row.focus();
	await row.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy Text', exact: true })).toBeVisible();
	await workbench.quickaccess.open('>ash.extensions.installLocal');
	const command = workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('ash.extensions.installLocal', { exact: true }) });
	// Invoke the real command without an outside pointer event dismissing the menu first.
	await command.evaluate(option => (option as HTMLElement).click());
	const dialog = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await expect(dialog).toBeVisible();
	expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
	await expect(dialog.getByRole('textbox')).toBeFocused();
	await expect(page.getByRole('menu')).toHaveCount(1);
	await page.locator('.ash-notifications-clear').evaluate(button => (button as HTMLButtonElement).click());
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(dialog.getByRole('textbox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});

test('Sessions startup notification copies through its window clipboard after real keybindings read failure', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, application, workbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	const paths = await application.evaluate(({ app }) => ({ profile: process.env.ASH_HOME, userData: app.getPath('userData') }));
	assert.ok(paths.profile);
	const [profile, userData, temporaryRoot] = await Promise.all([realpath(paths.profile), realpath(paths.userData), realpath(tmpdir())]);
	assert.equal(relative(userData, profile), 'profile');
	assert.equal(relative(temporaryRoot, userData), basename(userData));
	assert.ok(basename(userData).startsWith('ash-'));
	const resource = join(profile, 'keybindings.json');
	const original = await readFile(resource).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
	await writeFile(resource, '[ invalid notification fixture');
	try {
		const page = await workbench.openAgentsWindow(target.kind);
		const clipboard = await notificationClipboard(application, page);
		await page.getByRole('button', { name: 'Show Notification Center', exact: true }).click();
		const row = page.locator('.ash-notifications-center [data-notification-id]').filter({ hasText: 'Could not load keybindings.json' });
		await expect(row).toHaveCount(1);
		const message = await row.locator('.ash-notification-message').textContent();
		await new Menus(page).select(application, async () => { await row.focus(); await row.press('Shift+F10'); }, ['Copy Text']);
		await expect.poll(() => clipboard.read()).toBe(message);
		await expect(row).toBeVisible();
	} finally {
		if (original) await writeFile(resource, original);
		else await rm(resource);
	}
});

test('notification toast Escape, Copy Text, help, and removal use the Chinese labels and retained history', async ({ workbench, application, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language', exact: true });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench, application } = await restartWorkbench());
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const toast = page.locator('.ash-notification-host').getByRole('button', { name: '移除通知', exact: true });
	await expect(toast).toBeVisible();
	const id = await toast.getAttribute('data-notification-close');
	const origin = page.getByRole('button', { name: /^显示通知中心/ });
	await origin.focus();
	await toast.focus();
	await page.keyboard.press('Escape');
	await expect(toast).toHaveCount(0);
	await expect(origin).toBeFocused();
	await origin.press('Enter');
	const center = page.getByRole('region', { name: '通知中心', exact: true });
	const row = center.locator(`[data-notification-id="${id}"]`);
	await expect(row).toBeVisible();
	const clipboard = await notificationClipboard(application, page);
	const message = await row.locator('.ash-notification-message').textContent();
	await workbench.menus.select(application, async () => { await row.focus(); await row.press('Shift+F10'); }, ['复制文本']);
	await expect.poll(() => clipboard.read()).toBe(message);
	await expect(row).toBeVisible();
	await workbench.quickaccess.runCommand('editor.action.accessibilityHelp');
	const help = page.getByRole('dialog', { name: '无障碍帮助', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/通知弹出提示或其中的操作获得焦点时，按 Escape 可收起弹出提示并保留通知历史。/);
	await expect(help.getByRole('textbox')).toHaveValue(/按菜单键或 Shift\+F10，然后选择复制文本，可复制通知消息。按 Escape 可关闭菜单并返回通知。/);
	await page.keyboard.press('Escape');
	await expect(center).toBeVisible();
	await center.getByRole('button', { name: '移除通知', exact: true }).click();
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.getByRole('heading', { name: '没有新通知', exact: true })).toBeVisible();
});

for (const useCenter of [false, true]) {
	test(`notification ${useCenter ? 'center' : 'toast'} action failure reports the real settings write error`, async ({ workbench, application, driver }, testInfo) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		if (useCenter) await workbench.quickaccess.runCommand('notifications.showList');
		const surface = page.locator(useCenter ? '.ash-notifications-center' : '.ash-notification-host');
		const original = surface.getByRole('button', { name: 'Always Enable', exact: true });
		await expect(original).toBeVisible();
		const failure = await blockConfigurationWrite(page, application);
		try {
			await original.click();
			const errors = surface.locator('.ash-notification-message').filter({ hasText: failure.message });
			// The old implementation logs the same real rejection. Wait for that boundary,
			// then require the shared notification model to expose it to the user.
			await expect.poll(async () => (await errors.allTextContents()).some(message => message.includes(failure.message))
				|| driver.diagnostics.consoleErrors.some(message => message.includes(failure.message))).toBe(true);
			await failure.assertUnchanged();
			await testInfo.attach('notification-action-failure', {
				body: JSON.stringify({
					view: useCenter ? 'center' : 'toast', expectedError: failure.message,
					errorMessages: await errors.allTextContents(), consoleErrors: driver.diagnostics.consoleErrors,
				}), contentType: 'application/json'
			});
			await expect(errors).toHaveCount(1);
			await expect(errors).toContainText(failure.message);
			await expect(original).toBeVisible();
			await workbench.quickaccess.runCommand('notifications.showList');
			await expect(page.locator('.ash-notifications-center [data-notification-id]')).toHaveCount(2);
			expect(driver.diagnostics.consoleErrors.filter(message => message.includes(failure.message))).toEqual([]);
		} finally {
			try { await failure.assertUnchanged(); } finally { await failure.dispose(); }
		}
	});
}

async function blockConfigurationWrite(page: Page, application: PlaywrightApplication): Promise<{ message: string; assertUnchanged(): Promise<void>; dispose(): Promise<void>; }> {
	const message = 'Injected settings file write failure';
	const original = await readUserSettings(page);
	if (!('windows' in application)) {
		await page.evaluate(message => {
			const store = IDBObjectStore.prototype;
			const put = store.put;
			const state = globalThis as typeof globalThis & { restoreSettingsWrite(): void; };
			state.restoreSettingsWrite = () => { store.put = put; delete (state as Partial<typeof state>).restoreSettingsWrite; };
			store.put = function (value, key) {
				if (this.name === 'files' && key === 'ash-userdata:/user/settings.json') throw new Error(message);
				return put.call(this, value, key);
			};
		}, message);
		return {
			message,
			async assertUnchanged() { expect(await readUserSettings(page)).toEqual(original); },
			async dispose() { await page.evaluate(() => (globalThis as typeof globalThis & { restoreSettingsWrite(): void; }).restoreSettingsWrite()); },
		};
	}
	await application.evaluate(async (_electron, { message, resource }) => {
		const files = await import('node:fs/promises');
		const { fileURLToPath } = await import('node:url');
		const { syncBuiltinESMExports } = await import('node:module');
		const settings = fileURLToPath(resource);
		const write = files.default.writeFile;
		const state = globalThis as typeof globalThis & { restoreSettingsWrite(): void; };
		state.restoreSettingsWrite = () => {
			files.default.writeFile = write;
			syncBuiltinESMExports();
			delete (state as Partial<typeof state>).restoreSettingsWrite;
		};
		files.default.writeFile = async (...args: Parameters<typeof write>) => {
			if (typeof args[0] === 'string' && args[0].startsWith(settings + '.') && args[0].endsWith('.tmp')) throw new Error(message);
			return write(...args);
		};
		syncBuiltinESMExports();
	}, { message, resource: original.resource });
	return {
		message,
		async assertUnchanged() { expect(await readUserSettings(page)).toEqual(original); },
		async dispose() { await application.evaluate(() => (globalThis as typeof globalThis & { restoreSettingsWrite(): void; }).restoreSettingsWrite()); },
	};
}

test('notification status shows unread and do not disturb icons and restores the filter after restart', async ({ application, workbench, reloadWorkbench }, testInfo) => {
	let page = workbench.page;
	const bellSelector = '[data-statusbar-item-id="ash.status.notifications"] [role="button"]';
	const startupGeometry = await page.locator(bellSelector).evaluate(element => {
		const part = element.closest('[data-part="statusbar"]')!;
		const bar = part.getBoundingClientRect();
		const bell = element.getBoundingClientRect();
		return {
			direction: getComputedStyle(part).flexDirection,
			icon: element.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'),
			stylesheets: [...document.styleSheets].map((sheet, index) => ({ href: sheet.href, index })).filter(sheet => /(?:statusbarpart|\/media\/part)\.css/.test(sheet.href ?? '')),
			inside: bell.top >= bar.top && bell.bottom <= bar.bottom && bell.left >= bar.left && bell.right <= bar.right,
			hit: element.contains(document.elementFromPoint(bell.x + bell.width / 2, bell.y + bell.height / 2)),
		};
	});
	await testInfo.attach('startup-statusbar-state', { body: JSON.stringify(startupGeometry), contentType: 'application/json' });
	expect(startupGeometry).toMatchObject({ direction: 'row', icon: 'bell', inside: true, hit: true });
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await expect(page.locator(bellSelector)).toBeVisible();
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-dot');
	await page.locator(bellSelector).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
	await workbench.menus.select(application, () => page.getByRole('button', { name: 'Configure Do Not Disturb...', exact: true }).click(), ['Enable Do Not Disturb Mode']);
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-slash');
	await page.keyboard.press('Escape');
	await expect(page.locator(bellSelector)).toBeFocused();
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-slash-dot');
	await expect(page.locator('.ash-notification')).toHaveCount(0);
	await page.locator(bellSelector).click();
	await expect(page.locator('.ash-notifications-row')).toHaveCount(2);
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.locator(bellSelector)).toBeVisible();
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-slash');
	await workbench.quickaccess.runCommand('notifications.toggleDoNotDisturbMode');
	await expect(page.locator(bellSelector).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
});

test('notification position menus move the entry between the status bar and title bar and persist after reload', async ({ application, workbench, reloadWorkbench }, testInfo) => {
	let page = workbench.page;
	const bell = '[data-statusbar-item-id="ash.status.notifications"] [role="button"]';
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await page.locator(bell).click();
	const center = () => page.getByRole('region', { name: 'Notification Center', exact: true });
	const menu = () => page.getByRole('button', { name: 'Configure Notifications Position...', exact: true });
	await workbench.menus.select(application, () => menu().click(), ['Bottom Left']);
	await expect(page.locator('.ash-statusbar-items-left').locator(bell)).toBeVisible();
	await expect(center()).toHaveAttribute('data-position', 'bottom-left');
	await workbench.menus.select(application, () => menu().click(), ['Top Right']);
	await expect(page.locator(bell)).toHaveCount(0);
	const titleBell = () => page.getByRole('button', { name: 'Toggle Notifications', exact: true });
	await expect(titleBell()).toBeVisible();
	const bounds = await center().boundingBox();
	const titleBounds = await page.locator('[data-part="titlebar"]').boundingBox();
	expect(bounds!.y).toBeGreaterThanOrEqual(titleBounds!.y + titleBounds!.height);
	await titleBell().click();
	await expect(center()).toBeHidden();
	await titleBell().focus();
	await page.keyboard.press('Enter');
	await expect(center()).toBeVisible();
	await testInfo.attach('notification-top-right', { body: await page.screenshot(), contentType: 'image/png' });
	const settings = await readUserSettings(page);
	expect(JSON.parse(settings.content)['workbench.notifications.position']).toBe('top-right');
	({ application, workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(titleBell()).toBeVisible();
	await expect(page.locator(bell)).toHaveCount(0);
	await titleBell().click();
	await expect(center()).toHaveAttribute('data-position', 'top-right');
	await workbench.menus.select(application, () => menu().click(), ['Bottom Right']);
	await expect(page.locator('.ash-statusbar-items-right').locator(bell)).toBeVisible();
	await expect(titleBell()).toHaveCount(0);
});

macFocusTest('notification ordinary toast expires into unread history in the real Workbench', async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	if ('windows' in application) await focusNotificationWindow(application, page);
	else await page.bringToFront();
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const toast = page.locator('.ash-notification');
	await expect(toast).toBeVisible();
	const id = await toast.getAttribute('data-notification-id');
	const message = await toast.locator('.ash-notification-message').textContent();
	const bell = page.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
	await page.mouse.move(0, 0);
	await bell.focus();
	await testInfo.attach('ordinary-toast-before-timeout', { body: await page.screenshot(), contentType: 'image/png' });
	await expect(toast).toHaveCount(0, { timeout: 16000 });
	await expect(bell).toBeFocused();
	await expect(bell.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-dot');
	await bell.click();
	await expect(page.locator(`.ash-notifications-row[data-notification-id="${id}"] .ash-notification-message`)).toHaveText(message!);
	await expect(bell.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
	await testInfo.attach('ordinary-toast-retained-history', { body: await page.screenshot(), contentType: 'image/png' });
});
