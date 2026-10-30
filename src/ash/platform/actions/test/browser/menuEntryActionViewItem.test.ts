import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';
import { ModifierKeyEmitter } from '../../../../base/browser/dom.js';
import type { IContextMenuDelegate } from '../../../../base/browser/contextmenu.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ContextKeyExpr } from '../../../contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { CommandService } from '../../../../workbench/services/commands/common/commandService.js';
import { CommandsRegistry } from '../../../commands/common/commands.js';
import { MenuId, MenusRegistry, SubmenuItemAction } from '../../common/actions.js';
import { MenuService } from '../../common/menuService.js';
import { createActionViewItem, DropdownWithDefaultActionViewItem, SubmenuEntryActionViewItem } from '../../browser/menuEntryActionViewItem.js';
import { MenuWorkbenchToolBar } from '../../browser/toolbar.js';

suite('Menu default split actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('menu toolbar uses the default menu entry and retains its submenu until dismissal', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using resources = new DisposableStore();
			const services = resources.add(new InstantiationService());
			const keys = resources.add(new ContextKeyService());
			const enabled = keys.createKey<boolean>('defaultEnabled', true);
			const commands = resources.add(new CommandService(services));
			const menus = new MenuService(commands, keys);
			const titleMenu = MenuId.for('test.defaultSplit.title');
			const newMenu = MenuId.for('test.defaultSplit.new');
			const runs: string[] = [];
			for (const id of ['new', 'alternate', 'other']) {
				resources.add(CommandsRegistry.register(`test.defaultSplit.${id}`, () => { runs.push(id); }));
			}
			resources.add(MenusRegistry.appendMenuItem(titleMenu, {
				title: 'New', submenu: newMenu, isSplitButton: true, group: 'navigation',
			}));
			resources.add(MenusRegistry.appendMenuItem(newMenu, {
				command: { id: 'test.defaultSplit.new', title: 'New', precondition: ContextKeyExpr.has('defaultEnabled') },
				alt: { id: 'test.defaultSplit.alternate', title: 'Alternative' },
				group: '1_new',
			}));
			resources.add(MenusRegistry.appendMenuItem(newMenu, {
				command: { id: 'test.defaultSplit.other', title: 'Other' }, group: '2_other',
			}));
			const action = menus.getMenuActions(titleMenu)[0]![1][0]!;
			let shown: IContextMenuDelegate | undefined;
			const provider = { showContextMenu(delegate: IContextMenuDelegate) { shown = delegate; } };
			using item = createActionViewItem(action, provider)!;
			assert.ok(item instanceof DropdownWithDefaultActionViewItem);
			const container = dom.window.document.createElement('div');
			dom.window.document.body.append(container);
			item.render(container);
			const main = container.querySelector<HTMLButtonElement>('.ash-split-action-primary.ash-menu-entry button')!;
			assert.ok(main);
			main.click();
			assert.deepEqual(runs, ['new']);
			dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Alt', altKey: true }));
			assert.equal(main.textContent, 'Alternative');
			main.click();
			assert.deepEqual(runs, ['new', 'alternate']);
			dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Alt' }));
			assert.equal(main.textContent, 'New');

			using toolbar = new MenuWorkbenchToolBar(dom.window.document.body, menus, provider, titleMenu);
			const dropdown = toolbar.element.querySelector<HTMLButtonElement>('.ash-split-action-dropdown button')!;
			dropdown.focus();
			dropdown.click();
			assert.equal(dropdown.getAttribute('aria-expanded'), 'true');
			assert.deepEqual(shown!.getActions().map(action => action.label), ['New', '', 'Other']);
			enabled.set(false);
			assert.equal(dropdown.isConnected, true);
			assert.equal(shown!.cancellationToken?.isCancellationRequested, false);
			shown!.onHide?.(true);
			await Promise.resolve();
			const disabled = toolbar.element.querySelector<HTMLButtonElement>('.ash-split-action-primary button')!;
			const refreshed = toolbar.element.querySelector<HTMLButtonElement>('.ash-split-action-dropdown button')!;
			assert.equal(disabled.disabled, true);
			assert.equal(refreshed.disabled, false);
			assert.equal(refreshed.tabIndex, 0);
			assert.equal(dom.window.document.activeElement, refreshed);
			refreshed.click();
			const cancellation = shown!.cancellationToken!;
			toolbar.dispose();
			assert.equal(cancellation.isCancellationRequested, true);
		} finally {
			ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
			dom.window.close();
		}
	});

	test('empty split submenus retain a menu trigger without inventing a command', () => {
		using item = createActionViewItem(new SubmenuItemAction({
			title: 'Empty', submenu: MenuId.for('test.defaultSplit.empty'), isSplitButton: true,
		}, []), { showContextMenu() { } })!;
		assert.ok(item instanceof SubmenuEntryActionViewItem);
	});
});

