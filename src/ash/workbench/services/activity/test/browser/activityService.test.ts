import { TestViewDescriptorService } from '../../../../test/browser/workbenchTestServices.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPane, type IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CompositeBar } from '../../../../browser/parts/compositeBar.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { ViewContainerLocation, WorkbenchViewRegistry } from '../../../../common/views.js';
import { ActivityService } from '../../browser/activityService.js';
import { NumberBadge } from '../../common/activity.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { productLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('activity counts abbreviate visually while retaining complete descriptions', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using registry = new WorkbenchViewRegistry();
		using container = registry.registerViewContainer({
			id: 'large-count',
			title: 'Changes',
			location: ViewContainerLocation.Sidebar,
		});
		using contexts = new ContextKeyService();
		using views = new TestViewDescriptorService({ registry }, contexts);
		using activity = new ActivityService(views);
		using bar = new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: views,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Views',
			},
			activity,
		);

		for (const [count, text] of [
			[13, '13'],
			[999, '999'],
			[1000, '1K'],
			[1234, '1K+'],
			[2000, '2K'],
		] as const) {
			using handle = activity.showViewContainerActivity('large-count', {
				badge: new NumberBadge(count, () => `${count} changes`),
			});
			const tab = bar.domNode.querySelector('[role="tab"]')!;
			assert.equal(tab.querySelector('.ash-count-badge')?.textContent, text);
			assert.equal(tab.getAttribute('aria-label'), `Changes, ${count} changes`);
			assert.equal(tab.querySelector('.ash-count-badge')?.getAttribute('aria-hidden'), 'true');
		}
		using zero = activity.showViewContainerActivity('large-count', {
			badge: new NumberBadge(0, () => 'No changes'),
		});
		assert.equal(bar.domNode.querySelector('.ash-count-badge'), null);
	} finally {
		dom.window.close();
	}
});

test('ActivityService combines concurrent counts and descriptions and releases only their own activities', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using registry = new WorkbenchViewRegistry();
	using container = registry.registerViewContainer({
		id: 'test',
		title: 'Test',
		location: ViewContainerLocation.Sidebar,
	});
	using contextKeys = new ContextKeyService();
	using views = new TestViewDescriptorService({ registry }, contextKeys);
	using activity = new ActivityService(views);
	using bar = new CompositeBar(
		dom.window.document.body,
		{
			overflowActionSize: 22,
			openComposite: async () => null,
			activityHoverOptions: { position: () => HoverPosition.ABOVE },
			viewDescriptorService: views,
			location: ViewContainerLocation.Sidebar,
			ariaLabel: 'Views',
		},
		activity,
	);

	using otherBar = new CompositeBar(
		dom.window.document.body,
		{
			overflowActionSize: 22,
			openComposite: async () => null,
			activityHoverOptions: { position: () => HoverPosition.ABOVE },
			viewDescriptorService: views,
			location: ViewContainerLocation.Sidebar,
			ariaLabel: 'Other views',
		},
		activity,
	);
	using first = activity.showViewContainerActivity('test', { badge: new NumberBadge(2, () => '2 unsaved files') });
	using second = activity.showViewContainerActivity('test', {
		badge: new NumberBadge(3, () => '3 incoming changes'),
	});
	const tab = (): HTMLElement => bar.domNode.querySelector('[role="tab"]')!;
	assert.equal(tab().getAttribute('aria-label'), 'Test, 2 unsaved files, 3 incoming changes');
	assert.equal(tab().querySelector('.ash-count-badge.small.ash-composite-bar-badge')?.textContent, '5');
	tab().focus();
	bar.toggleBadgeEnablement('test');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	assert.equal(otherBar.domNode.querySelector('.ash-count-badge')?.textContent, '5');
	second.dispose();
	assert.equal(tab().getAttribute('aria-label'), 'Test, 2 unsaved files');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	bar.toggleBadgeEnablement('test');
	assert.equal(tab().querySelector('.ash-count-badge')?.textContent, '2');
	assert.equal(dom.window.document.activeElement, tab());
	first.dispose();
	assert.equal(tab().getAttribute('aria-label'), 'Test');
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	using remaining = activity.showViewContainerActivity('test', { badge: new NumberBadge(1, () => '1 remaining') });
	activity.dispose();
	assert.equal(tab().querySelector('.ash-count-badge'), null);
	assert.equal(otherBar.domNode.querySelector('.ash-count-badge'), null);
	remaining.dispose();
	dom.window.close();
});

