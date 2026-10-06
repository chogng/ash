import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../accessibility/browser/accessibleViewRegistry.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { getIconDefinition } from '../../../theme/common/iconRegistry.js';
import { IActionWidgetService } from '../../browser/actionWidget.js';
import { ActionList, ActionListItemKind } from '../../browser/actionList.js';
import { ActionWidgetDropdown } from '../../browser/actionWidgetDropdown.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

function createServices(document: Document, resources: DisposableStore): InstantiationService {
	setIconResolver(document, icon => getIconDefinition(icon));
	const collection = new ServiceCollection();
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		collection.set(id, descriptor);
	}
	const services = resources.add(new InstantiationService(collection));
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
	services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
	return services;
}

test('action choices preserve icons, radio states and separators when dispatching typed actions', async () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const service = createServices(dom.window.document, resources).get(IActionWidgetService);
		const source = dom.window.document.querySelector<HTMLButtonElement>('#source')!;
		const selected: number[] = [];
		source.focus();
		service.show('choices', false, [
			{ kind: ActionListItemKind.Action, item: 1, label: 'Agent', checked: true, group: { title: '', icon: Lxicon.unlimited } },
			{ kind: ActionListItemKind.Separator, label: '' },
			{ kind: ActionListItemKind.Action, item: 2, label: 'Plan', checked: false, group: { title: '', icon: Lxicon.plan } },
		], { onSelect: item => { selected.push(item); }, onHide: () => { } }, source);
		const rows = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]'));
		assert.deepEqual(rows.map(row => ({
			label: row.getAttribute('aria-label'),
			checked: row.getAttribute('aria-checked'),
			icon: row.querySelector('.ash-icon-label-icon svg')?.getAttribute('data-ash-icon-id'),
		})), [
			{ label: 'Agent', checked: 'true', icon: 'unlimited' },
			{ label: 'Plan', checked: 'false', icon: 'plan' },
		]);
		assert.equal(dom.window.document.querySelectorAll('[role=separator]').length, 1);
		rows[1]!.focus();
		rows[1]!.click();
		await Promise.resolve();
		assert.deepEqual(selected, [2]);
		service.hide();
		assert.equal(dom.window.document.activeElement, source);
	} finally {
		dom.window.close();
	}
});

test('action lists focus the current choice, preserve navigation on refresh and preselect eligible candidates', () => {
	const dom = new JSDOM('<body></body>');
	try {
		const document = dom.window.document;
		const items = [
			{ kind: ActionListItemKind.Action, item: 0, label: 'Unavailable', disabled: true, checked: true },
			{ kind: ActionListItemKind.Header, label: 'Modes' },
			{ kind: ActionListItemKind.Action, item: 1, label: 'Agent', checked: false },
			{ kind: ActionListItemKind.Separator, label: '' },
			{ kind: ActionListItemKind.Action, item: 2, label: 'Plan', checked: true },
		];
		using list = new ActionList('choices', items, { onSelect: () => { }, onHide: () => { } }, document.body, undefined, false, {});
		list.focus();
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Plan');
		list.domNode.querySelector<HTMLButtonElement>('[aria-label="Agent"]')!.focus();
		list.updateItems(items);
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Agent');
		list.updateItems([
			{ kind: ActionListItemKind.Action, item: 0, label: 'Unavailable', disabled: true },
			{ kind: ActionListItemKind.Action, item: 1, label: 'Apply edit' },
		]);
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Apply edit');
	} finally {
		dom.window.close();
	}
});

test('replacing the action menu cancels its owner once and outside dismissal releases the replacement', () => {
	const dom = new JSDOM('<body><button id="source">Open</button><input id="outside"></body>');
	try {
		using resources = new DisposableStore();
		const services = createServices(dom.window.document, resources);
		const service = services.get(IActionWidgetService);
		const source = dom.window.document.querySelector<HTMLButtonElement>('#source')!;
		const closed: string[] = [];
		source.focus();
		for (const name of ['first', 'second']) {
			service.show(name, false, [{ kind: ActionListItemKind.Action, item: name, label: name }], {
				onSelect: () => assert.fail('Dismissal must not select an action'),
				onHide: cancelled => closed.push(`${name}:${cancelled}`),
			}, source);
		}
		assert.deepEqual(closed, ['first:true']);
		assert.equal(dom.window.document.querySelectorAll('.ash-action-widget').length, 1);
		const outside = dom.window.document.querySelector<HTMLInputElement>('#outside')!;
		outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
		outside.focus();
		service.hide();
		assert.deepEqual({ closed, visible: service.isVisible, focus: dom.window.document.activeElement }, {
			closed: ['first:true', 'second:true'], visible: false, focus: outside,
		});
	} finally {
		dom.window.close();
	}
});

