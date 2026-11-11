import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { Dimension } from '../../../base/browser/dom.js';
import { AccessibilityService } from '../../../platform/accessibility/browser/accessibilityService.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import { DesktopEditorArea, desktopEditorTools, type DesktopEditorTool } from '../../browser/parts/desktopEditorArea.js';
import { DesktopEditorParts } from '../../browser/parts/desktopEditorParts.js';
import { DesktopMainEditorPart } from '../../browser/parts/desktopEditorPart.js';
import { DesktopToolEditorPart } from '../../browser/parts/desktopToolEditorPart.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { Event } from '../../../base/common/event.js';
import { registerTestWorkbenchInteractionServices } from '../../../workbench/test/browser/workbenchTestServices.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';

export function registerDesktopDetailsTestServices(resources: DisposableStore, services: InstantiationService): void {
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, new MenuService(commands, services.get(IContextKeyService)));
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
		showContextMenu() { }, hideContextMenu() { },
	});
	const interactions = resources.add(services.createChild());
	registerTestWorkbenchInteractionServices(resources, interactions);
	services.registerInstance(IViewsService, interactions.get(IViewsService));
	services.registerInstance(IViewDescriptorService, interactions.get(IViewDescriptorService));
}

/** Real tool hosts and coordinator with the same scoped contexts as Desktop bootstrap. */
export function createDesktopEditorTestServices(services: InstantiationService, options: IEditorPartOptions = {}, document: Document = globalThis.document) {
	const resources = new DisposableStore();
	const root = document.createElement('div');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	if (!services.has(IAccessibilityService)) {
		services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({
			root, contextKeyService: services.get(IContextKeyService), configurationService: services.get(IConfigurationService),
		})));
	}
	const area = resources.add(services.createInstance(DesktopEditorArea, root));
	const scope = () => {
		const container = document.createElement('div');
		area.domNode.append(container);
		const context = resources.add(services.get(IContextKeyService).createScoped(container));
		const child = resources.add(services.createChild());
		child.registerInstance(IContextKeyService, context);
		return { container, child, options: { ...options, contextKeyService: context } };
	};
	const filesScope = scope();
	const files = resources.add(filesScope.child.createInstance(DesktopMainEditorPart, filesScope.container, filesScope.options));
	const tools = new Map<Exclude<DesktopEditorTool, 'files'>, DesktopToolEditorPart>();
	for (const tool of desktopEditorTools) {
		if (tool === 'files') continue;
		const host = scope();
		tools.set(tool, resources.add(host.child.createInstance(DesktopToolEditorPart, host.container, host.options)));
	}
	const editor = resources.add(services.createInstance(DesktopEditorParts, files, area, tools));
	area.layout(new Dimension(1200, 900));
	return Object.assign(resources, { editor, files, tools, area });
}
