import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('Menu browser behavior', () => {
	const browser = useBrowserTests();
	const open = async (kind: Parameters<Window['ashMenuTest']['mount']>[0]): Promise<void> => {
		await browser.page.goto('/src/ash/base/test/browser/fixtures/menu.html');
		await browser.page.evaluate(kind => window.ashMenuTest.mount(kind), kind);
	};

	test('updates state, modifier labels and shortcuts in place and keeps Tab in a standalone menu', async () => {
		await open('basic');
		const primary = browser.page.locator('[data-action-id="primary"] > button');
		await expect(primary).toBeFocused();
		await expect(primary).toContainText('Ctrl+P');
		await browser.page.keyboard.down('Alt');
		await expect(primary).toHaveAccessibleName('Alternate');
		await expect(primary).toContainText('Ctrl+A');
		await browser.page.keyboard.press('Enter');
		await browser.page.keyboard.up('Alt');
		await expect(primary).toHaveAccessibleName('Primary');
		await browser.page.evaluate(() => window.ashMenuTest.update());
		await expect(primary).toHaveAccessibleName('Updated');
		await expect(primary).toHaveAttribute('aria-checked', 'true');
		await browser.page.keyboard.press('Tab');
		await expect(primary).toBeFocused();
		await browser.page.evaluate(() => window.ashMenuTest.disable());
		await expect(browser.page.locator('[data-action-id="after"] > button')).toBeFocused();
		assert.deepEqual(await browser.page.evaluate(() => window.ashMenuTest.state().calls), [{ id: 'alternate', context: { version: 1 } }]);
	});

	test('propagates providers, radio descriptions, context changes and keyboard event context through nested menus', async () => {
		await open('nested');
		await browser.page.locator('[data-action-id="first"] > button').click();
		const choice = browser.page.getByRole('menuitemradio', { name: 'Choice', exact: true });
		await expect(choice).toHaveAccessibleDescription('Details for choice');
		await expect(choice).toHaveAttribute('aria-checked', 'false');
		await browser.page.evaluate(() => window.ashMenuTest.context());
		await choice.click();
		assert.deepEqual(await browser.page.evaluate(() => window.ashMenuTest.state().calls), [{ id: 'choice', context: { version: 2 } }]);
		assert.ok((await browser.page.evaluate(() => window.ashMenuTest.state().providers)).includes('choice'));
		await browser.page.evaluate(() => window.ashMenuTest.mount('event'));
		await browser.page.keyboard.press('Enter');
		assert.deepEqual(await browser.page.evaluate(() => window.ashMenuTest.state().calls), [{ id: 'primary', context: { type: 'keydown' } }]);
	});

	test('keeps a clamped submenu open and closes it when the native parent actually scrolls', async () => {
		await open('long');
		await browser.page.evaluate(() => { window.ashMenuTest.focus(12); window.ashMenuTest.trigger(12); });
		const row = browser.page.locator('[data-action-id="first"] > button');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		const viewport = browser.page.locator('#host > .ash-menu');
		await viewport.hover({ position: { x: 90, y: 110 } });
		const before = await browser.page.evaluate(() => window.ashMenuTest.state().offset!);
		assert.ok(before > 0);
		await browser.page.mouse.wheel(0, 150);
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await browser.page.mouse.wheel(0, -100);
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		assert.ok((await browser.page.evaluate(() => window.ashMenuTest.state().offset!)) < before);
		assert.ok((await browser.page.evaluate(() => window.ashMenuTest.state().scrolls)).some(event => event.topChanged));
	});

	test('opens styled, unanimated menus in a transformed shadow root and releases its adopted stylesheet', async () => {
		await open('shadow');
		await browser.page.locator('[data-action-id="first"] > button').click();
		const choice = browser.page.getByRole('menuitemradio', { name: 'Choice', exact: true });
		await expect(choice).toBeVisible();
		await expect(choice).toBeFocused();
		const row = browser.page.locator('[data-action-id="first"] > button');
		const parent = await row.boundingBox();
		const child = await choice.boundingBox();
		assert.ok(parent && child && child.x > parent.x + parent.width - 4);
		assert.deepEqual(await choice.evaluate(button => ({ display: getComputedStyle(button).display, animations: button.closest('.ash-context-view')!.getAnimations({ subtree: true }).length })), { display: 'flex', animations: 0 });
		await browser.page.keyboard.press('ArrowLeft');
		await expect(row).toBeFocused();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await browser.page.evaluate(() => window.ashMenuTest.dispose());
		assert.equal(await browser.page.evaluate(() => window.ashMenuTest.state().shadowStyles), 0);
	});

	test('opens leftward submenus aligned to the parent row', async () => {
		await open('left');
		const row = browser.page.locator('[data-action-id="first"] > button');
		await row.click();
		const anchor = await row.boundingBox();
		const popup = await browser.page.locator('.ash-context-view-menu:not([hidden])').boundingBox();
		assert.ok(anchor && popup);
		assert.ok(popup.x + popup.width <= anchor.x);
		assert.ok(Math.abs(popup.y - anchor.y) < 3);
	});

	test('touch panning keeps a clamped menu open and dismisses it only after a real scroll', async () => {
		await open('long');
		await browser.page.evaluate(() => { window.ashMenuTest.focus(12); window.ashMenuTest.trigger(12); });
		const row = browser.page.locator('[data-action-id="first"] > button');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		const bounds = await row.boundingBox();
		assert.ok(bounds);
		const cdp = await browser.context.newCDPSession(browser.page);
		try {
			await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
			const swipe = async (distance: number): Promise<void> => {
				const point = { x: bounds.x + 80, y: bounds.y + bounds.height / 2 };
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
				for (let step = 1; step <= 5; step++) {
					await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + distance * step / 5 }] });
					await browser.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
				}
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			};
			await swipe(-80);
			await expect(row).toHaveAttribute('aria-expanded', 'true');
			await swipe(80);
			await expect(row).toHaveAttribute('aria-expanded', 'false');
		} finally { await cdp.detach(); }
	});

	test('keeps HC selection outlines local to the focused item at each level', async () => {
		await open('nested');
		for (const scheme of ['hcDark', 'hcLight'] as const) {
			await browser.page.evaluate(scheme => window.ashMenuTest.theme(scheme), scheme);
			await browser.page.locator('[data-action-id="first"] > button').click();
			const choice = browser.page.getByRole('menuitemradio', { name: 'Choice', exact: true });
			await expect(choice).toBeFocused();
			const values = await browser.page.locator('.ash-context-view-menu:not([hidden]) > .ash-menu > .ash-action-view-item > button').evaluateAll(buttons => buttons.map(button => ({ style: getComputedStyle(button).outlineStyle, color: getComputedStyle(button).outlineColor })));
			assert.equal(values[0]!.style, 'solid');
			assert.notEqual(values[0]!.color, 'rgba(0, 0, 0, 0)');
			assert.equal(values[1]!.style, 'none');
			await browser.page.keyboard.press('Escape');
		}
	});

	test('supports localized menubar mnemonics and horizontal switching', async () => {
		await open('menubar');
		await expect(browser.page.getByRole('menuitem', { name: '文件', exact: true }).locator('u')).toHaveText('Z');
		for (const [key, label] of [['f', 'Save'], ['ф', 'Сохранить'], ['z', '保存(S)']] as const) {
			if (key === 'ф') await browser.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ф', altKey: true, bubbles: true })));
			else await browser.page.keyboard.press(`Alt+${key}`);
			await expect(browser.page.getByRole('menuitem', { name: label, exact: true })).toBeFocused();
			await browser.page.keyboard.press('Escape');
		}
		const file = browser.page.getByRole('menuitem', { name: 'File', exact: true });
		await file.focus();
		await browser.page.keyboard.press('ArrowRight');
		await expect(browser.page.getByRole('menuitem', { name: 'Файл', exact: true })).toBeFocused();
	});

	test('refreshes compact and overflow categories and localizes the compact trigger', async () => {
		await open('compact');
		await browser.page.evaluate(() => window.ashMenuTest.locale('zh-cn'));
		await browser.page.evaluate(() => window.ashMenuTest.mount('compact'));
		const compact = browser.page.getByRole('menuitem', { name: '应用程序菜单', exact: true });
		await compact.click();
		await browser.page.getByRole('menuitem', { name: 'File', exact: true }).click();
		await expect(browser.page.getByRole('menuitem', { name: 'Save', exact: true })).toBeVisible();
		await browser.page.keyboard.press('Escape');
		await browser.page.evaluate(() => window.ashMenuTest.updateCompact());
		await browser.page.getByRole('menuitem', { name: 'File', exact: true }).click();
		await expect(browser.page.getByRole('menuitem', { name: 'Updated item', exact: true })).toBeVisible();
		await browser.page.keyboard.press('Escape');
		await browser.page.keyboard.press('Escape');
		await browser.page.evaluate(() => { window.ashMenuTest.locale('en'); window.ashMenuTest.mount('menubar'); window.ashMenuTest.resize(60); });
		await browser.page.getByRole('menuitem', { name: 'Application Menu', exact: true }).click();
		await expect(browser.page.getByRole('menuitem', { name: 'Файл', exact: true })).toBeVisible();
	});

	test('hides a toggled menubar after focus leaves and keeps a hidden menubar unfocusable', async () => {
		await open('menubar');
		await browser.page.evaluate(() => window.ashMenuTest.visibility('toggle'));
		assert.equal(await browser.page.evaluate(() => window.ashMenuTest.state().visible), false);
		await browser.page.evaluate(() => window.ashMenuTest.toggleBarFocus());
		await expect(browser.page.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
		await browser.page.locator('#outside').focus();
		assert.equal(await browser.page.evaluate(() => window.ashMenuTest.state().visible), false);
		await browser.page.evaluate(() => { window.ashMenuTest.visibility('hidden'); window.ashMenuTest.toggleBarFocus(); });
		await expect(browser.page.locator('#outside')).toBeFocused();
	});
});