test('Activity Bar badge menu uses Chinese labels and restores independent visibility across workspaces', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using registry = new WorkbenchViewRegistry();
		using firstContainer = registry.registerViewContainer({
			id: 'badge-first',
			title: 'First',
			location: ViewContainerLocation.Sidebar,
		});
		using secondContainer = registry.registerViewContainer({
			id: 'badge-second',
			title: 'Second',
			location: ViewContainerLocation.Sidebar,
		});
		using contexts = new ContextKeyService();
		using views = new TestViewDescriptorService({ registry }, contexts);
		const options = { ownerWindow: dom.window as unknown as Window, workspaceId: 'first', flushInterval: 0 };
		using storage = new BrowserStorageService(options);
		let actions: readonly IAction[] = [];
		const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		using activity = new ActivityService(views);
		using bar = new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.RIGHT },
				viewDescriptorService: views,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Views',
				orientation: 'vertical',
				storageService: storage,
				contextMenuProvider: {
					showContextMenu: delegate => {
						actions = delegate.getActions();
					},
				},
				localizationService: {
					whenReady: Promise.resolve(),
					translate: (bundle, key, fallback) => catalog.bundles[bundle]?.[key] ?? fallback,
				},
			},
			activity,
		);

		using first = activity.showViewContainerActivity('badge-first', {
			badge: new NumberBadge(1, () => 'First activity'),
		});
		using second = activity.showViewContainerActivity('badge-second', {
			badge: new NumberBadge(2, () => 'Second activity'),
		});
		const tab = bar.domNode.querySelector<HTMLElement>('[data-action-id="badge-first"]')!;
		tab.focus();
		tab.addEventListener('contextmenu', event => bar.showContextMenu(event), { once: true });
		tab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		await actions.find(action => action.label === '隐藏徽章')!.run();
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge'), null);
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-second"] .ash-count-badge')?.textContent, '2');
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ...options, workspaceId: 'second' });
		using restoredActivity = new ActivityService(views);
		using restored = new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.RIGHT },
				viewDescriptorService: views,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Views',
				orientation: 'vertical',
				storageService: restoredStorage,
				contextMenuProvider: {
					showContextMenu: delegate => {
						actions = delegate.getActions();
					},
				},
				localizationService: {
					whenReady: Promise.resolve(),
					translate: (bundle, key, fallback) => catalog.bundles[bundle]?.[key] ?? fallback,
				},
			},
			restoredActivity,
		);

		using updated = restoredActivity.showViewContainerActivity('badge-first', {
			badge: new NumberBadge(8, () => 'Latest activity'),
		});
		assert.deepEqual(
			[restored.areBadgesEnabled('badge-first'), restored.areBadgesEnabled('badge-second')],
			[false, true],
		);
		const restoredTab = restored.domNode.querySelector<HTMLElement>('[data-action-id="badge-first"]')!;
		restoredTab.addEventListener('contextmenu', event => restored.showContextMenu(event), { once: true });
		restoredTab.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		await actions.find(action => action.label === '显示徽章')!.run();
		assert.equal(
			restored.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge')?.textContent,
			'8',
		);
		await restoredStorage.flush();
		const profileKey = 'ash.storage.profile.default';
		dom.window.dispatchEvent(
			new dom.window.StorageEvent('storage', {
				key: profileKey,
				newValue: dom.window.localStorage.getItem(profileKey),
				storageArea: dom.window.localStorage,
			}),
		);
		assert.equal(bar.domNode.querySelector('[data-action-id="badge-first"] .ash-count-badge')?.textContent, '1');
		updated.dispose();
		assert.equal(restored.domNode.querySelector('.ash-count-badge'), null);
	} finally {
		dom.window.close();
	}
});

test('view activity follows late registration and container changes without depending on a UI', () => {
	class ActivityView extends ViewPane {
		constructor(container: HTMLElement, options: IViewPaneOptions) {
			super(container, options);
		}
	}
	using registry = new WorkbenchViewRegistry();
	using first = registry.registerViewContainer({
		id: 'first',
		title: 'First',
		location: ViewContainerLocation.Sidebar,
	});
	using second = registry.registerViewContainer({
		id: 'second',
		title: 'Second',
		location: ViewContainerLocation.Panel,
	});
	using contexts = new ContextKeyService();
	using views = new TestViewDescriptorService({ registry }, contexts);
	using activity = new ActivityService(views);
	const changed: string[] = [];
	using listener = activity.onDidChangeActivity(container =>
		changed.push(typeof container === 'string' ? container : container.id),
	);
	const entry = { badge: new NumberBadge(4, count => `${count} changes`) };
	using handle = activity.showViewActivity('changes', entry);
	assert.deepEqual(activity.getViewContainerActivities('first'), []);
	assert.deepEqual(changed, []);
	using registration = new MutableDisposable();
	registration.value = registry.registerViews('first', [
		{ id: 'changes', title: 'Changes', ctorDescriptor: new SyncDescriptor(ActivityView) },
	]);
	assert.deepEqual(activity.getViewContainerActivities('first'), [entry]);
	assert.equal(changed.at(-1), 'first');
	registration.clear();
	assert.deepEqual(activity.getViewContainerActivities('first'), []);
	assert.equal(changed.at(-1), 'first');
	registration.value = registry.registerViews('second', [
		{ id: 'changes', title: 'Changes', ctorDescriptor: new SyncDescriptor(ActivityView) },
	]);
	assert.deepEqual(activity.getViewContainerActivities('second'), [entry]);
	assert.equal(changed.at(-1), 'second');
	handle.dispose();
	assert.deepEqual(activity.getViewContainerActivities('second'), []);
	assert.equal(changed.at(-1), 'second');
});
