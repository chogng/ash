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
import { ActionListItemKind } from '../../browser/actionList.js';

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
			onSelect: async () => { selected++; await pending; }, onHide: () => {},
		}, source);
		const button = dom.window.document.querySelector<HTMLButtonElement>('.ash-action-widget button')!;
		button.click();
		button.click();
		assert.equal(selected, 1);
		assert.equal(dom.window.document.querySelector('.ash-action-widget')?.getAttribute('aria-busy'), 'true');
		service.show('second', false, [{ kind: ActionListItemKind.Action, item: 2, label: 'Next' }], {
			onSelect: () => {}, onHide: () => {},
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
			onSelect: () => {}, onHide: () => {},
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
			onSelect: () => {}, onHide: () => {},
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
		], { onSelect: item => { selected.push(item); }, onHide: () => {} }, dom.window.document.querySelector<HTMLButtonElement>('#source')!, { showFilter: true });
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
		const selected: { item: number; preview: boolean | undefined }[] = [];
		service.show('preview', true, [
			{ kind: ActionListItemKind.Action, item: 1, label: 'No preview' },
			{ kind: ActionListItemKind.Action, item: 2, label: 'Preview edit', canPreview: true },
		], { onSelect: async (item, preview) => { selected.push({ item, preview }); await pending; }, onHide: () => {} }, dom.window.document.querySelector<HTMLButtonElement>('#source')!);
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