test('an async action runs once and finishing a retired list leaves its replacement untouched', async () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const service = createServices(dom.window.document, resources).get(IActionWidgetService);
		const source = dom.window.document.querySelector<HTMLButtonElement>('#source')!;
		let finish!: () => void;
		const pending = new Promise<void>(resolve => { finish = resolve; });
		let selected = 0;
		service.show('first', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Run' }], {
			onSelect: async () => { selected++; await pending; }, onHide: () => { },
		}, source);
		const button = dom.window.document.querySelector<HTMLButtonElement>('.ash-action-widget button')!;
		button.click();
		button.click();
		assert.equal(selected, 1);
		assert.equal(dom.window.document.querySelector('.ash-action-widget')?.getAttribute('aria-busy'), 'true');
		service.show('second', false, [{ kind: ActionListItemKind.Action, item: 2, label: 'Next' }], {
			onSelect: () => { }, onHide: () => { },
		}, source);
		finish();
		await pending;
		await Promise.resolve();
		assert.equal(dom.window.document.querySelector('.ash-action-widget')?.textContent, 'Next');
		assert.equal(dom.window.document.querySelector('.ash-action-widget')?.hasAttribute('aria-busy'), false);
	} finally {
		dom.window.close();
	}
});

test('the registered action service rejects an incomplete scope at construction', () => {
	const collection = new ServiceCollection();
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		collection.set(id, descriptor);
	}
	using services = new InstantiationService(collection);
	assert.throws(() => services.get(IActionWidgetService), /contextViewService/u);
});

test('a menu with no available actions keeps keyboard focus and disposal closes it once', () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const services = createServices(dom.window.document, resources);
		const service = services.get(IActionWidgetService);
		const source = dom.window.document.querySelector<HTMLButtonElement>('#source')!;
		let closed = 0;
		source.focus();
		service.show('disabled', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Unavailable', disabled: true }], {
			onSelect: () => assert.fail('Disabled actions cannot run'), onHide: () => { closed++; },
		}, source);
		assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('.ash-action-widget'));
		resources.dispose();
		assert.deepEqual({ closed, menu: dom.window.document.querySelector('.ash-action-widget'), focus: dom.window.document.activeElement }, {
			closed: 1, menu: null, focus: source,
		});
	} finally {
		dom.window.close();
	}
});

test('accessibility hint verbosity can be disabled without removing action labels', async () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const services = createServices(dom.window.document, resources);
		await services.get(IConfigurationService).updateValue('accessibility.verbosity.actionWidget', false);
		services.get(IActionWidgetService).show('muted', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Run' }], {
			onSelect: () => { }, onHide: () => { },
		}, dom.window.document.querySelector<HTMLButtonElement>('#source')!);
		const menu = dom.window.document.querySelector('.ash-action-widget')!;
		assert.deepEqual({ label: menu.getAttribute('aria-label'), hint: menu.getAttribute('aria-description') }, { label: 'Actions', hint: null });
	} finally {
		dom.window.close();
	}
});

test('accessibility help is available to the workbench only while the action menu has focus', () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const services = createServices(dom.window.document, resources);
		const implementation = AccessibleViewRegistry.getImplementations().find(entry => entry.name === 'action-widget')!;
		assert.equal(implementation.type, AccessibleViewType.Help);
		assert.equal(services.invokeFunction(accessor => implementation.getProvider(accessor)), undefined);
		const service = services.get(IActionWidgetService);
		service.show('help', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Run' }], {
			onSelect: () => { }, onHide: () => { },
		}, dom.window.document.querySelector<HTMLButtonElement>('#source')!);
		const focusedAction = dom.window.document.activeElement;
		using provider = services.invokeFunction(accessor => implementation.getProvider(accessor))!;
		assert.equal(provider.id, AccessibleViewProviderId.ActionWidget);
		assert.equal(provider.verbositySettingKey, AccessibilityVerbositySettingId.ActionWidget);
		assert.match(provider.provideContent(), /Unavailable actions and group labels are skipped/u);
		dom.window.document.querySelector<HTMLButtonElement>('#source')!.focus();
		provider.dispose();
		assert.equal(dom.window.document.activeElement, focusedAction);
		service.hide();
		assert.equal(services.invokeFunction(accessor => implementation.getProvider(accessor)), undefined);
	} finally {
		dom.window.close();
	}
});