suite('Rendered menu default split actions', () => {
	const browser = useBrowserTests();

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`shares toolbar geometry and keyboard navigation in ${theme}`, async () => {
			const { page } = browser;
			await page.goto('/button.html');
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.evaluate(theme => window.ashButtonIntegration.theme(theme), theme);
			const root = page.locator('#default-toolbar .ash-dropdown-with-default-action-view-item');
			const main = root.locator('.ash-split-action-primary button');
			const dropdown = root.locator('.ash-split-action-dropdown button');
			const geometry = await root.evaluate(root => {
				const [main, dropdown] = [...root.querySelectorAll('button')];
				const left = main!.getBoundingClientRect();
				const right = dropdown!.getBoundingClientRect();
				const icon = main!.querySelector('.ash-icon')!.getBoundingClientRect();
				return {
					height: left.height, mainWidth: left.width, dropdownHeight: right.height,
					dropdownWidth: right.width, gap: right.left - left.right,
					iconWidth: icon.width, iconHeight: icon.height,
					iconOffsetX: icon.left + icon.width / 2 - left.left - left.width / 2,
					iconOffsetY: icon.top + icon.height / 2 - left.top - left.height / 2,
					mainInnerRadius: getComputedStyle(main!).borderTopRightRadius,
					dropdownInnerRadius: getComputedStyle(dropdown!).borderTopLeftRadius,
				};
			});
			assert.deepEqual(geometry, {
				height: 22, mainWidth: 22, dropdownHeight: 22, dropdownWidth: 16, gap: 0,
				iconWidth: 16, iconHeight: 16, iconOffsetX: 0, iconOffsetY: 0,
				mainInnerRadius: '0px', dropdownInnerRadius: '0px',
			});
			await expect(main).toHaveAttribute('aria-label', 'New Chat');
			await expect(dropdown).toHaveAttribute('aria-label', 'New Chat');
			await main.focus();
			await main.press('Enter');
			await expect(page.locator('output')).toHaveText('new');
			await main.press('ArrowRight');
			await expect(dropdown).toBeFocused();
			await expect(main).toHaveAttribute('tabindex', '-1');
			await expect(dropdown).toHaveAttribute('tabindex', '0');
			await dropdown.press('ArrowDown');
			await expect(dropdown).toHaveAttribute('aria-expanded', 'true');
			await expect(page.getByRole('menuitem', { name: 'Other action', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(dropdown).toBeFocused();
			await expect(dropdown).toHaveAttribute('aria-expanded', 'false');
			await dropdown.press('ArrowLeft');
			await expect(main).toBeFocused();
			await dropdown.click();
			await page.getByRole('menuitem', { name: 'Other action', exact: true }).click();
			await expect(page.locator('output')).toHaveText('other');
		});
	}

	test('retains translated command and submenu labels', async () => {
		const { page } = browser;
		await page.goto('/button.html?locale=zh-CN');
		const root = page.locator('#default-toolbar .ash-dropdown-with-default-action-view-item');
		await expect(root.getByRole('button', { name: '新建聊天', exact: true })).toHaveCount(2);
		await root.locator('.ash-split-action-dropdown button').click();
		await expect(page.getByRole('menuitem', { name: '新建聊天', exact: true })).toBeVisible();
	});
});
