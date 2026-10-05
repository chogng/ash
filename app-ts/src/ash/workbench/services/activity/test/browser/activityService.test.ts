import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CompositeBar } from '../../../../browser/parts/compositeBar.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../../common/views.js';
import { ViewDescriptorService } from '../../../views/browser/viewDescriptorService.js';
import { ActivityService } from '../../browser/activityService.js';
import { NumberBadge } from '../../common/activity.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { builtinLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('ActivityService combines concurrent counts and descriptions and releases only their own activities', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const registry = ViewsRegistry;
	using container = registry.registerViewContainer({ id: 'test', title: 'Test', location: ViewContainerLocation.Sidebar });
	using contextKeys = new ContextKeyService();
	using views = new ViewDescriptorService({ registry }, contextKeys);
	using bar = new CompositeBar(dom.window.document.body, { activityHoverOptions: { position: () => HoverPosition.ABOVE }, viewDescriptorService: views, location: ViewContainerLocation.Sidebar, ariaLabel: 'Views' });
	using activity = new ActivityService(bar);
	using first = activity.showViewContainerActivity('test', new NumberBadge(2, '2 unsaved files'));
	using second = activity.showViewContainerActivity('test', new NumberBadge(3, '3 incoming changes'));
	const tab = (): HTMLElement => bar.domNode.querySelector('[role="tab"]')!;
	assert.equal(tab().getAttribute('aria-label'), 'Test, 2 unsaved files, 3 incoming changes');
	assert.equal(tab().querySelector('.ash-count-badge.small.ash-composite-bar-badge')?.textContent, '5');
	tab().focus();
	bar.toggleBadgeEnablement('test');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	second.dispose();
	assert.equal(tab().getAttribute('aria-label'), 'Test, 2 unsaved files');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	bar.toggleBadgeEnablement('test');
	assert.equal(tab().querySelector('.ash-count-badge')?.textContent, '2');
	assert.equal(dom.window.document.activeElement, tab());
	first.dispose();
	assert.equal(tab().getAttribute('aria-label'), 'Test');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	using remaining = activity.showViewContainerActivity('test', new NumberBadge(1, '1 remaining'));
	activity.dispose();
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	remaining.dispose();
	dom.window.close();
});

test('Activity Bar badge menu uses Chinese labels and restores independent visibility across workspaces', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using firstContainer = ViewsRegistry.registerViewContainer({ id: 'badge-first', title: 'First', location: ViewContainerLocation.Sidebar });
		using secondContainer = ViewsRegistry.registerViewContainer({ id: 'badge-second', title: 'Second', location: ViewContainerLocation.Sidebar });
		using contexts = new ContextKeyService();
		using views = new ViewDescriptorService({}, contexts);
		const options = { ownerWindow: dom.window as unknown as Window, workspaceId: 'first', flushInterval: 0 };
		using storage = new BrowserStorageService(options);
		let actions: readonly IAction[] = [];
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		using bar = new CompositeBar(dom.window.document.body, {
			activityHoverOptions: { position: () => HoverPosition.RIGHT }, viewDescriptorService: views,
			location: ViewContainerLocation.Sidebar, ariaLabel: 'Views', orientation: 'vertical', storageService: storage,
			contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); } },
			localizationService: { whenReady: Promise.resolve(), translate: (bundle, key, fallback) => catalog.bundles[bundle]?.[key] ?? fallback },
		});
		using activity = new ActivityService(bar);
		using first = activity.showViewContainerActivity('badge-first', new NumberBadge(1, 'First activity'));
		using second = activity.showViewContainerActivity('badge-second', new NumberBadge(2, 'Second activity'));
		const tab = bar.domNode.querySelector<HTMLElement>('[data-action-id="badge-first"]')!;
		tab.focus();
		tab.addEventListener('contextmenu', event => bar.showContextMenu(event), { once: true });
		tab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		await actions.find(action => action.label === '隐藏徽章')!.run();
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge'), null);
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-second"] .ash-count-badge')?.textContent, '2');
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ...options, workspaceId: 'second' });
		using restored = new CompositeBar(dom.window.document.body, {
			activityHoverOptions: { position: () => HoverPosition.RIGHT }, viewDescriptorService: views,
			location: ViewContainerLocation.Sidebar, ariaLabel: 'Views', orientation: 'vertical', storageService: restoredStorage,
			contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); } },
			localizationService: { whenReady: Promise.resolve(), translate: (bundle, key, fallback) => catalog.bundles[bundle]?.[key] ?? fallback },
		});
		using restoredActivity = new ActivityService(restored);
		using updated = restoredActivity.showViewContainerActivity('badge-first', new NumberBadge(8, 'Latest activity'));
		assert.deepEqual([restored.areBadgesEnabled('badge-first'), restored.areBadgesEnabled('badge-second')], [false, true]);
		const restoredTab = restored.domNode.querySelector<HTMLElement>('[data-action-id="badge-first"]')!;
		restoredTab.addEventListener('contextmenu', event => restored.showContextMenu(event), { once: true });
		restoredTab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		await actions.find(action => action.label === '显示徽章')!.run();
		assert.equal(restored.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge')?.textContent, '8');
		await restoredStorage.flush();
		const profileKey = 'ash.storage.profile.default';
		dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: profileKey, newValue: dom.window.localStorage.getItem(profileKey), storageArea: dom.window.localStorage }));
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge')?.textContent, '1');
		updated.dispose();
		assert.equal(restored.domNode.querySelector('.ash-count-badge'), null);
	} finally {
		dom.window.close();
	}
});
