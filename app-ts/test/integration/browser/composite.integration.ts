import { h } from '../../../src/ash/base/browser/dom.js';
import '../../../src/ash/base/browser/ui/actionbar/actionbar.css';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { PaneCompositePartService } from '../../../src/ash/workbench/browser/parts/paneCompositePartService.js';
import { PanelPart } from '../../../src/ash/workbench/browser/parts/panel/panelPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import type { IComposite } from '../../../src/ash/workbench/common/composite.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IWorkbenchLayoutService } from '../../../src/ash/workbench/services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IPaneCompositePartService } from '../../../src/ash/workbench/services/panecomposite/browser/panecomposite.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { ViewsService } from '../../../src/ash/workbench/services/views/browser/viewsService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { EditorPaneRegistry } from '../../../src/ash/workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import type { IEditorPane } from '../../../src/ash/workbench/common/editor.js';

interface CompositeState {
	readonly id: string;
	readonly title: string | undefined;
	readonly focused: boolean;
	readonly retained: boolean;
}

declare global {
	interface Window {
		ashCompositeIntegration: {
			readonly events: readonly string[];
			state(): readonly CompositeState[];
			open(id: string, focus?: boolean): Promise<void>;
			hide(): void;
			openView(id: string): Promise<void>;
			dispose(): void;
			reattachDisposed(): void;
			readonly editorEvents: readonly string[];
			readonly partEvents: readonly { id: string; focus?: boolean; visible: boolean; }[];
			openEditor(name: string): Promise<void>;
			closeEditor(name: string): Promise<void>;
			editorState(): readonly { name: string; focused: boolean; visible: boolean; retained: boolean; }[];
		};
	}
}

class FocusView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		for (const label of ['First input', 'Second input']) {
			const input = h(this.contentElement.ownerDocument, 'input');
			input.setAttribute('aria-label', label);
			this.contentElement.append(input);
		}
	}

	public override focus(): void {
		this.contentElement.querySelector<HTMLInputElement>('input')!.focus();
	}
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const registry = new WorkbenchViewRegistry();
for (const id of ['first', 'second']) {
	resources.add(registry.registerViewContainer({ id, title: `${id} container`, location: ViewContainerLocation.Panel }));
	resources.add(registry.registerViews(id, [{ id: `${id}.view`, title: `${id} view`, ctorDescriptor: new SyncDescriptor(FocusView) }]));
}
const services = resources.add(new InstantiationService());
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'composite', backend: window.localStorage, flushInterval: 0 })));
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, source) => source });
services.registerInstance(IViewDescriptorService, resources.add(services.createInstance(ViewDescriptorService, { registry })));
const commands = resources.add(new CommandService(services));
services.registerInstance(IMenuService, new MenuService(commands, contexts));
// Context menus and global layout are outside this content-focus scenario.
services.registerInstance(IContextMenuService, {
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() { },
});
const panel = resources.add(services.createInstance(PanelPart, document.body));
panel.domNode.style.cssText = 'position:relative;width:800px;height:160px';
panel.layout({ width: 800, height: 160 });
services.registerInstance(IWorkbenchLayoutService, {
	showPart: () => panel.setVisible(true),
	hidePart: () => panel.setVisible(false),
} as unknown as IWorkbenchLayoutService);
const panes = resources.add(services.createInstance(PaneCompositePartService, new Map([[ViewContainerLocation.Panel, panel]])));
services.registerInstance(IPaneCompositePartService, panes);
services.registerInstance(IViewsService, resources.add(services.createInstance(ViewsService)));
const views = services.get(IViewsService);
const composites = new Map<string, IComposite>();
const events: string[] = [];
for (const id of ['first', 'second']) {
	const composite = (await views.openViewContainer(id))!;
	composites.set(id, composite);
	resources.add(composite.onDidFocus(() => events.push(`${id}:focus`)));
	resources.add(composite.onDidBlur(() => events.push(`${id}:blur`)));
}
await views.openViewContainer('first');
const firstRoot = panel.getComposite('first')!.getControl().element;

const partEvents: { id: string; focus?: boolean; visible: boolean; }[] = [];
resources.add(panel.onDidCompositeOpen(({ composite, focus }) => partEvents.push({ id: composite.getId(), focus, visible: true })));
resources.add(panel.onDidCompositeClose(composite => partEvents.push({ id: composite.getId(), visible: false })));
const editorHost = h(document, 'div');
editorHost.style.cssText = 'position:relative;width:800px;height:260px';
document.body.append(editorHost);
resources.add(toDisposable(() => editorHost.remove()));
const resourceStore: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
	save: async () => ({ revision: undefined }),
};
const modelServices = resources.add(StandaloneServices.initialize().createChild());
const models = resources.add(new BrowserTextModelService(resourceStore));
modelServices.registerInstance(IFileTextModelService, models);
modelServices.registerInstance(ITextModelResourceService, models);
const editorServices = resources.add(createTestEditorServices(undefined, modelServices));
const editorRegistry = new EditorPaneRegistry();
resources.add(editorRegistry.registerEditorPane({
	id: CODE_EDITOR_ID, name: 'Text editor', canOpen: () => EditorPaneMatch.Default,
	create: () => editorServices.createInstance(TextResourceEditor, resourceStore, { lineNumbers: true }),
}));
const editor = resources.add(editorServices.createInstance(EditorPart, editorHost, { registry: editorRegistry }));
editor.layout({ width: 800, height: 260 });
const editorPanes = new Map<string, { pane: IEditorPane; control: unknown; }>();
const editorEvents: string[] = [];
const editorInput = (name: string) => ({ resource: URI.file(`/composite/${name}.ts`), label: `${name}.ts`, initialText: `const ${name} = 1;` });
async function openEditor(name: string): Promise<void> {
	const pane = await editor.openEditor(editorInput(name), { pinned: true, preserveFocus: true });
	if (!editorPanes.has(name)) {
		editorPanes.set(name, { pane, control: pane.getControl() });
		resources.add(pane.onDidFocus(() => editorEvents.push(`${name}:focus`)));
		resources.add(pane.onDidBlur(() => editorEvents.push(`${name}:blur`)));
	}
	pane.focus();
}

window.ashCompositeIntegration = {
	events,
	editorEvents,
	partEvents,
	openEditor,
	closeEditor: async name => { await editor.closeEditor(editorInput(name)); },
	editorState: () => [...editorPanes].map(([name, { pane, control }]) => ({ name, focused: pane.hasFocus(), visible: pane.isVisible(), retained: control === pane.getControl() })),
	state: () => [...composites].map(([id, composite]) => ({
		id: composite.getId(), title: composite.getTitle(), focused: composite.hasFocus(),
		retained: panel.getComposite(id) === composite && composite.getControl() === panel.getComposite(id)!.getControl(),
	})),
	open: async (id, focus) => { await views.openViewContainer(id, focus); },
	hide: () => views.closeViewContainer(panes.getActivePaneComposite(ViewContainerLocation.Panel)!.getId()),
	openView: async id => { await views.openView(id, true); },
	dispose: () => panel.dispose(),
	reattachDisposed: () => {
		const input = h(document, 'input');
		input.setAttribute('aria-label', 'Disposed input');
		firstRoot.hidden = false;
		firstRoot.append(input);
		document.body.append(firstRoot);
		resources.add(toDisposable(() => firstRoot.remove()));
	},
};
