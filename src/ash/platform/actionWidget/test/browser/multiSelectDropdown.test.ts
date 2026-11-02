import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { AccessibleViewRegistry } from '../../../accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { getIconDefinition } from '../../../theme/common/iconRegistry.js';
import { IActionWidgetService } from '../../browser/actionWidget.js';
import { ActionListItemKind } from '../../browser/actionList.js';
import { MultiSelectDropdown } from '../../browser/multiSelectDropdown.js';

function setup(document: Document, resources: DisposableStore): InstantiationService {
	setIconResolver(document, getIconDefinition);
	const collection = new ServiceCollection();
	for (const [id, descriptor] of getSingletonServiceDescriptors()) { collection.set(id, descriptor); }
	const services = resources.add(new InstantiationService(collection));
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
	services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
	return services;
}

test('multi-select validates identities before replacing a popup and never closes another owner on disposal', async () => {
	const dom = new JSDOM('<body><button>Days</button></body>');
	try {
		using resources = new DisposableStore();
		const services = setup(dom.window.document, resources);
		const dropdown = resources.add(services.createInstance(MultiSelectDropdown));
		const options = { anchor: dom.window.document.querySelector('button')!, ariaLabel: 'Days', sections: [{ label: 'Days', items: [{ id: 'mon', label: 'Monday' }] }], selectedIds: ['mon'] };
		let hides = 0;
		resources.add(dropdown.onDidHide(() => hides++));
		dropdown.show(options);
		for (const invalid of [
			{ ...options, selectedIds: ['unknown'] },
			{ ...options, sections: [{ label: 'Invalid', items: [{ id: '', label: 'Empty' }] }] },
			{ ...options, sections: [...options.sections, ...options.sections] },
			{ ...options, width: NaN },
		]) { assert.throws(() => dropdown.show(invalid)); }
		assert.equal(dropdown.isVisible, true);
		assert.equal(dom.window.document.querySelector('[role=menuitemcheckbox]')?.textContent?.includes('Monday'), true);
		const service = services.get(IActionWidgetService);
		service.show('replacement', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Replacement' }], { onSelect: () => { }, onHide: () => { } }, options.anchor);
		await Promise.resolve();
		assert.equal(dropdown.isVisible, false);
		assert.equal(hides, 1);
		dropdown.dispose();
		assert.equal(service.isVisible, true);
		assert.equal(options.anchor.hasAttribute('aria-expanded'), false);
	} finally { dom.window.close(); }
});

test('multi-select emits ordered snapshots only for user toggles and provides translated accessibility help', async () => {
	const dom = new JSDOM('<body><button aria-expanded="false" aria-haspopup="dialog">Days</button></body>');
	try {
		using resources = new DisposableStore();
		const document = dom.window.document;
		const services = setup(document, resources);
		const dropdown = resources.add(services.createInstance(MultiSelectDropdown));
		const changes: (readonly string[])[] = [];
		resources.add(dropdown.onDidChangeSelection(ids => changes.push(ids)));
		const anchor = document.querySelector('button')!;
		dropdown.show({
			anchor, ariaLabel: 'Days', selectedIds: ['b'], sections: [
				{ label: 'Empty', items: [] },
				{ label: 'Days', items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Unavailable', disabled: true }] },
			]
		});
		const row = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[aria-label=Alpha]')!;
		row().click();
		await Promise.resolve();
		assert.deepEqual(changes, [['a', 'b']]);
		row().click();
		await Promise.resolve();
		assert.deepEqual(changes, [['a', 'b'], ['b']]);
		assert.equal(dropdown.isVisible, true);
		row().focus();
		const translations = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/editor.json', 'utf8'));
		setNlsMessages('zh-CN', translations);
		const implementation = AccessibleViewRegistry.getImplementations().find(provider => provider.type === AccessibleViewType.Help && provider.name === 'action-widget')!;
		using help = services.invokeFunction(accessor => implementation.getProvider(accessor))!;
		assert.match(help.provideContent(), /立即切换当前选项/u);
		help.dispose();
		dropdown.hide();
		await Promise.resolve();
		assert.deepEqual(changes, [['a', 'b'], ['b']]);
		assert.equal(document.activeElement, anchor);
		assert.equal(anchor.getAttribute('aria-expanded'), 'false');
		assert.equal(anchor.getAttribute('aria-haspopup'), 'dialog');
	} finally { resetNlsResolver(); dom.window.close(); }
});

suite('multiSelectDropdown browser component', () => {
	const browserTests = useBrowserTests();
	test('checkbox choices toggle repeatedly, skip disabled rows and restore focus on Escape', async () => {
		const { page } = browserTests;
		await page.goto('/actionWidget.html');
		await page.evaluate(() => window.ashActionWidgetIntegration.showMulti());
		const root = page.locator('.ash-multi-select-dropdown');
		const monday = root.getByRole('menuitemcheckbox', { name: 'Monday', exact: true });
		await expect(monday).toBeFocused();
		await monday.press('ArrowDown');
		const wednesday = root.getByRole('menuitemcheckbox', { name: 'Wednesday', exact: true });
		await expect(wednesday).toBeFocused();
		await wednesday.press('Space');
		await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('["mon","wed"]');
		await expect(wednesday).toHaveAttribute('aria-checked', 'true');
		await wednesday.dblclick();
		await expect(wednesday).toHaveAttribute('aria-checked', 'true');
		await wednesday.click({ modifiers: ['Control'] });
		await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('["mon"]');
		await expect(root.getByRole('menuitemcheckbox', { name: 'Tuesday', exact: true })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(root).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Open actions', exact: true })).toBeFocused();
	});

	test('search exposes a multiselect listbox, preserves selection and keeps typing in the combobox', async () => {
		const { page } = browserTests;
		await page.goto('/actionWidget.html');
		await page.evaluate(() => window.ashActionWidgetIntegration.showMulti({ searchable: true, contextViewLayer: 3 }));
		const root = page.locator('.ash-multi-select-dropdown');
		await expect(page.locator('.ash-context-view')).toHaveCSS('--ash-context-view-layer', '3');
		const search = root.getByRole('combobox');
		await expect(search).toBeFocused();
		await search.evaluate(input => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
		});
		await expect(root).toBeVisible();
		await expect(page.getByRole('status', { name: 'Selection' })).toBeEmpty();
		await search.fill('First weekday');
		await expect(root.getByRole('option')).toHaveCount(1);
		await expect(root.getByRole('option')).toHaveAttribute('aria-label', 'Monday');
		await search.fill('Wednesday');
		await expect(root.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
		const option = root.getByRole('option', { name: 'Wednesday', exact: true });
		await expect(search).toHaveAttribute('aria-activedescendant', await option.getAttribute('id') ?? '');
		await search.press('Enter');
		await expect(search).toBeFocused();
		await expect(option).toHaveAttribute('aria-checked', 'true');
		await search.press('Space');
		await expect(search).toHaveValue('Wednesday ');
		await search.fill('no matches');
		await expect(root.getByRole('option')).toHaveCount(0);
		await expect(search).not.toHaveAttribute('aria-activedescendant');
		await search.fill('');
		await expect(root.getByRole('option', { name: 'Monday', exact: true })).toHaveAttribute('aria-selected', 'true');
		await expect(root.getByRole('option', { name: 'Wednesday', exact: true })).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('status', { name: 'Selection' })).toHaveText('["mon","wed"]');
	});

	test('long menus preserve scroll across toggles in all themes and release focus to outside controls', async () => {
		const { page } = browserTests;
		await page.goto('/actionWidget.html');
		for (const scheme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(scheme => {
				window.ashActionWidgetIntegration.theme(scheme);
				window.ashActionWidgetIntegration.showMulti({ selectedIds: [], sections: [{ label: 'Tools', items: Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, label: `Tool ${i}` })) }] });
			}, scheme);
			const root = page.locator('.ash-multi-select-dropdown');
			await expect(root).toHaveCSS('width', '280px');
			const last = root.getByRole('menuitemcheckbox', { name: 'Tool 59', exact: true });
			await last.focus();
			const scrolling = root.locator('.ash-menu');
			const before = await scrolling.evaluate(element => element.scrollTop);
			expect(before).toBeGreaterThan(0);
			await last.press('Enter');
			await expect(last).toHaveAttribute('aria-checked', 'true');
			expect(await scrolling.evaluate(element => element.scrollTop)).toBe(before);
			await page.keyboard.press('Escape');
		}
		await page.evaluate(() => window.ashActionWidgetIntegration.showMulti({ searchable: true }));
		await page.getByRole('button', { name: 'Open actions', exact: true }).evaluate(button => {
			const outside = document.createElement('input');
			button.after(outside);
			outside.focus();
		});
		await expect(page.locator('.ash-multi-select-dropdown')).toHaveCount(0);
		await expect(page.locator('input')).toBeFocused();
	});
});
