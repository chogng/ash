import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rmdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { Workbench } from '../../../automation/workbench.js';
import { expect, test } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';

test('notification dismiss chrome stays quiet with visible keyboard focus in all themes', async ({ workbench, application }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	await expect(page.locator('.ash-agent-trace')).toBeVisible();
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const toast = page.locator('.ash-notification').last();
		const close = toast.getByRole('button', { name: 'Remove notification', exact: true });
		await expect(close).toBeVisible();
		await testInfo.attach(`${theme}-toast`, { body: await page.screenshot(), contentType: 'image/png' });
		const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, theme: document.querySelector('[data-color-theme]')?.getAttribute('data-color-theme'), devicePixelRatio, width: innerWidth, height: innerHeight }));
		const zoom = 'windows' in application ? await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()) : 1;
		await testInfo.attach(`${theme}-environment`, { body: JSON.stringify({ ...environment, zoom, platform: process.platform }), contentType: 'application/json' });
		expect(await close.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
		await close.focus();
		expect(await close.evaluate(element => { const style = getComputedStyle(element); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0; })).toBe(true);
		await expect(toast.locator('.ash-notification-severity svg')).toHaveCount(1);
		await close.press('Enter');
		await expect(toast).toHaveCount(0);
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

for (const input of ['mouse', 'ContextMenu', 'Shift+F10'] as const) {
	test(`notification Copy Text via ${input} writes the message through the host clipboard and retains history`, async ({ application, workbench }) => {
		const page = workbench.page;
		const clipboard = await notificationClipboard(application, page);
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('notifications.showList');
		const row = page.locator('.ash-notifications-center [data-notification-id]');
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
		await expect(page.locator('.ash-notifications-center')).toBeVisible();
	});
}

test('notification Copy Text reports the real browser clipboard permission rejection once', async ({ target, application, workbench }, testInfo) => {
	test.skip(target.kind !== 'browser', 'Chromium owns the real browser clipboard permission boundary.');
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
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
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

test('notification Copy Text selected in a genuine Electron popup writes after its OS callback', async ({ target, application, workbench }, testInfo) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || process.platform !== 'darwin', 'Uses macOS input targeted at the owned Electron process.');
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
	test(`notification backend completion cancels a genuine Electron popup and releases the next presentation${waitForShow ? ' after its OS show event' : ''}`, async ({ target, application, workbench }, testInfo) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the real desktop host and backend.');
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
			try { await testInfo.attach('notification-real-popup', { body: JSON.stringify(await probe.read()), contentType: 'application/json' }); }
			finally {
				try { await probe.restore(); }
				finally { try { await failure.assertUnchanged(); } finally { await failure.dispose(); } }
			}
		}
	});
}

test('notification copy menu cancellation preserves a genuine DialogService modal focus', async ({ target, application, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the production extension installation input dialog.');
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

test('Sessions startup notification copies through its window clipboard after real keybindings read failure', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'Uses the isolated desktop profile and independent Sessions window.');
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

test('clearing one notification toast updates the center while hiding toasts retains other records', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(2);
	const removedId = await buttons.first().getAttribute('data-notification-close');
	const retainedId = await buttons.last().getAttribute('data-notification-close');
	await buttons.first().click();
	await expect(page.locator(`[data-notification-close="${removedId}"]`)).toHaveCount(0);
	await expect(page.locator(`[data-notification-close="${retainedId}"]`)).toBeVisible();

	await workbench.quickaccess.runCommand('notifications.showList');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	await expect(center.locator(`[data-notification-id="${removedId}"]`)).toHaveCount(0);
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await workbench.quickaccess.runCommand('notifications.hideList');
	await expect(buttons).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await center.getByRole('button', { name: 'Clear All', exact: true }).click();
	await expect(center).toBeHidden();
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
});

test('keyboard clearing moves between notification toasts and restores focus after the last record', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	for (let index = 0; index < 3; index++) {
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	}
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(3);
	const ids = await buttons.evaluateAll(elements => elements.map(element => (element as HTMLButtonElement).dataset.notificationClose!));
	const close = (index: number) => page.locator(`[data-notification-close="${ids[index]}"]`);
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await close(1).focus();
	await page.keyboard.press('Enter');
	await expect(close(1)).toHaveCount(0);
	await expect(close(2)).toBeFocused();
	await page.keyboard.press('Space');
	await expect(close(2)).toHaveCount(0);
	await expect(close(0)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(buttons).toHaveCount(0);
	await expect(origin).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true }).getByText('No notifications', { exact: true })).toBeVisible();
});