test('filtering removes empty groups and keeps the typed action associated with its label', () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const service = createServices(dom.window.document, resources).get(IActionWidgetService);
		const selected: number[] = [];
		service.show<number>('groups', false, [
			{ kind: ActionListItemKind.Header, label: 'Fixes' },
			{ kind: ActionListItemKind.Action, item: 1, label: 'Fix Alpha', group: { title: 'Fixes' } },
			{ kind: ActionListItemKind.Header, label: 'Refactors' },
			{ kind: ActionListItemKind.Action, item: 2, label: 'Extract Beta', group: { title: 'Refactors' } },
		], { onSelect: item => { selected.push(item); }, onHide: () => { } }, dom.window.document.querySelector<HTMLButtonElement>('#source')!, { showFilter: true });
		const root = dom.window.document.querySelector('.ash-action-widget')!;
		const filter = root.querySelector<HTMLInputElement>('input')!;
		filter.focus();
		filter.value = 'EXTRACT beta';
		filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		assert.deepEqual([...root.querySelectorAll('.ash-action-widget-header')].map(header => header.textContent), ['Refactors']);
		assert.equal(dom.window.document.activeElement, filter);
		root.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
		assert.deepEqual(selected, [2]);
		filter.value = 'missing';
		filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		assert.deepEqual({ rows: root.querySelectorAll('[role=menuitem]').length, headers: root.querySelectorAll('.ash-action-widget-header').length, status: root.querySelector('[role=status]')!.textContent }, {
			rows: 0, headers: 0, status: 'No matching actions.',
		});
	} finally {
		dom.window.close();
	}
});

test('preview requires an eligible focused action and shares the activation gate with apply', async () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const service = createServices(dom.window.document, resources).get(IActionWidgetService);
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const selected: { item: number; preview: boolean | undefined; }[] = [];
		service.show('preview', true, [
			{ kind: ActionListItemKind.Action, item: 1, label: 'No preview' },
			{ kind: ActionListItemKind.Action, item: 2, label: 'Preview edit', canPreview: true },
		], { onSelect: async (item, preview) => { selected.push({ item, preview }); await pending; }, onHide: () => { } }, dom.window.document.querySelector<HTMLButtonElement>('#source')!);
		const root = dom.window.document.querySelector('.ash-action-widget')!;
		const preview = root.querySelector<HTMLButtonElement>('.ash-action-widget-preview button')!;
		assert.equal(preview.disabled, true);
		const action = root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1]!;
		action.focus();
		assert.equal(preview.disabled, false);
		preview.click();
		action.click();
		assert.deepEqual(selected, [{ item: 2, preview: true }]);
		assert.equal(preview.disabled, true);
		release();
		await pending;
		await Promise.resolve();
		assert.equal(preview.disabled, false);
	} finally {
		dom.window.close();
	}
});

test('changing action tabs preserves the filter and the pending execution gate', async () => {
	const dom = new JSDOM('<body><button id="source">Open</button></body>');
	try {
		using resources = new DisposableStore();
		const service = createServices(dom.window.document, resources).get(IActionWidgetService);
		const source = dom.window.document.querySelector<HTMLButtonElement>('#source')!;
		const items = [1, 2].map(item => ({ kind: ActionListItemKind.Action, item, label: `Run ${item}` }));
		const selected: number[] = [];
		let finish!: () => void;
		const pending = new Promise<void>(resolve => { finish = resolve; });
		let hidden = 0;
		source.focus();
		service.show('tabs', false, items, {
			onSelect: async item => { selected.push(item); await pending; },
			onHide: () => hidden++,
		}, source, { showFilter: true }, {
			tabs: [{ id: 'all', label: 'All' }, { id: 'second', label: 'Second' }],
			initialTab: 'all',
			createActionList: id => ({ items: id === 'all' ? items : [items[1]!] }),
		});
		const root = dom.window.document.querySelector<HTMLElement>('.ash-action-widget')!;
		const filter = root.querySelector<HTMLInputElement>('input')!;
		filter.value = 'run';
		filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		root.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
		root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1]!.click();
		const second = root.querySelector<HTMLButtonElement>('[role=menuitem]')!;
		second.click();
		assert.deepEqual({ selected, hidden, filter: filter.value, root: dom.window.document.querySelector('.ash-action-widget') }, { selected: [1], hidden: 0, filter: 'run', root });
		assert.equal(root.querySelector('[role=tabpanel]')!.getAttribute('aria-labelledby'), root.querySelectorAll('[role=tab]')[1]!.id);
		finish();
		await Promise.resolve();
		await Promise.resolve();
		second.click();
		assert.deepEqual(selected, [1, 2]);
		service.hide();
		assert.equal(hidden, 1);
	} finally {
		dom.window.close();
	}
});

