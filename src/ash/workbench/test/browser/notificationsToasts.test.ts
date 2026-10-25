import { expectIconFontLoaded } from '../../../../../test/automation/iconFonts.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { PendingNotificationToasts } from '../../browser/parts/notifications/pendingNotificationToasts.js';

test('pending notification work is cancelled before rendering removed records, hidden surfaces, or disposed windows', () => {
	const callbacks: (() => void)[] = [];
	const current = new Set([1, 2, 3]);
	const rendered: number[] = [];
	let cancelled = 0;
	using pending = new PendingNotificationToasts<number>(item => current.has(item), callback => {
		callbacks.push(callback);
		return toDisposable(() => { cancelled++; });
	});
	const render = (item: number, resources: DisposableStore): void => { rendered.push(item); resources.dispose(); };
	pending.add(1, render);
	pending.add(2, render);
	pending.remove(1);
	current.delete(2);
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	assert.equal(cancelled, 2);
	pending.add(3, render);
	pending.clear();
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	pending.add(3, render);
	pending.dispose();
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	assert.equal(cancelled, 4);
});

test('a stale toast callback cannot consume replacement work, and rendering transfers its resource lifetime', () => {
	const callbacks: (() => void)[] = [];
	const rendered: string[] = [];
	using accepted = new DisposableStore();
	using pending = new PendingNotificationToasts<string>(() => true, callback => {
		callbacks.push(callback);
		return toDisposable(() => { });
	});
	pending.add('same', (_item, resources) => { resources.dispose(); assert.fail('Replaced work rendered'); });
	pending.add('same', (item, resources) => { rendered.push(item); accepted.add(resources); });
	callbacks[0]();
	assert.deepEqual(rendered, []);
	callbacks[1]();
	assert.deepEqual(rendered, ['same']);
	let released = false;
	accepted.add(toDisposable(() => { released = true; }));
	pending.clear();
	assert.equal(released, false);
	accepted.dispose();
	assert.equal(released, true);
});

test('a synchronous toast scheduler and a failed renderer release their cancellation resources', () => {
	let cancelled = 0;
	using immediate = new PendingNotificationToasts<number>(() => true, callback => {
		callback();
		return toDisposable(() => { cancelled++; });
	});
	immediate.add(1, (_item, resources) => resources.dispose());
	assert.equal(cancelled, 1);
	const callbacks: (() => void)[] = [];
	using queued = new PendingNotificationToasts<number>(() => true, callback => {
		callbacks.push(callback);
		return toDisposable(() => { cancelled++; });
	});
	queued.add(2, () => { throw new Error('Rendering failed'); });
	assert.throws(callbacks[0], /Rendering failed/);
	assert.equal(cancelled, 2);
});