for (const control of ['action', 'remove'] as const) {
	test(`toast Escape ${control === 'remove' ? 'from a focused remove restores focus' : 'leaves a focused action unchanged'}, preserves history, and permits a new toast`, async ({ workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const surface = page.locator('.ash-notification-host');
		const ids = await surface.locator('[data-notification-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-notification-id')));
		expect(ids).toHaveLength(2);
		const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
		await origin.focus();
		const target = surface.locator(`[data-notification-id="${ids[0]}"]`).getByRole('button', { name: control === 'action' ? 'Always Enable' : 'Remove notification', exact: true });
		await target.focus();
		await surface.evaluate(element => {
			// Observe after the presentation's listener without changing event handling.
			element.addEventListener('keydown', event => {
				(element as HTMLElement).dataset.testEscapeConsumed = String(event.defaultPrevented);
			}, { once: true });
		});
		await page.keyboard.press('Escape');
		await expect(surface).toHaveAttribute('data-test-escape-consumed', String(control === 'remove'));
		await expect(surface.locator('.ash-notification')).toHaveCount(control === 'remove' ? 0 : 2);
		await expect(control === 'remove' ? origin : target).toBeFocused();
		if (control === 'remove') await origin.press('Enter');
		else await workbench.quickaccess.runCommand('notifications.showList');
		const center = page.getByRole('region', { name: 'Notification Center', exact: true });
		await expect(center.locator('[data-notification-id]')).toHaveCount(2);
		for (const id of ids) await expect(center.locator(`[data-notification-id="${id}"]`)).toBeVisible();
		await workbench.quickaccess.runCommand('notifications.hideList');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await expect(surface.locator('.ash-notification')).toHaveCount(1);
		const nextId = await surface.locator('[data-notification-id]').getAttribute('data-notification-id');
		expect(ids).not.toContain(nextId);
		await workbench.quickaccess.runCommand('notifications.showList');
		await expect(center.locator('[data-notification-id]')).toHaveCount(3);
		await expect(center.locator(`[data-notification-id="${nextId}"]`)).toBeVisible();
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await workbench.quickaccess.runCommand('editor.action.accessibilityHelp');
		await expect(help.getByRole('textbox')).toHaveValue(/When the Remove notification button in a toast has focus, press Escape to hide the toasts without removing them from history\./);
		await page.keyboard.press('Escape');
		await expect(help).toBeHidden();
		await expect(center).toBeVisible();
	});
}

for (const unavailable of ['display', 'visibility'] as const) {
	test(`toast Escape preserves history without restoring an origin hidden by CSS ${unavailable}`, async ({ workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
		await origin.focus();
		const target = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
		const id = await target.getAttribute('data-notification-close');
		await target.focus();
		// A hidden origin leaves the accessibility tree, so retain its identity for cleanup.
		const originElement = await origin.elementHandle();
		assert.ok(originElement);
		await originElement.evaluate((element, property) => (element as HTMLElement).style.setProperty(property, property === 'display' ? 'none' : 'hidden'), unavailable);
		try {
			await page.keyboard.press('Escape');
			await expect(page.locator('.ash-notification-host .ash-notification')).toHaveCount(0);
			expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
			await workbench.quickaccess.runCommand('notifications.showList');
			await expect(page.locator(`.ash-notifications-center [data-notification-id="${id}"]`)).toBeVisible();
		} finally {
			await originElement.evaluate((element, property) => (element as HTMLElement).style.removeProperty(property), unavailable);
		}
	});
}

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
	const origin = page.getByRole('button', { name: '显示通知中心', exact: true });
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
	await expect(help.getByRole('textbox')).toHaveValue(/通知弹出提示的移除通知按钮获得焦点时，按 Escape 可收起弹出提示并保留通知历史。/);
	await expect(help.getByRole('textbox')).toHaveValue(/按菜单键或 Shift\+F10，然后选择复制文本，可复制通知消息。按 Escape 可关闭菜单并返回通知。/);
	await page.keyboard.press('Escape');
	await expect(center).toBeVisible();
	await center.getByRole('button', { name: '移除通知', exact: true }).click();
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.getByText('没有通知', { exact: true })).toBeVisible();
});

