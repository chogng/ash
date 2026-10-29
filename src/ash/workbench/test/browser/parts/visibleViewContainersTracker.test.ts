import { TestViewDescriptorService } from '../workbenchTestServices.js';
import '../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ContextKeyService, IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { VisibleViewContainersTracker } from '../../../browser/parts/visibleViewContainersTracker.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../common/views.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

class FixtureView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) { super(container, options); }
}

suite('VisibleViewContainersTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function fixture(resources: DisposableStore) {
		const registry = resources.add(new WorkbenchViewRegistry());
		const context = resources.add(new ContextKeyService());
		const services = resources.add(new InstantiationService());
		services.registerInstance(IContextKeyService, context);
		const descriptors = resources.add(new TestViewDescriptorService({ registry }, context));
		services.registerInstance(IViewDescriptorService, descriptors);
		return { registry, context, services, descriptors };
	}

	test('counts active containers independently of pane visibility and only emits changed counts', () => {
		using resources = new DisposableStore();
		const { registry, context, services, descriptors } = fixture(resources);
		const enabled = context.createKey<boolean>('enabled', false);
		resources.add(registry.registerViewContainer({ id: 'one', title: 'One', location: ViewContainerLocation.Sidebar }));
		resources.add(registry.registerViews('one', [{ id: 'one.view', title: 'One', hideByDefault: true, ctorDescriptor: new SyncDescriptor(FixtureView) }]));
		resources.add(registry.registerViewContainer({ id: 'two', title: 'Two', location: ViewContainerLocation.Sidebar }));
		resources.add(registry.registerViews('two', [{ id: 'two.view', title: 'Two', when: ContextKeyExpr.has('enabled'), ctorDescriptor: new SyncDescriptor(FixtureView) }]));
		const tracker = resources.add(services.createInstance(VisibleViewContainersTracker, ViewContainerLocation.Sidebar));
		assert.equal(tracker.visibleCount, 1);
		const changes: { before: number; after: number; }[] = [];
		resources.add(tracker.onDidChange(event => changes.push(event)));
		descriptors.getViewContainerModel('one').setVisible('one.view', true);
		enabled.set(true);
		enabled.set(true);
		descriptors.getViewContainerModel('two').setVisible('two.view', false);
		enabled.set(false);
		assert.equal(tracker.visibleCount, 1);
		assert.deepEqual(changes, [{ before: 1, after: 2 }, { before: 2, after: 1 }]);
	});

	test('tracks registration, moves and removal without keeping listeners at the old location', () => {
		using resources = new DisposableStore();
		const { registry, services, descriptors } = fixture(resources);
		const sidebar = resources.add(services.createInstance(VisibleViewContainersTracker, ViewContainerLocation.Sidebar));
		const auxiliary = resources.add(services.createInstance(VisibleViewContainersTracker, ViewContainerLocation.AuxiliaryBar));
		const changes: { before: number; after: number; }[] = [];
		resources.add(sidebar.onDidChange(event => changes.push(event)));
		const registration = resources.add(registry.registerViewContainer({ id: 'moving', title: 'Moving', location: ViewContainerLocation.Sidebar }));
		const views = resources.add(registry.registerViews('moving', [{ id: 'view', title: 'View', ctorDescriptor: new SyncDescriptor(FixtureView) }]));
		assert.deepEqual([sidebar.visibleCount, auxiliary.visibleCount], [1, 0]);
		descriptors.moveViewContainerToLocation(descriptors.getViewContainerById('moving')!, ViewContainerLocation.AuxiliaryBar);
		views.dispose();
		assert.deepEqual([sidebar.visibleCount, auxiliary.visibleCount], [0, 0]);
		resources.add(registry.registerViews('moving', [{ id: 'view', title: 'View', ctorDescriptor: new SyncDescriptor(FixtureView) }]));
		assert.deepEqual([sidebar.visibleCount, auxiliary.visibleCount], [0, 1]);
		descriptors.moveViewContainerToLocation(descriptors.getViewContainerById('moving')!, ViewContainerLocation.Sidebar);
		registration.dispose();
		assert.deepEqual([sidebar.visibleCount, auxiliary.visibleCount], [0, 0]);
		assert.deepEqual(changes, [
			{ before: 0, after: 1 }, { before: 1, after: 0 },
			{ before: 0, after: 1 }, { before: 1, after: 0 },
		]);
		sidebar.dispose();
		resources.add(registry.registerViewContainer({ id: 'later', title: 'Later', location: ViewContainerLocation.Sidebar }));
		resources.add(registry.registerViews('later', [{ id: 'later.view', title: 'Later', ctorDescriptor: new SyncDescriptor(FixtureView) }]));
		assert.equal(changes.length, 4);
	});

	test('requires the descriptor service during construction', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(VisibleViewContainersTracker, ViewContainerLocation.Sidebar), /viewDescriptorService/);
	});
});
