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

	for (const side of ['left', 'right'] as const) {
		test(`floating menus avoid ${side} window controls and follow visible overlay geometry`, async () => {
			await open('basic');
			await browser.page.evaluate(side => {
				window.ashMenuTest.overlay(90, innerWidth - 210, 40);
				window.ashMenuTest.popup(side === 'left' ? 0 : innerWidth - 1, 0);
			}, side);
			const popup = browser.page.locator('.ash-context-view-menu:not([hidden])');
			const primary = browser.page.getByRole('menuitem', { name: 'Primary', exact: true });
			await expect(primary).toBeFocused();
			await expect(popup).toHaveCSS('top', '40px');
			for (const scheme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
				await browser.page.evaluate(scheme => window.ashMenuTest.theme(scheme), scheme);
				const box = await popup.boundingBox();
				assert.ok(box && box.y >= 40 && box.x >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720);
				await browser.page.screenshot({ path: browser.info.outputPath(`wco-${side}-${scheme}.png`) });
			}
			await browser.page.evaluate(() => window.ashMenuTest.overlay(90, innerWidth - 210, 64));
			await expect(popup).toHaveCSS('top', '64px');
			await browser.page.evaluate(() => window.ashMenuTest.overlay(90, innerWidth - 210, 64, false));
			await expect(popup).toHaveCSS('top', '0px');
			await expect(primary).toBeFocused();
			await primary.press('Escape');
			await expect(popup).toHaveCount(0);
			await expect(browser.page.getByRole('button', { name: 'Outside', exact: true })).toBeFocused();
		});
	}

	test('keyboard submenus avoid window controls through the shared floating host', async () => {
		await open('nested');
		await browser.page.evaluate(() => {
			window.ashMenuTest.overlay(90, 590, 200);
			window.ashMenuTest.focus(2);
		});
		await browser.page.keyboard.press('ArrowRight');
		const choice = browser.page.getByRole('menuitemradio', { name: 'Choice', exact: true });
		await expect(choice).toBeFocused();
		const popup = browser.page.locator('.ash-context-view-menu:not([hidden])');
		await expect(popup).toHaveCSS('top', '200px');
		await browser.page.keyboard.press('ArrowDown');
		await browser.page.keyboard.press('ArrowRight');
		const child = browser.page.getByRole('menuitem', { name: 'Child', exact: true });
		await expect(child).toBeFocused();
		await expect(child.locator('.ash-menu-leading-slot')).toHaveCSS('display', 'none');
		for (const view of await popup.all()) {
			const box = await view.boundingBox();
			assert.ok(box && box.y >= 200 && box.x >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720);
		}
		await browser.page.keyboard.press('Escape');
		await expect(browser.page.getByRole('menuitem', { name: 'Nested', exact: true })).toBeFocused();
		await browser.page.keyboard.press('Escape');
		await expect(browser.page.getByRole('menuitem', { name: 'First', exact: true })).toBeFocused();
	});

	test('updates state, modifier labels and shortcuts in place and keeps Tab in a standalone menu', async () => {
		await open('basic');
		const primary = browser.page.locator('[data-action-id="primary"] > button');
		await expect(primary).toBeFocused();
		await expect(primary).toContainText('Ctrl+P');
		const slot = primary.locator('.ash-menu-leading-slot');
		await expect(slot).toHaveCSS('display', 'none');
		await browser.page.keyboard.down('Alt');
		await expect(primary).toHaveAccessibleName('Alternate');
		await expect(primary).toContainText('Ctrl+A');
		await browser.page.keyboard.press('Enter');
		await browser.page.keyboard.up('Alt');
		await expect(primary).toHaveAccessibleName('Primary');
		await browser.page.evaluate(() => window.ashMenuTest.update());
		await expect(primary).toHaveAccessibleName('Updated');
		await expect(primary).toHaveAttribute('aria-checked', 'true');
		await expect(slot).toBeVisible();
		await browser.page.keyboard.down('Alt');
		await expect(slot).toHaveCSS('display', 'none');
		await browser.page.keyboard.up('Alt');
		await browser.page.keyboard.press('Tab');
		await expect(primary).toBeFocused();
		await browser.page.evaluate(() => window.ashMenuTest.disable());
		await expect(browser.page.locator('[data-action-id="after"] > button')).toBeFocused();
		assert.deepEqual(await browser.page.evaluate(() => window.ashMenuTest.state().calls), [{ id: 'alternate', context: { version: 1 } }]);
	});

	test('trailing menus align command icons, selection marks and submenu arrows after optional shortcuts', async () => {
		await open('trailing');
		const primary = browser.page.getByRole('menuitem', { name: 'Primary' });
		const submenu = browser.page.getByRole('menuitem', { name: 'First' });
		const icon = primary.locator('.ash-menu-trailing-slot [data-ash-icon-id="search"]');
		const arrow = submenu.locator('.ash-menu-trailing-slot > .ash-icon');
		await expect(icon).toBeVisible();
		await expect(arrow).toBeVisible();
		await expect(primary.locator('.ash-menu-leading-slot')).toHaveCount(0);
		const after = browser.page.getByRole('menuitem', { name: 'After' });
		expect(await after.locator('.ash-menu-trailing-slot').evaluate(slot => slot.getBoundingClientRect().width)).toBeGreaterThan(0);
		const iconColumn = async (row: typeof primary) => {
			const slot = (await row.locator('.ash-menu-trailing-slot').boundingBox())!;
			const shortcut = (await row.locator('.ash-menu-keybinding').boundingBox())!;
			assert.ok(shortcut.x + shortcut.width <= slot.x);
			return slot.x;
		};
		assert.equal(await iconColumn(primary), await iconColumn(submenu));
		await browser.page.evaluate(() => window.ashMenuTest.update());
		await expect(icon).toBeHidden();
		const check = browser.page.locator('[data-action-id="primary"] .ash-menu-trailing-slot > [data-ash-icon-id="check"]');
		await expect(check).toBeVisible();
		await browser.page.keyboard.down('Alt');
		await expect(check).toBeHidden();
		await browser.page.keyboard.up('Alt');
		await expect(check).toBeVisible();
		await submenu.focus();
		await submenu.press('ArrowRight');
		const choice = browser.page.getByRole('menuitemradio', { name: 'Choice', checked: true });
		await expect(choice).toBeFocused();
		await expect(choice.locator('.ash-menu-trailing-slot > [data-ash-icon-id="check"]')).toBeVisible();
		await expect(choice.locator('.ash-menu-keybinding')).toHaveCount(0);
		await choice.press('ArrowDown');
		await browser.page.keyboard.press('ArrowRight');
		const child = browser.page.getByRole('menuitem', { name: 'Child', exact: true });
		await expect(child).toBeFocused();
		await expect(child.locator('.ash-menu-trailing-slot')).toHaveCSS('display', 'none');
		await child.press('Escape');
		await browser.page.keyboard.press('Escape');
		await expect(submenu).toBeFocused();
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
		const firstChild = await browser.page.getByRole('menuitemradio', { name: 'Choice', exact: true }).boundingBox();
		assert.ok(anchor && popup && firstChild);
		assert.ok(popup.x + popup.width <= anchor.x);
		assert.ok(Math.abs(firstChild.y - anchor.y) < 3);
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

	test('the menubar switches categories under the pointer and shields controls outside the menu', async () => {
		await open('menubar');
		const { page } = browser;
		const outside = page.locator('#outside');
		const category = page.getByRole('menuitem', { name: 'Файл', exact: true });
		await outside.evaluate(button => button.addEventListener('click', () => { button.dataset.clicked = 'true'; }));
		await outside.hover();
		await page.keyboard.press('Alt+f');
		const save = page.getByRole('menuitem', { name: 'Save', exact: true });
		await expect(save).toBeFocused();
		await expect.poll(() => outside.evaluate(button => button.matches(':hover'))).toBe(false);
		const outsideBounds = (await outside.boundingBox())!;
		const x = outsideBounds.x + outsideBounds.width / 2;
		const y = outsideBounds.y + outsideBounds.height / 2;
		await page.mouse.move(x, y);
		expect(await outside.evaluate(button => button.matches(':hover'))).toBe(false);
		await expect(save).toBeFocused();
		const categoryBounds = (await category.boundingBox())!;
		await page.mouse.move(categoryBounds.x + categoryBounds.width / 2, categoryBounds.y + categoryBounds.height / 2);
		await expect(page.getByRole('menu', { name: 'Файл', exact: true })).toBeFocused();
		await expect(save).toHaveCount(0);
		await page.mouse.click(x, y);
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(category).toBeFocused();
		expect(await outside.getAttribute('data-clicked')).toBeNull();
		await outside.click();
		await expect(outside).toHaveAttribute('data-clicked', 'true');
	});

	for (const phase of ['window capture', 'document capture', 'document bubble'] as const) test(`consumed Control+Alt shortcuts preserve their destination focus in ${phase}`, async () => {
		await browser.page.goto('/src/ash/base/test/browser/fixtures/menu.html');
		await browser.page.evaluate(phase => {
			const destination = document.createElement('button');
			destination.id = 'shortcut-destination';
			destination.textContent = 'Shortcut destination';
			document.body.append(destination);
			const shortcut = (event: KeyboardEvent): void => {
				if (event.key !== 'PageDown' || !event.ctrlKey || !event.altKey) return;
				event.preventDefault();
				event.stopPropagation();
				destination.focus();
			};
			if (phase === 'window capture') window.addEventListener('keydown', shortcut, true);
			else document.addEventListener('keydown', shortcut, phase === 'document capture');
			window.ashMenuTest.mount('menubar');
		}, phase);
		await browser.page.locator('#outside').focus();
		await browser.page.keyboard.press('Control+Alt+PageDown');
		await expect(browser.page.locator('#shortcut-destination')).toBeFocused();
		await expect(browser.page.locator('[role="menubar"]')).not.toContainText('Save');
	});

	for (const order of [['Control', 'Alt'], ['Alt', 'Control']] as const) test(`a modifier-only ${order.join('+')} combination does not activate the menubar`, async () => {
		await open('menubar');
		await browser.page.locator('#outside').focus();
		for (const key of order) await browser.page.keyboard.down(key);
		for (const key of [...order].reverse()) await browser.page.keyboard.up(key);
		await expect(browser.page.locator('#outside')).toBeFocused();
	});

	test('bare Alt including repeated keydown toggles menu focus and returns to its origin', async () => {
		await open('menubar');
		await browser.page.locator('#outside').focus();
		await browser.page.keyboard.down('Alt');
		await browser.page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, repeat: true, bubbles: true })));
		await browser.page.keyboard.up('Alt');
		await expect(browser.page.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
		await browser.page.keyboard.press('Alt');
		await expect(browser.page.locator('#outside')).toBeFocused();
	});

	for (const composing of ['keydown', 'compositionstart'] as const) test(`composition ${composing} retires an Alt-only candidate`, async () => {
		await open('menubar');
		await browser.page.locator('#outside').focus();
		await browser.page.keyboard.down('Alt');
		await browser.page.evaluate(composing => {
			const target = document.activeElement!;
			target.dispatchEvent(composing === 'keydown'
				? new KeyboardEvent('keydown', { key: 'Process', altKey: true, isComposing: true, bubbles: true })
				: new CompositionEvent('compositionstart', { bubbles: true }));
		}, composing);
		await browser.page.keyboard.up('Alt');
		await expect(browser.page.locator('#outside')).toBeFocused();
	});

	test('Control+Alt letters do not trigger menu access keys while Alt letters still do', async () => {
		await open('menubar');
		await browser.page.locator('#outside').focus();
		await browser.page.keyboard.press('Control+Alt+f');
		await expect(browser.page.locator('#outside')).toBeFocused();
		await browser.page.keyboard.press('Alt+f');
		await expect(browser.page.getByRole('menuitem', { name: 'Save', exact: true })).toBeFocused();
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