test('center keyboard removal keeps other records open and restores focus after the last row', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await origin.press('Enter');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	const rows = center.locator('[data-notification-id]');
	await expect(rows).toHaveCount(2);
	const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-notification-id')));
	const row = (index: number) => center.locator(`[data-notification-id="${ids[index]}"]`);
	await row(0).focus();
	await page.keyboard.press('Delete');
	await expect(row(0)).toHaveCount(0);
	await expect(center).toBeVisible();
	await expect(row(1)).toBeFocused();
	await page.keyboard.press('Delete');
	await expect(center).toBeHidden();
	await expect(origin).toBeFocused();
	await page.keyboard.press('Delete');
	await expect(origin).toBeFocused();
	await origin.press('Enter');
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
});

for (const useCommand of [false, true]) {
	test(`Clear All ${useCommand ? 'command' : 'toolbar'} closes the center and restores focus`, async ({ workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
		await origin.focus();
		await origin.press('Enter');
		const center = page.getByRole('region', { name: 'Notification Center', exact: true });
		await expect(center.locator('[data-notification-id]')).toHaveCount(2);
		if (useCommand) {
			await workbench.quickaccess.runCommand('notifications.clearAll');
		} else {
			await center.getByRole('button', { name: 'Clear All', exact: true }).focus();
			await page.keyboard.press('Space');
		}
		await expect(center).toBeHidden();
		await expect(origin).toBeFocused();
		await origin.press('Enter');
		await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
		await expect(center.getByRole('button', { name: 'Clear All', exact: true })).toBeDisabled();
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await expect(center).toBeHidden();
		await expect(origin).toBeFocused();
	});
}

test('a notification arriving in an explicitly opened empty center keeps the center open', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await origin.press('Enter');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await expect(center).toBeVisible();
	await expect(center.locator('[data-notification-id]')).toHaveCount(1);
	await expect(page.locator('.ash-notification-host .ash-notification')).toHaveCount(0);
	await center.getByRole('button', { name: 'Remove notification', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(center).toBeHidden();
	await expect(origin).toBeFocused();
});

test('clearing the last toast tolerates its previous focus control being removed', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await page.evaluate(() => {
		const origin = document.createElement('button');
		origin.id = 'notification-test-focus-origin';
		origin.textContent = 'Notification focus origin';
		document.body.append(origin);
	});
	const origin = page.getByRole('button', { name: 'Notification focus origin', exact: true });
	await origin.focus();
	const remove = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await remove.focus();
	await origin.evaluate(element => element.remove());
	await page.keyboard.press('Enter');
	await expect(remove).toHaveCount(0);
	await expect(page.locator('#notification-test-focus-origin')).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true }).getByText('No notifications', { exact: true })).toBeVisible();
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

for (const scenario of [
	{ control: 'action', change: 'add', count: 2, focusedIndex: 1 },
	{ control: 'remove', change: 'add', count: 2, focusedIndex: 1 },
	{ control: 'action', change: 'remove', count: 2, focusedIndex: 1 },
	{ control: 'remove', change: 'remove', count: 2, focusedIndex: 1 },
	{ control: 'action', change: 'add', count: 3, focusedIndex: 1 },
	{ control: 'remove', change: 'add', count: 3, focusedIndex: 0 },
] as const) {
	test(`toast focus ${scenario.count === 3 && scenario.focusedIndex === 0 ? 'is not restored to an evicted' : 'stays on a retained'} ${scenario.control} when backend completion ${scenario.change}s a record with ${scenario.count} toasts`, async ({ workbench, application }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		for (let index = 0; index < scenario.count; index++) await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const surface = page.locator('.ash-notification-host');
		const ids = await surface.locator('[data-notification-close]').evaluateAll(elements => elements.map(element => (element as HTMLButtonElement).dataset.notificationClose!));
		expect(ids).toHaveLength(scenario.count);
		const toast = (id: string) => surface.locator(`.ash-notification:has([data-notification-close="${id}"])`);
		const focusedId = ids[scenario.focusedIndex];
		const target = scenario.control === 'remove' ? toast(focusedId).getByRole('button', { name: 'Remove notification', exact: true }) : toast(focusedId).getByRole('button', { name: 'Always Enable', exact: true });
		const triggeringId = ids[scenario.count - 1 === scenario.focusedIndex ? 0 : scenario.count - 1];
		const trigger = toast(triggeringId).getByRole('button', { name: 'Always Enable', exact: true });
		const failure = scenario.change === 'add' ? await blockConfigurationWrite(page, application) : undefined;
		try {
			// The real action is deferred. Focus the other control before its backend
			// completion adds an error or lets the producer close its own record.
			await page.evaluate(({ button, focus }) => {
				if (!(button instanceof HTMLButtonElement) || !(focus instanceof HTMLElement)) throw new Error('Expected visible toast controls');
				button.click();
				focus.focus();
			}, { button: await trigger.elementHandle(), focus: await target.elementHandle() });
			if (failure) {
				await expect(surface.locator('.ash-notification-message').filter({ hasText: failure.message })).toHaveCount(1);
				await failure.assertUnchanged();
			} else {
				await expect(toast(triggeringId)).toHaveCount(0);
			}
			const evicted = scenario.count === 3 && scenario.focusedIndex === 0;
			if (evicted) {
				await expect(target).toHaveCount(0);
				expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
			} else {
				await expect(target).toBeFocused();
			}
			await expect(surface.locator('.ash-notification')).toHaveCount(Math.min(3, scenario.count + (failure ? 1 : -1)));
			await workbench.quickaccess.runCommand('notifications.showList');
			const center = page.locator('.ash-notifications-center');
			await expect(center.locator('[data-notification-id]')).toHaveCount(scenario.count + (failure ? 1 : -1));
			await expect(center.locator(`[data-notification-id="${focusedId}"]`)).toHaveCount(1);
		} finally {
			if (failure) { try { await failure.assertUnchanged(); } finally { await failure.dispose(); } }
		}
	});
}

