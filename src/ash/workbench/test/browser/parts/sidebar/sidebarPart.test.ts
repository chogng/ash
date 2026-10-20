import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Sash } from '../../../../../base/browser/ui/sash/sash.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SidebarPart } from '../../../../browser/parts/sidebar/sidebarPart.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Position } from '../../../../services/layout/browser/layoutService.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { createTestComponentServices } from '../../../common/testEditorServices.js';

function createFixture(resources: DisposableStore) {
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const services = resources.add(createTestComponentServices());
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	const descriptors = resources.add(services.createInstance(ViewDescriptorService, {}));
	services.registerInstance(IViewDescriptorService, descriptors);
	return { container, services, descriptors };
}

suite('SidebarPart boundary sashes', () => {
	test('marks the inward edge, releases replaced boundaries and clears presentation on disposal', () => {
		using resources = new DisposableStore();
		const { container, services, descriptors } = createFixture(resources);
		let position = Position.LEFT;
		services.registerInstance(IWorkbenchLayoutService, {
			getSideBarPosition: () => position,
		} as IWorkbenchLayoutService);
		const sidebar = resources.add(services.createInstance(SidebarPart, container, {
			viewDescriptorService: descriptors, openComposite: async () => null,
		}));
		const left = resources.add(new Sash(container, 'vertical'));
		const right = resources.add(new Sash(container, 'vertical'));
		const replacement = resources.add(new Sash(container, 'vertical'));
		const states: boolean[][] = [];
		const record = () => states.push([left, right, replacement].map(sash => sash.element.classList.contains('ash-primary-sidebar-sash')));
		sidebar.setBoundarySashes({ left, right });
		record();
		position = Position.RIGHT;
		sidebar.setBoundarySashes({ left, right });
		record();
		sidebar.setBoundarySashes({ left: replacement });
		record();
		sidebar.setBoundarySashes({});
		record();
		sidebar.setBoundarySashes({ left });
		sidebar.dispose();
		record();
		assert.deepEqual(states, [
			[false, true, false],
			[true, false, false],
			[false, false, true],
			[false, false, false],
			[false, false, false],
		]);
		assert.equal(left.element.isConnected, true, 'Sidebar must not dispose Grid-owned sashes');
	});

	test('Agent Sidebar does not claim the primary sidebar boundary', () => {
		using resources = new DisposableStore();
		const { container, services, descriptors } = createFixture(resources);
		services.registerInstance(IWorkbenchLayoutService, { getSideBarPosition: () => Position.LEFT } as IWorkbenchLayoutService);
		const sidebar = resources.add(services.createInstance(SidebarPart, container, {
			id: 'agentSidebar', location: ViewContainerLocation.AgentSidebar,
			viewDescriptorService: descriptors, openComposite: async () => null,
		}));
		const sash = resources.add(new Sash(container, 'vertical'));
		sidebar.setBoundarySashes({ right: sash });
		assert.equal(sash.element.classList.contains('ash-primary-sidebar-sash'), false);
	});

	test('construction requires the host layout service', () => {
		using resources = new DisposableStore();
		const { container, services, descriptors } = createFixture(resources);
		assert.throws(() => services.createInstance(SidebarPart, container, {
			viewDescriptorService: descriptors, openComposite: async () => null,
		}), /layoutService/);
	});
});