test('a dropdown opens typed actions and disposal cannot close a replacement menu', async () => {
	const dom = new JSDOM('<body><main></main></body>');
	try {
		using resources = new DisposableStore();
		const services = createServices(dom.window.document, resources);
		const service = services.get(IActionWidgetService);
		const selected: string[] = [];
		const dropdown = resources.add(services.createInstance(ActionWidgetDropdown, dom.window.document.querySelector<HTMLElement>('main')!, {
			label: 'Options', ariaLabel: 'Edit options',
			actions: [{ id: 'edit', label: 'Apply edit', tooltip: 'Apply edit', enabled: true, run: () => selected.push('edit') }],
		}));
		dropdown.element.focus();
		dropdown.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
		assert.equal(dropdown.element.getAttribute('aria-expanded'), 'true');
		dom.window.document.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
		await Promise.resolve();
		assert.deepEqual(selected, ['edit']);
		assert.equal(dropdown.element.getAttribute('aria-expanded'), 'false');
		dropdown.show();
		service.show('replacement', false, [{ kind: ActionListItemKind.Action, item: 1, label: 'Replacement' }], { onSelect: () => { }, onHide: () => { } }, dropdown.element);
		dropdown.dispose();
		assert.equal(service.isVisible, true);
		assert.equal(dom.window.document.querySelector('[role=menuitem]')!.textContent, 'Replacement');
	} finally {
		dom.window.close();
	}
});


test('filtered action updates retain model identity and expose metadata without visible descriptions', () => {
	const dom = new JSDOM('<body><button id="source">Models</button></body>');
	try {
		using resources = new DisposableStore();
		const document = dom.window.document;
		const service = createServices(document, resources).get(IActionWidgetService);
		const header = document.createElement('div');
		header.textContent = 'Auto';
		const footer = document.createElement('div');
		footer.textContent = 'Add Models';
		const selected: number[] = [];
		const focused: number[] = [];
		let help = 0;
		service.show('models', false, [
			{ id: 'first', kind: ActionListItemKind.Action, item: 1, label: 'First', detail: 'provider model-1', checked: true },
			{ id: 'second', kind: ActionListItemKind.Action, item: 2, label: 'Second', detail: 'provider model-2', checked: false },
		], { onSelect: item => { selected.push(item); }, onFocus: item => { focused.push(item); }, onHide: () => { } }, document.querySelector<HTMLElement>('#source')!, {
			presentation: 'details', header, footer, showFilter: true, focusFilterOnOpen: true, filterAsCombobox: true, accessibilityHelp: () => { help++; },
		});
		const root = document.querySelector<HTMLElement>('.ash-action-widget')!;
		const filter = root.querySelector<HTMLInputElement>('[role=combobox]')!;
		assert.equal(document.activeElement, filter);
		assert.equal(root.textContent?.includes('provider'), false);
		assert.equal(root.querySelector('[aria-label="Second"]')?.getAttribute('aria-description'), 'provider model-2');
		root.querySelector<HTMLButtonElement>('[aria-label="Second"]')!.focus();
		service.updateItems([
			{ id: 'first', kind: ActionListItemKind.Action, item: 3, label: 'First refreshed', checked: true },
			{ id: 'second', kind: ActionListItemKind.Action, item: 4, label: 'Second refreshed', detail: 'provider model-2', checked: false },
		]);
		assert.equal(document.activeElement?.getAttribute('aria-label'), 'Second refreshed');
		assert.equal(focused.at(-1), 4);
		service.focusFilter();
		filter.value = 'model-2';
		filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		assert.equal(root.querySelectorAll('[role=menuitemradio]').length, 1);
		filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.deepEqual(selected, [4]);
		filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F1', altKey: true, bubbles: true, cancelable: true }));
		assert.equal(help, 1);
		service.updateItems([], { filterVisible: false, itemsVisible: false });
		assert.equal(filter.closest<HTMLElement>('.ash-action-widget-filter')?.hidden, true);
		assert.equal(root.querySelector<HTMLElement>('.ash-action-widget-items')?.hidden, true);
		assert.equal(header.isConnected && footer.isConnected, true);
		service.hide();
		assert.equal(header.isConnected || footer.isConnected, false);
	} finally {
		dom.window.close();
	}
});
