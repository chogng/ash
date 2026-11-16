import { Button } from '../../../../../base/browser/ui/button/button.js';
import { MultiSelectDropdown, type IMultiSelectDropdownSection } from '../../../../../platform/actionWidget/browser/multiSelectDropdown.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';

const sections: readonly IMultiSelectDropdownSection[] = [
	{ label: 'Weekdays', items: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(label => ({ id: label, label })) },
	{ label: 'Weekend', items: [{ id: 'Saturday', label: 'Saturday' }, { id: 'Sunday', label: 'Sunday', disabled: true }] },
];

function fixture(searchable: boolean): ReturnType<typeof defineComponentFixture> {
	return defineComponentFixture({
		render: async ({ container, disposableStore }) => {
			container.style.width = '340px';
			container.style.height = '360px';
			const services = disposableStore.add(new InstantiationService());
			services.registerInstance(IContextViewService, disposableStore.add(new BrowserContextViewService(container)));
			services.registerInstance(IConfigurationService, disposableStore.add(new InMemoryConfigurationService()));
			services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
			const dropdown = disposableStore.add(services.createInstance(MultiSelectDropdown));
			const button = disposableStore.add(new Button(container, { ...defaultButtonStyles, label: 'Choose days', presentation: 'secondary' }));
			const state = container.ownerDocument.createElement('output');
			state.setAttribute('aria-label', 'Selected days');
			container.append(state);
			let selectedIds: readonly string[] = ['Monday', 'Wednesday'];
			state.textContent = selectedIds.join(', ');
			disposableStore.add(dropdown.onDidChangeSelection(ids => {
				selectedIds = ids;
				state.textContent = ids.join(', ');
			}));
			const open = (): void => dropdown.show({ anchor: button.domNode, ariaLabel: 'Days', sections, selectedIds, searchable });
			disposableStore.add(button.onDidClick(open));
			open();
			// Capture the settled popup without the entrance animation's retained
			// transform layer, whose rounded edges can rasterize differently per browser.
			const animations = container.getAnimations({ subtree: true });
			await Promise.all(animations.map(animation => animation.finished));
			for (const animation of animations) animation.cancel();
			return [container];
		},
	});
}

export default defineThemedFixtureGroup({ path: 'editor/multiSelectDropdown/' }, {
	Weekdays: fixture(false),
	Searchable: fixture(true),
});