suite('notifications browser component', () => {
	const browserTests = useBrowserTests();
	for (const registerAfterPart of [false, true]) {
		test(`startup notification bell survives late base Part styles with registration ${registerAfterPart ? 'after' : 'before'} the statusbar`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/notifications.html${registerAfterPart ? '?registerAfterPart' : ''}`);
			await page.evaluate(() => window.ashNotificationsIntegration.loadBasePartStylesLast());
			const statusbar = page.locator('[data-part="statusbar"]');
			const bell = page.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
			await expect(bell.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
			const geometry = await bell.evaluate(element => {
				const bar = element.closest<HTMLElement>('[data-part="statusbar"]')!;
				const bounds = bar.getBoundingClientRect();
				const target = element.getBoundingClientRect();
				return {
					direction: getComputedStyle(bar).flexDirection,
					bar: bounds.toJSON(),
					bell: target.toJSON(),
					inside: target.left >= bounds.left && target.right <= bounds.right && target.top >= bounds.top && target.bottom <= bounds.bottom,
					hit: element.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)),
				};
			});
			await testInfo.attach('startup-statusbar-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
			await testInfo.attach('startup-statusbar', { body: await page.screenshot(), contentType: 'image/png' });
			await expect(statusbar).toHaveCSS('flex-direction', 'row');
			expect(geometry.inside).toBe(true);
			expect(geometry.hit).toBe(true);
			expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
			await bell.click();
			await expect(page.getByRole('region', { name: 'Notification Center', exact: true })).toBeVisible();
		});
	}

	test('duplicate bursts produce one toast and retain only the replacement in history', async function () {
		const { page } = browserTests;
		await page.goto('/notifications.html');
		const ids = await page.evaluate(() => Array.from({ length: 15 }, () => window.ashNotificationsIntegration.notifyOptions('Repeated notification')));
		await expect(page.locator('.ash-notification')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([ids.at(-1)]);
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		await expect(page.locator('.ash-notifications-row')).toHaveCount(1);
		await expect(page.locator('.ash-notifications-row')).toBeFocused();
	});

	test('notification details share expansion between toast and center and follow position changes', async function () {
		const { page } = browserTests;
		for (const language of ['', '?zh']) {
			await page.goto(`/notifications.html${language}`);
			await page.evaluate(() => window.ashNotificationsIntegration.notifyOptions('Long notification message '.repeat(30)));
			const toast = page.locator('.ash-notification');
			const expandLabel = language ? '展开通知' : 'Expand Notification';
			const collapseLabel = language ? '收起通知' : 'Collapse Notification';
			await expect(toast.locator('.ash-notification-message')).toHaveCSS('white-space', 'nowrap');
			await toast.getByRole('button', { name: expandLabel, exact: true }).click();
			await expect(toast.getByRole('button', { name: collapseLabel, exact: true })).toHaveAttribute('aria-expanded', 'true');
			await expect(toast.locator('.ash-notification-message')).toHaveCSS('white-space', 'pre-wrap');
			await page.evaluate(() => window.ashNotificationsIntegration.show());
			const row = page.locator('.ash-notifications-row');
			await expect(row).toBeFocused();
			await expect(row.getByRole('button', { name: collapseLabel, exact: true })).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('ArrowLeft');
			await expect(row.getByRole('button', { name: expandLabel, exact: true })).toHaveAttribute('aria-expanded', 'false');
			await page.keyboard.press('Enter');
			await expect(row).toHaveClass(/expanded/);
			await page.keyboard.press('Space');
			await expect(row).not.toHaveClass(/expanded/);
			await page.evaluate(() => window.ashNotificationsIntegration.setPosition('top-right' as import('../../common/notifications.js').NotificationsPosition));
			const hide = page.locator('.ash-notifications-hide .ash-icon');
			await expect(hide).toHaveAttribute('data-ash-icon-id', 'chevron-up');
			await expect(row.getByRole('button', { name: expandLabel, exact: true }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'chevron-down');
			await row.getByRole('button', { name: expandLabel, exact: true }).click();
			await expect(row.getByRole('button', { name: collapseLabel, exact: true })).toBeFocused();
			await page.evaluate(() => window.ashNotificationsIntegration.setPosition('bottom-right' as import('../../common/notifications.js').NotificationsPosition));
			await expect(hide).toHaveAttribute('data-ash-icon-id', 'chevron-down');
			await browserTests.info.attach(`expanded-${language ? 'zh' : 'en'}`, { body: await page.screenshot(), contentType: 'image/png' });
		}
	});

	test('notification rows navigate, dismiss adjacent rows and protect active progress', async function () {
		const { page } = browserTests;
		await page.goto('/notifications.html');
		const ids = await page.evaluate(() => {
			const ids = ['First', 'Second', 'Third'].map(message => window.ashNotificationsIntegration.notifyOptions(message));
			window.ashNotificationsIntegration.show();
			return ids;
		});
		const rows = page.locator('.ash-notifications-row');
		await expect(rows.nth(0)).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press('Delete');
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(1)).toBeFocused();
		await expect(rows.nth(1)).toHaveAttribute('data-notification-id', String(ids[0]));
		await page.keyboard.press('Home');
		await expect(rows.nth(0)).toBeFocused();
		await page.keyboard.press('End');
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(rows.nth(0)).toBeFocused();
		await rows.nth(0).click({ button: 'middle' });
		await expect(rows).toHaveCount(1);
		await page.evaluate(() => window.ashNotificationsIntegration.startProgress());
		const progress = rows.filter({ has: page.getByRole('progressbar') });
		await progress.focus();
		await page.keyboard.press('Delete');
		await progress.click({ button: 'middle' });
		await expect(progress).toBeVisible();
		await expect(rows).toHaveCount(2);
		await page.evaluate(() => window.ashNotificationsIntegration.finishProgress());
		await expect(progress).toHaveCount(0);
		await page.evaluate(() => window.ashNotificationsIntegration.notify('Action notification'));
		await rows.first().focus();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.actionRuns)).toBe(1);
	});

	test('empty notification center shows its state only in the title and keeps read history visible', async function () {
		const { page } = browserTests;
		for (const language of ['', '?zh']) {
			await page.goto(`/notifications.html${language}`);
			await page.evaluate(() => window.ashNotificationsIntegration.show());
			const center = page.locator('.ash-notifications-center');
			const title = center.getByRole('heading');
			const header = center.locator('.ash-notifications-center-header');
			const clear = header.getByRole('button', { name: language ? '全部清除' : 'Clear All', exact: true });
			const emptyTitle = language ? '没有新通知' : 'No New Notifications';
			await expect(title).toHaveText(emptyTitle);
			await expect(clear).toBeDisabled();
			await expect(center.getByRole('listitem')).toHaveCount(0);
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
				const bounds = (await center.boundingBox())!;
				const headerBounds = (await header.boundingBox())!;
				expect(bounds.height).toBe(headerBounds.height + 2);
				await browserTests.info.attach(`empty-center-${language ? 'zh' : 'en'}-theme-${theme}`, { body: await center.screenshot(), contentType: 'image/png' });
			}
			const id = await page.evaluate(() => window.ashNotificationsIntegration.notify('Retained notification'));
			await expect(title).toHaveText(language ? '通知' : 'Notifications');
			await expect(clear).toBeEnabled();
			await expect(center.getByRole('listitem')).toHaveCount(1);
			await page.evaluate(() => {
				window.ashNotificationsIntegration.hide();
				window.ashNotificationsIntegration.show();
			});
			await expect(title).toHaveText(language ? '通知' : 'Notifications');
			await expect(center.getByRole('listitem')).toHaveText(/Retained notification/);
			await page.evaluate(id => window.ashNotificationsIntegration.remove(id), id);
			await expect(center).toBeHidden();
			await page.evaluate(() => window.ashNotificationsIntegration.show());
			await expect(title).toHaveText(emptyTitle);
			await expect(clear).toBeDisabled();
			await expect(center.getByRole('listitem')).toHaveCount(0);
		}
	});

	test('notification center uses a continuous list and a compact keyboard toolbar across themes and languages', async function () {
		const { page } = browserTests;
		for (const language of ['', '?zh']) {
			await page.goto(`/notifications.html${language}`);
			await page.evaluate(() => {
				window.ashNotificationsIntegration.notify('First notification');
				window.ashNotificationsIntegration.notify('Second notification');
				window.ashNotificationsIntegration.show();
			});
			const center = page.locator('.ash-notifications-center');
			const header = center.locator('.ash-notifications-center-header');
			const toolbar = header.getByRole('toolbar');
			const buttons = toolbar.getByRole('button');
			await expect(buttons).toHaveCount(4);
			await expect(buttons.nth(0)).toHaveAccessibleName(language ? '全部清除' : 'Clear All');
			await expect(buttons.nth(0).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'clear-all');
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
				const rows = center.locator('.ash-notifications-row');
				await expect(header).toHaveCSS('height', '36px');
				await expect(center.locator('.ash-notifications-list')).toHaveCSS('padding', '0px');
				await expect(rows.first()).toHaveCSS('border-radius', '0px');
				await expect(rows.first()).toHaveCSS('border-width', '0px');
				await expect(rows.nth(1)).toHaveCSS('border-top-width', '1px');
				const bounds = await rows.evaluateAll(elements => elements.map(element => {
					const { x, y, width, height } = element.getBoundingClientRect();
					return { x, y, width, height };
				}));
				expect(bounds[0].x).toBe(bounds[1].x);
				expect(bounds[0].width).toBe(bounds[1].width);
				expect(bounds[0].y + bounds[0].height).toBe(bounds[1].y);
				for (const button of await buttons.all()) {
					await expect(button).toHaveCSS('width', '22px');
					await expect(button).toHaveCSS('height', '22px');
					await expect(button).toHaveCSS('box-sizing', 'border-box');
					await expect(button.locator('.ash-icon-label-container')).toBeHidden();
				}
				await browserTests.info.attach(`center-${language ? 'zh' : 'en'}-theme-${theme}`, { body: await center.screenshot(), contentType: 'image/png' });
			}
			await buttons.nth(0).focus();
			await page.keyboard.press('ArrowRight');
			await expect(buttons.nth(1)).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'true');
			await expect(page.getByRole('menu')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(buttons.nth(1)).toBeFocused();
			await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'false');
			await page.keyboard.press('ArrowRight');
			await expect(buttons.nth(2)).toBeFocused();
			await page.keyboard.press('End');
			await expect(buttons.nth(3)).toBeFocused();
			await page.keyboard.press('Home');
			await expect(buttons.nth(0)).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(center).toBeHidden();
			expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
		}
	});

	test('notification rows share standard controls, preserve focus, and fit narrow themed surfaces', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.setViewportSize({ width: 360, height: 480 });
		await page.goto('/notifications.html');
		await page.evaluate(() => window.ashNotificationsIntegration.notify('A long notification with a URL https://example.test/very/long/path/without/spaces and another line\nSecond line'));
		const toast = page.locator('.ash-notification');
		const close = toast.getByRole('button', { name: 'Remove notification', exact: true });
		await expect(close).toBeVisible();
		await expect(page.locator('.ash-notifications-toggle')).toHaveCount(0);
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
			await page.mouse.move(0, 0);
			await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(close).toHaveCSS('width', '22px');
			await expect(close).toHaveCSS('height', '22px');
			await expect(close).toHaveCSS('border-top-width', '0px');
			expect(await close.boundingBox()).toMatchObject({ width: 22, height: 22 });
			await expect(close.locator('.ash-icon')).toHaveCount(1);
			await expect(toast).toHaveCSS('border-radius', '8px');
			await expect(toast.getByRole('button', { name: 'Run action', exact: true })).toHaveCSS('min-height', '28px');
			const geometry = await toast.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				const close = element.querySelector('.ash-notification-close')!.getBoundingClientRect();
				const message = element.querySelector('.ash-notification-message')!.getBoundingClientRect();
				return { width: bounds.width, messageBeforeClose: message.right <= close.left, closeInside: close.right <= bounds.right && close.top >= bounds.top, border: getComputedStyle(element).borderTopColor };
			});
			expect(geometry.width).toBeLessThanOrEqual(420);
			expect(geometry.messageBeforeClose).toBe(true);
			expect(geometry.closeInside).toBe(true);
			if (theme >= 2) expect(geometry.border).toBe(theme === 2 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
			expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await close.hover();
			await expect(close).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await toast.getByRole('button', { name: 'Run action', exact: true }).focus();
			await page.keyboard.press('Tab');
			await expect(close).toBeFocused();
			await expect(close).toHaveCSS('outline-style', 'solid');
			await expect(close).toHaveCSS('outline-width', '1px');
			await testInfo.attach(`theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
		}
		const id = await toast.getAttribute('data-notification-id');
		await page.evaluate(() => window.ashNotificationsIntegration.notify('Another notification'));
		await expect(page.locator('.ash-notification')).toHaveCount(2);
		await expect(page.locator(`[data-notification-close="${id}"]`)).toBeFocused();
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		await page.evaluate(() => window.ashNotificationsIntegration.notify('Arrival with hidden toasts'));
		await expect(page.locator('.ash-aria-status').filter({ hasText: 'Arrival with hidden toasts' })).toHaveCount(1);
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		const row = page.locator(`.ash-notifications-row[data-notification-id="${id}"]`);
		await row.getByRole('button', { name: 'Run action', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.actionRuns)).toBe(1);
		await row.getByRole('button', { name: 'Remove notification', exact: true }).click();
		await expect(row).toHaveCount(0);
		await expect(page.locator('.ash-notifications-row')).toHaveCount(2);
		await page.evaluate(() => window.ashNotificationsIntegration.clear());
		await expect(page.locator('.ash-notifications-center')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
		await page.evaluate(() => {
			const origin = document.createElement('button');
			origin.textContent = 'Notification focus origin';
			document.body.append(origin);
		});
		const origin = page.getByRole('button', { name: 'Notification focus origin', exact: true, includeHidden: true });
		for (const property of ['display', 'visibility'] as const) {
			await origin.focus();
			const id = await page.evaluate(() => window.ashNotificationsIntegration.notify('Retain history without restoring hidden focus'));
			await page.locator(`[data-notification-close="${id}"]`).focus();
			await origin.evaluate((element, property) => element.style.setProperty(property, property === 'display' ? 'none' : 'hidden'), property);
			try {
				await page.keyboard.press('Escape');
				await expect(page.locator('.ash-notification')).toHaveCount(0);
				expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
				expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([id]);
			} finally {
				await origin.evaluate((element, property) => element.style.removeProperty(property), property);
				await page.evaluate(() => window.ashNotificationsIntegration.clear());
			}
		}
		await origin.evaluate(element => element.remove());
	});

	test('scheduled toasts are cancelled on removal and center opening while a rapid burst retains only three controls', async function () {
		const { page } = browserTests;

		await page.goto('/notifications.html');
		await page.evaluate(() => {
			const fixture = window.ashNotificationsIntegration;
			const id = fixture.notify('Removed before its frame');
			fixture.remove(id);
			fixture.notify('Hidden before its frame');
			fixture.show();
		});
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await expect(page.locator('.ash-notifications-row')).toHaveCount(1);
		await page.evaluate(() => {
			window.ashNotificationsIntegration.hide();
			for (let index = 0; index < 8; index++) window.ashNotificationsIntegration.notify(`Burst ${index}`);
		});
		await expect(page.locator('.ash-notification')).toHaveCount(3);
		await expect(page.locator('.ash-notification .ash-notification-message')).toHaveText(['Burst 7', 'Burst 6', 'Burst 5']);
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history().length)).toBe(9);
	});

	test('extension messages retain source, primary choices and a working configuration menu on both surfaces', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.setViewportSize({ width: 600, height: 480 });
		await page.goto('/notifications.html');
		await page.evaluate(() => window.ashNotificationsIntegration.extensionMessage(['Show Git Output', 'Retry']));
		const toast = page.locator('.ash-notification');
		await expect(toast.getByRole('img', { name: 'Error', exact: true })).toBeVisible();
		await expect(toast.locator('.ash-notification-severity .ash-icon')).toHaveAttribute('data-ash-icon-id', 'error');
		await expect(toast.locator('.ash-notification-source')).toHaveText('Source: Git');
		await expect(toast.getByRole('button', { name: 'Show Git Output', exact: true })).toHaveClass(/ash-button-primary/);
		await expect(toast.getByRole('button', { name: 'Retry', exact: true })).toHaveClass(/ash-button-secondary/);
		const configure = toast.getByRole('button', { name: 'More Actions', exact: true });
		await expect(configure.locator('[data-ash-icon-id="gear"]')).toBeVisible();
		await configure.focus();
		await page.keyboard.press('ArrowDown');
		await expect(configure).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('menuitem', { name: 'Manage Extension', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.managed)).toEqual({ query: 'fixture.git' });
		await expect(toast).toBeVisible();
		await testInfo.attach('extension-toast', { body: await page.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		const row = page.locator('.ash-notifications-row');
		await expect(row.locator('.ash-notification-source')).toHaveText('Source: Git');
		await row.getByRole('button', { name: 'More Actions', exact: true }).click();
		await expect(page.getByRole('menuitem', { name: 'Manage Extension', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menuitem', { name: 'Manage Extension', exact: true })).toHaveCount(0);
		await expect(page.locator('.ash-notifications-center')).toBeVisible();
		await row.getByRole('button', { name: 'Show Git Output', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.selection)).toBe(0);
		await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
	});

	test('severity icons and source/menu labels use the Chinese catalog and fit narrow themes', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.setViewportSize({ width: 360, height: 640 });
		await page.goto('/notifications.html?zh');
		await page.evaluate(() => {
			window.ashNotificationsIntegration.notify('信息消息', 1);
			window.ashNotificationsIntegration.notify('警告消息', 2);
			window.ashNotificationsIntegration.extensionMessage(['显示 Git 输出']);
		});
		const toasts = page.locator('.ash-notification');
		await expect(toasts).toHaveCount(3);
		for (const [index, id] of ['info', 'warning', 'error'].entries()) {
			const toast = page.locator(`.ash-notification[data-severity="${id}"]`);
			await expect(toast.locator('.ash-notification-severity .ash-icon')).toHaveAttribute('data-ash-icon-id', id);
			await expect(toast.getByRole('img')).toHaveAttribute('aria-label', ['信息', '警告', '错误'][index]);
		}
		const error = page.locator('.ash-notification[data-severity="error"]');
		await expect(error.locator('.ash-notification-source')).toHaveText('来源：Git');
		await expect(error.getByRole('button', { name: '更多操作', exact: true })).toBeVisible();
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
			for (const toast of await toasts.all()) {
				expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
				await expect(toast.locator('.ash-notification-severity .ash-icon')).toBeVisible();
			}
			await testInfo.attach(`severity-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
		}
		await error.getByRole('button', { name: '更多操作', exact: true }).click();
		await expect(page.getByRole('menuitem', { name: '管理扩展', exact: true })).toBeVisible();
	});

	for (const locale of ['en', 'zh']) {
		test(`Agents invitation records a visible row and preserves its draft until acknowledgement (${locale})`, async function () {
			const { page } = browserTests;

			await page.clock.install();
			await page.goto(`/notifications.html${locale === 'zh' ? '?zh' : ''}`);
			await page.evaluate(() => window.ashNotificationsIntegration.invite());
			await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.invitation().sessions[0]?.inProgress)).toBe(true);
			expect(await page.evaluate(() => window.ashNotificationsIntegration.invitation().lastShown)).toBeUndefined();
			await page.clock.fastForward(30_000);
			await page.clock.runFor(32);
			const toast = page.locator('.ash-notification');
			const label = locale === 'zh' ? '在智能体窗口中继续' : 'Continue in Agents Window';
			const action = toast.getByRole('button', { name: label, exact: true });
			await expect(action).toBeVisible();
			await expect(toast.locator('.ash-notification-message')).toHaveText(locale === 'zh' ? '在智能体窗口中继续，统一查看各个项目的智能体对话。' : 'Continue in the Agents Window to keep track of your agent conversations across projects.');
			await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.invitation().lastShown?.editorSessionCount)).toBe(1);
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
				await action.focus();
				await expect(action).toBeFocused();
				await expect(action).toHaveCSS('outline-style', 'solid');
				expect(await toast.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			}
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.openRequests)).toBe(1);
			expect(await page.evaluate(() => window.ashNotificationsIntegration.draftCleared)).toBe(0);
			await expect(toast).toBeVisible();
			await page.evaluate(() => window.ashNotificationsIntegration.acknowledgeHandoff());
			await expect.poll(() => page.evaluate(() => window.ashNotificationsIntegration.draftCleared)).toBe(1);
			await expect(toast).toHaveCount(0);
		});
	}

	test('notification history insertion, removal before a frame and hidden DOM do not report presentation', async function () {
		const { page } = browserTests;

		await page.clock.install();
		await page.goto('/notifications.html');
		await page.evaluate(() => {
			const fixture = window.ashNotificationsIntegration;
			const removed = fixture.notify('Removed before presentation', undefined, true);
			fixture.remove(removed);
			fixture.notify('Hidden presentation', undefined, true);
			document.querySelector<HTMLElement>('.ash-workbench')!.style.display = 'none';
		});
		await page.clock.runFor(32);
		expect(await page.evaluate(() => window.ashNotificationsIntegration.presented())).toEqual([]);
		await page.evaluate(() => {
			window.ashNotificationsIntegration.clear();
			document.querySelector<HTMLElement>('.ash-workbench')!.style.display = '';
			window.ashNotificationsIntegration.notify('Visible presentation', undefined, true);
		});
		await page.clock.runFor(32);
		await expect(page.locator('.ash-notification')).toBeVisible();
		expect(await page.evaluate(() => window.ashNotificationsIntegration.presented())).toEqual(['Visible presentation']);
	});

	test('notification bell stays visible at rest and projects unread and do not disturb states in every theme', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/notifications.html?zh');
		const bell = page.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
		const icon = bell.locator('.ash-icon');
		await expect(bell).toBeVisible();
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell');
		await page.evaluate(() => window.ashNotificationsIntegration.notify('未读通知'));
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell-dot');
		await expect(bell).toHaveAttribute('aria-label', /1 条新通知/);
		await bell.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('region', { name: '通知中心', exact: true })).toBeVisible();
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell');
		const toggle = page.locator('.ash-notifications-center [aria-pressed]');
		await toggle.focus();
		await page.keyboard.press('Space');
		await page.getByRole('menuitem', { name: '启用勿扰模式', exact: true }).click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell-slash');
		await page.keyboard.press('Escape');
		await expect(bell).toBeFocused();
		await page.evaluate(() => window.ashNotificationsIntegration.notify('静默通知'));
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell-slash-dot');
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashNotificationsIntegration.theme(index), theme);
			await expect(icon).toHaveCSS('width', '16px');
			await expect(icon).toHaveCSS('height', '16px');
			await expectIconFontLoaded(icon);
			await expect(icon.locator('svg')).toHaveCount(0);
			const glyph = await icon.evaluate(element => {
				const style = getComputedStyle(element, '::before');
				return {
					color: style.color, foreground: getComputedStyle(element).color,
					content: style.content, character: element.getAttribute('data-ash-icon-character'),
					visibility: style.visibility,
				};
			});
			expect(glyph.content).toBe(`"${glyph.character}"`);
			expect(glyph.visibility).toBe('visible');
			expect(glyph.color).toBe(glyph.foreground);
			await testInfo.attach(`bell-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
		}
		await page.evaluate(() => window.ashNotificationsIntegration.notify('错误通知', 3));
		await expect(page.locator('.ash-notification .ash-notification-message')).toHaveText('错误通知');
		await bell.click();
		await expect(page.locator('.ash-notifications-row')).toHaveCount(3);
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell-slash');
		await page.getByRole('button', { name: '配置勿扰模式...', exact: true }).click();
		await page.getByRole('menuitem', { name: '禁用勿扰模式', exact: true }).click();
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'bell');
	});

	test('source menus silence only the selected producer and the complete source picker commits or cancels', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/notifications.html');
		await page.evaluate(() => {
			window.ashNotificationsIntegration.sourceNotify('Compiler info', 'compiler', 'Compiler');
			window.ashNotificationsIntegration.sourceNotify('Git info', 'git', 'Git');
		});
		const compiler = page.locator('.ash-notification').filter({ hasText: 'Compiler info' });
		await compiler.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: "Turn Off Info and Warning Notifications from 'Compiler'", exact: true }).click();
		await expect(compiler).toHaveCount(0);
		await expect(page.locator('.ash-notification')).toHaveCount(1);
		await page.evaluate(() => {
			window.ashNotificationsIntegration.sourceNotify('Compiler warning', 'compiler', 'Compiler', 2);
			window.ashNotificationsIntegration.sourceNotify('Compiler error', 'compiler', 'Compiler', 3);
		});
		await expect(page.locator('.ash-notification')).toHaveCount(2);
		await expect(page.locator('.ash-notification').filter({ hasText: 'Compiler error' })).toBeVisible();
		await page.evaluate(() => {
			window.ashNotificationsIntegration.show();
			for (let i = 0; i < 10; i++) window.ashNotificationsIntegration.sourceNotify(`Source ${i} message`, `source-${i}`, `Source ${i}`);
		});
		const configure = page.getByRole('button', { name: 'Configure Do Not Disturb...', exact: true });
		await configure.focus();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Compiler', exact: true })).toHaveAttribute('aria-checked', 'false');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Git', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('menuitem', { name: 'More...', exact: true }).click();
		const picker = page.getByRole('dialog', { name: 'Select sources to enable all notifications from', exact: true });
		await expect(picker.getByRole('option')).toHaveCount(12);
		await picker.getByRole('combobox').fill('Compiler');
		await picker.getByRole('option').click();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		expect((await page.evaluate(() => window.ashNotificationsIntegration.filters())).find(source => source.id === 'compiler')?.filter).toBe(0);
		await page.evaluate(() => window.ashNotificationsIntegration.command('notifications.toggleDoNotDisturbModeBySource'));
		await picker.getByRole('combobox').fill('Git');
		await picker.getByRole('option').click();
		await page.keyboard.press('Escape');
		expect((await page.evaluate(() => window.ashNotificationsIntegration.filters())).find(source => source.id === 'git')?.filter).toBe(0);
		await testInfo.attach('source-configuration', { body: await page.screenshot(), contentType: 'image/png' });
	});

	test('position menu moves existing notifications, preserves history and transfers the bell to the title bar', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.setViewportSize({ width: 640, height: 480 });
		await page.goto('/notifications.html');
		await page.evaluate(() => window.ashNotificationsIntegration.notify('Position fixture'));
		const center = page.locator('.ash-notifications-center');
		const statusBell = page.locator('[data-statusbar-item-id="ash.status.notifications"]');
		const titleBell = page.getByRole('button', { name: 'Toggle Notifications', exact: true });
		const id = await page.locator('.ash-notification').getAttribute('data-notification-id');
		for (const [label, value] of [['Bottom Left', 'bottom-left'], ['Top Right', 'top-right'], ['Bottom Right', 'bottom-right']] as const) {
			await page.evaluate(() => window.ashNotificationsIntegration.show());
			await page.getByRole('button', { name: 'Configure Notifications Position...', exact: true }).focus();
			await page.keyboard.press('ArrowDown');
			await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
			await expect(center).toHaveAttribute('data-position', value);
			if (value === 'top-right') {
				await expect(statusBell).toHaveCount(0);
				await expect(titleBell).toBeVisible();
				await titleBell.click();
				await expect(center).toBeHidden();
				await titleBell.click();
			} else {
				await expect(statusBell).toHaveCount(1);
				await expect(titleBell).toHaveCount(0);
				await expect(statusBell.locator('..')).toHaveClass(value === 'bottom-left' ? /left/ : /right/);
			}
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(theme => window.ashNotificationsIntegration.theme(theme), theme);
				const rect = await center.boundingBox();
				expect(rect).not.toBeNull();
				expect(rect!.x).toBeGreaterThanOrEqual(0);
				expect(rect!.x + rect!.width).toBeLessThanOrEqual(640);
				if (value === 'top-right') expect(rect!.y).toBe(43);
				if (value === 'bottom-left') expect(rect!.x).toBe(12);
				await testInfo.attach(`${value}-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
			}
		}
		expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([Number(id)]);
		await page.evaluate(() => window.ashNotificationsIntegration.setPosition('top-right' as import('../../common/notifications.js').NotificationsPosition));
		await page.evaluate(() => window.ashNotificationsIntegration.configure('workbench.notifications.showInTitleBar', false));
		await expect(titleBell).toHaveCount(0);
		await page.evaluate(() => window.ashNotificationsIntegration.hide());
		await page.evaluate(() => window.ashNotificationsIntegration.notify('Top-right toast'));
		const toast = page.locator('.ash-notification');
		await expect(toast).toBeVisible();
		expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(43);
	});

	test('progress survives clear commands, moves to the status bar when hidden, and removes every hint on completion', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/notifications.html');
		await page.evaluate(() => window.ashNotificationsIntegration.startProgress());
		const toast = page.locator('.ash-notification');
		await expect(toast.getByRole('progressbar')).toBeVisible();
		await expect(toast.getByRole('button', { name: 'Remove notification', exact: true })).toHaveCount(0);
		await page.evaluate(() => window.ashNotificationsIntegration.reportProgress());
		await expect(toast.getByRole('progressbar')).toHaveAttribute('value', '0.25');
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		const row = page.locator('.ash-notifications-row');
		await row.focus();
		await page.keyboard.press('Delete');
		await expect(row).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Clear All', exact: true })).toBeDisabled();
		await page.evaluate(() => window.ashNotificationsIntegration.clear());
		const progress = page.locator('[data-statusbar-item-id="status.progress"] [role="button"]');
		await expect(progress).toHaveText('Indexing fixture: Reading files');
		const bell = page.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
		await expect(bell.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-dot');
		await expect(bell).toHaveAttribute('aria-label', /No New Notifications \(1 in progress\)/);
		await testInfo.attach('hidden-running-progress', { body: await page.screenshot(), contentType: 'image/png' });
		await progress.click();
		await expect(row).toBeVisible();
		await expect(progress).toHaveCount(0);
		await row.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(row).toHaveCount(0);
		await expect(bell.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell');
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		await page.evaluate(() => window.ashNotificationsIntegration.startProgress(2));
		await expect(toast).toHaveCount(0);
		await expect(row).toBeVisible();
		await expect(progress).toHaveCount(0);
		await page.evaluate(() => window.ashNotificationsIntegration.hide());
		await expect(progress).toBeVisible();
		await page.evaluate(() => window.ashNotificationsIntegration.finishProgress());
		await expect(progress).toHaveCount(0);
	});

	test('transient status messages replace one another without creating notification history', async function () {
		const { page } = browserTests;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/notifications.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:00:05Z'));
		const status = page.locator('[data-statusbar-item-id="status.message"]');
		await page.evaluate(() => window.ashNotificationsIntegration.status('Delayed message', 100, 400));
		await page.clock.runFor(99);
		await expect(status).toHaveCount(0);
		await page.clock.runFor(1);
		await expect(status).toHaveText('Delayed message');
		await page.evaluate(() => window.ashNotificationsIntegration.status('Replacement'));
		await page.clock.runFor(1);
		await expect(status).toHaveText('Replacement');
		await page.clock.runFor(450);
		await expect(status).toHaveText('Replacement');
		expect(await page.evaluate(() => window.ashNotificationsIntegration.history())).toEqual([]);
	});

	test('toast timeouts use severity intervals and leave notification history unread', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/notifications.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:00:05Z'));
		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			window.ashNotificationsIntegration.notifyOptions('Information', 1);
			window.ashNotificationsIntegration.notifyOptions('Warning', 2);
			window.ashNotificationsIntegration.notifyOptions('Error', 3);
		});
		await page.clock.runFor(20);
		await expect(page.locator('.ash-notification')).toHaveCount(3);
		await page.clock.fastForward(10001);
		await expect(page.locator('.ash-notification')).toHaveCount(2);
		await page.clock.fastForward(2000);
		await expect(page.locator('.ash-notification .ash-notification-message')).toHaveText('Error');
		await page.clock.fastForward(3000);
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await expect(page.locator('[data-statusbar-item-id="ash.status.notifications"] .ash-icon')).toHaveAttribute('data-ash-icon-id', 'bell-dot');
		await page.evaluate(() => window.ashNotificationsIntegration.show());
		await expect(page.locator('.ash-notifications-row')).toHaveCount(3);
		await testInfo.attach('expired-toasts-retain-history', { body: await page.screenshot(), contentType: 'image/png' });
	});

	test('hovered and focused toasts survive expiry and regain a full interval after window focus returns', async function () {
		const { page } = browserTests;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/notifications.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:00:05Z'));
		await page.evaluate(() => window.ashNotificationsIntegration.notifyOptions('Reading'));
		await page.clock.runFor(20);
		const toast = page.locator('.ash-notification');
		await toast.hover();
		await page.clock.fastForward(10001);
		await expect(toast).toBeVisible();
		await page.mouse.move(0, 0);
		await toast.focus();
		await page.clock.fastForward(10001);
		await expect(toast).toBeFocused();
		await page.evaluate(() => {
			const origin = document.createElement('button');
			origin.textContent = 'Reading origin'; document.body.append(origin); origin.focus();
			window.ashNotificationsIntegration.setHostFocus(false);
		});
		await page.clock.fastForward(10001);
		await expect(toast).toBeVisible();
		await page.evaluate(() => window.ashNotificationsIntegration.setHostFocus(true));
		await page.clock.fastForward(9999);
		await expect(toast).toBeVisible();
		await page.clock.fastForward(2);
		await expect(toast).toHaveCount(0);
	});

	test('progress toast Escape preserves the task, exposes hidden progress, and reports cumulative work correctly', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/notifications.html');
		await page.evaluate(() => window.ashNotificationsIntegration.startProgress());
		const toast = page.locator('.ash-notification');
		await expect(toast).toBeVisible();
		await page.evaluate(() => { window.ashNotificationsIntegration.reportProgress(); window.ashNotificationsIntegration.reportProgress(); });
		await expect(toast.getByRole('progressbar')).toHaveAttribute('value', '0.5');
		await toast.getByRole('button', { name: 'Cancel', exact: true }).focus();
		await page.keyboard.press('Escape');
		await expect(toast).toHaveCount(0);
		const status = page.locator('[data-statusbar-item-id="status.progress"] [role="button"]');
		await expect(status).toBeVisible();
		expect(await page.evaluate(() => window.ashNotificationsIntegration.history().length)).toBe(1);
		await status.click();
		await expect(page.locator('.ash-notifications-row').getByRole('progressbar')).toHaveAttribute('value', '0.5');
		await testInfo.attach('progress-escape-retains-task', { body: await page.screenshot(), contentType: 'image/png' });
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.locator('.ash-notifications-row')).toHaveCount(0);
	});

	test('toast rows have themed keyboard focus in light, dark and both high contrast themes', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/notifications.html');
		await page.evaluate(() => {
			const origin = document.createElement('button');
			origin.textContent = 'Toast keyboard origin';
			origin.style.cssText = 'position: fixed; top: 0; left: 0';
			document.body.prepend(origin);
			window.ashNotificationsIntegration.notifyOptions('Keyboard notification');
		});
		const toast = page.locator('.ash-notification');
		await expect(toast).toBeVisible();
		const origin = page.getByRole('button', { name: 'Toast keyboard origin', exact: true });
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(theme => window.ashNotificationsIntegration.theme(theme), theme);
			await origin.focus(); await page.keyboard.press('Tab');
			await expect(toast).toBeFocused();
			await expect(toast).toHaveCSS('outline-style', 'solid');
			await expect(toast).toHaveCSS('outline-width', '1px');
			await expect(toast).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
			await testInfo.attach(`toast-keyboard-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
		}
		await page.keyboard.press('Escape');
		await expect(toast).toHaveCount(0);
		await expect(origin).toBeFocused();
	});

	for (const [position, left, top] of [['bottom-right', 500, 380], ['bottom-left', 20, 380], ['top-right', 500, 60]] as const) {
		test(`optional ${position} toast does not cover the active input and remains in history`, async function () {
			const { page } = browserTests;

			await page.setViewportSize({ width: 640, height: 480 });
			await page.goto('/notifications.html');
			await page.evaluate(async ({ position, left, top }) => {
				await window.ashNotificationsIntegration.configure('workbench.notifications.position', position);
				const input = document.createElement('textarea');
				input.setAttribute('aria-label', 'Active notification input');
				input.style.cssText = `position: absolute; left: ${left}px; top: ${top}px; width: 80px; height: 30px`;
				document.querySelector('main')!.append(input); input.focus();
				window.ashNotificationsIntegration.notifyOptions('Optional information', 1, 1);
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			}, { position, left, top });
			await expect(page.locator('.ash-notification')).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Active notification input', exact: true })).toBeFocused();
			expect(await page.evaluate(() => window.ashNotificationsIntegration.history().length)).toBe(1);
			await page.evaluate(() => window.ashNotificationsIntegration.notifyOptions('Default information'));
			await expect(page.locator('.ash-notification .ash-notification-message')).toHaveText('Default information');
		});
	}
});