interface StoredConfiguration {
	key: 'settings.json';
	revision: number;
	document: { version: 1; source: string; };
}

async function browserConfiguration(page: Page, operation: 'block' | 'read' | 'restore', original?: StoredConfiguration | null): Promise<StoredConfiguration | null> {
	return page.evaluate(async ({ operation, original }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const opening = indexedDB.open('ash-configuration', 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		try {
			return await new Promise<StoredConfiguration | null>((resolve, reject) => {
				const transaction = database.transaction('resources', operation === 'read' ? 'readonly' : 'readwrite');
				const store = transaction.objectStore('resources');
				const request = store.get('settings.json');
				let stored: StoredConfiguration | null;
				request.onsuccess = () => {
					stored = request.result ?? null;
					if (operation === 'block') {
						// No broadcast: the real renderer retains its revision and the real
						// IndexedDB compare-and-swap rejects its subsequent write.
						store.put({
							key: 'settings.json', revision: (stored?.revision ?? 0) + 1,
							document: stored?.document ?? { version: 1, source: '{}\n' }
						});
					} else if (operation === 'restore') {
						if (original) store.put(original);
						else store.delete('settings.json');
					}
				};
				transaction.oncomplete = () => resolve(stored);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, { operation, original });
}

async function blockConfigurationWrite(page: Page, application: PlaywrightApplication): Promise<{ message: string; assertUnchanged(): Promise<void>; dispose(): Promise<void>; }> {
	if (!('windows' in application)) {
		// Each browser fixture owns a fresh BrowserContext, including this database.
		const original = await browserConfiguration(page, 'block');
		const expected = {
			key: 'settings.json', revision: (original?.revision ?? 0) + 1,
			document: original?.document ?? { version: 1, source: '{}\n' }
		};
		return {
			message: `Configuration revision conflict: expected ${expected.revision - 1}, actual ${expected.revision}`,
			async assertUnchanged() { expect(await browserConfiguration(page, 'read')).toEqual(expected); },
			async dispose() {
				await browserConfiguration(page, 'restore', original);
				expect(await browserConfiguration(page, 'read')).toEqual(original);
			},
		};
	}
	const processProfile = await application.evaluate(({ app }) => ({ pid: process.pid, profile: process.env.ASH_HOME, userData: app.getPath('userData') }));
	assert.ok(processProfile.profile);
	const [profile, userData, temporaryRoot] = await Promise.all([realpath(processProfile.profile), realpath(processProfile.userData), realpath(tmpdir())]);
	assert.equal(relative(userData, profile), 'profile');
	assert.equal(relative(temporaryRoot, userData), basename(userData));
	assert.ok(basename(userData).startsWith('ash-'));
	const settings = join(profile, 'settings.json');
	const blocker = `${settings}.${processProfile.pid}.tmp`;
	const original = await page.evaluate(() => globalThis.ashTestMainProcess.call('configuration', 'read'));
	const source = await readFile(settings).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
	// Exclusive mkdir never replaces an existing file or directory. The owner writes
	// this exact temporary path before rename; rmdir only removes our empty blocker.
	await mkdir(blocker);
	return {
		message: 'EISDIR',
		async assertUnchanged() {
			expect(await page.evaluate(() => globalThis.ashTestMainProcess.call('configuration', 'read'))).toEqual(original);
			assert.deepEqual(await readFile(settings).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }), source);
		},
		async dispose() { await rmdir(blocker); },
	};
}
