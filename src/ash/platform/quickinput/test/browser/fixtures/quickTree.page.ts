import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { formatNlsMessage, setNlsResolver } from '../../../../../nls.js';
import type { IQuickInput, IQuickTree, IQuickTreeItem } from '../../../common/quickInput.js';
import { IQuickInputService } from '../../../common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../storage/common/storage.js';
import { InstantiationService } from '../../../../instantiation/common/instantiationService.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../../theme/common/colorTheme.js';
import { TestThemeService } from '../../../../theme/test/common/testThemeService.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { TaskQuickPick } from '../../../../../workbench/contrib/tasks/browser/taskQuickPick.js';
import { ITaskService } from '../../../../../workbench/contrib/tasks/common/taskService.js';
import type { IWorkspaceTask } from '../../../../../workbench/contrib/tasks/common/tasks.js';
import { TestQuickInputService } from '../testQuickInputService.js';
import { IOpenerService } from '../../../../opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import type Severity from '../../../../../base/common/severity.js';
import { ContextKeyService } from '../../../../contextkey/browser/contextKeyService.js';
import { BrowserContextMenuService } from '../../../../contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../contextview/browser/contextViewService.js';
import { IContextMenuService } from '../../../../contextview/browser/contextView.js';
import type { IMenuService } from '../../../../actions/common/actions.js';
import type { IKeybindingService } from '../../../../keybinding/common/keybinding.js';
import { TestNotificationService } from '../../../../../workbench/services/notification/test/common/testNotificationService.js';

const resources = new DisposableStore();
const params = new URLSearchParams(location.search);
if (params.get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, values) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, values));
}
const theme = params.get('theme') === 'hc' ? highContrastDarkColorTheme : params.get('theme') === 'hcLight' ? highContrastLightColorTheme : params.get('theme') === 'dark' ? darkColorTheme : lightColorTheme;
resources.add(bindTestColorTheme(resources.add(new TestThemeService(theme)), document.body));
const scope = resources.add(new InstantiationService());
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'quick-tree-browser-test', flushInterval: 0 }));
if (params.has('pins')) storage.store('workbench.tasks.pinnedTasks', params.get('pins'), StorageScope.WORKSPACE, StorageTarget.USER);
scope.registerInstance(IStorageService, storage);
const opened: string[] = [];
scope.registerInstance(IOpenerService, { async open(target: string) { opened.push(target); return true; } } as unknown as IOpenerService);
const contexts = resources.add(new ContextKeyService());
const views = resources.add(new BrowserContextViewService(document.body));
scope.registerInstance(IContextMenuService, resources.add(new BrowserContextMenuService(
	{ getMenuActions() { throw new Error('Unexpected contributed menu'); } } as unknown as IMenuService,
	contexts, { lookupKeybinding: () => undefined } as unknown as IKeybindingService,
	views, resources.add(new TestNotificationService()),
)));
const service = resources.add(new TestQuickInputService({ container: document.body, instantiationService: scope, contextKeyService: contexts }));
scope.registerInstance(IQuickInputService, service);
const current = resources.add(new MutableDisposable<IQuickInput>());
let tree: IQuickTree<IQuickTreeItem> | undefined;
const buttonEvents: string[] = [];
const lifecycle: string[] = [];
const configureShared = (input: IQuickInput): void => {
	if (!params.has('shared')) return;
	input.title = 'Configure';
	input.step = 2;
	input.totalSteps = 3;
	input.description = '[Help](https://example.test/help)';
	input.buttons = [
		{ tooltip: 'Title toggle', toggle: { checked: false }, iconClass: 'ash-icon-pin' },
		{ tooltip: 'Title image', iconPath },
		{ label: 'More setting', secondary: true },
	];
	resources.add(input.onDidTriggerButton(button => buttonEvents.push(button.label ?? button.tooltip ?? '')));
	input.busy = true;
	resources.add(input.onWillHide(event => lifecycle.push(`will:${event.reason}`)));
	resources.add(input.onDidHide(event => lifecycle.push(`did:${event.reason}`)));
};
const iconPath = {
	dark: URI.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>')),
	light: URI.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')),
};
const result = document.createElement('output');
result.setAttribute('aria-label', 'Result');
const open = (label: string, action: () => void): void => {
	const button = document.createElement('button');
	button.textContent = label;
	resources.add(addDisposableListener(button, 'click', action));
	document.body.append(button);
};
open('Open tree', () => {
	tree = service.createQuickTree();
	current.value = tree;
	configureShared(tree);
	tree.ariaLabel = 'Tools';
	tree.matchOnDescription = true;
	tree.sortByLabel = false;
	const leaves: IQuickTreeItem[] = params.has('many')
		? Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, label: `Tool ${String(index).padStart(3, '0')}`, checked: index === 0 }))
		: [{ id: 'read', label: 'Read', checked: true }, { id: 'write', label: 'Write', description: 'files', buttons: [{ label: 'Details' }] }, { id: 'locked', label: 'Locked', disabled: true }];
	if (params.has('buttons')) leaves[1] = { ...leaves[1], buttons: [{ tooltip: 'Toggle tool', toggle: { checked: false } }, { tooltip: 'Theme image', iconPath, alwaysVisible: true }] };
	tree.setItemTree([{ id: 'group', label: 'Workspace', collapsed: !params.has('many'), children: leaves }, { id: 'other', label: 'Other', checked: true }]);
	resources.add(tree.onDidTriggerItemButton(({ item }) => buttonEvents.push(item.id!)));
	resources.add(tree.onDidAccept(() => { result.textContent = JSON.stringify(tree!.checkedLeafItems.map(item => item.id)); tree!.hide(); }));
	tree.show();
});
open('Open buttons', () => {
	const picker = service.createQuickPick();
	current.value = picker;
	configureShared(picker);
	picker.items = [{ label: 'Item', buttons: [
		{ id: 'image', label: 'Image', iconPath, alwaysVisible: true },
		{ id: 'toggle', label: 'Toggle', tooltip: 'Toggle tool', toggle: { checked: false } },
	] }];
	picker.show();
});
open('Open widget', () => {
	const widget = service.createQuickWidget();
	current.value = widget;
	const field = document.createElement('input');
	field.setAttribute('aria-label', 'Widget input');
	widget.widget = field;
	configureShared(widget);
	widget.show();
});
scope.registerInstance(ITaskService, {
	tasks: [{ id: 'build', label: 'Build', command: 'build', source: 'workspace' }, { id: 'test', label: 'Test', command: 'test', source: 'workspace' }],
	onDidChangeTasks: Event.None,
} as unknown as ITaskService);
open('Open tasks', () => {
	const picker = resources.add(scope.createInstance(TaskQuickPick, (tasks: readonly IWorkspaceTask[]) => tasks));
	void picker.show('Tasks').then(task => { result.textContent = task?.id ?? 'cancelled'; picker.dispose(); });
});
document.body.append(result);
window.quickTreeTest = {
	snapshot: () => ({ checked: tree!.checkedLeafItems.map(item => item.id), active: tree!.activeItems.map(item => item.id), collapsed: tree!.isCollapsed(tree!.itemTree[0]), buttonEvents }),
	dispose: () => { resources.dispose(); },
	setFilterOptions: (label, description) => { tree!.matchOnLabel = label; tree!.matchOnDescription = description; },
	setDescription: value => { tree!.description = value; },
	setValidation: (value, severity) => { tree!.severity = severity; tree!.validationMessage = value; },
	replaceItems: () => { tree!.setItemTree(tree!.itemTree.map(item => ({ ...item, children: item.children?.map(child => ({ ...child })) }))); },
	setEnabled: value => { current.value!.enabled = value; },
	setBusy: value => { current.value!.busy = value; },
	setAnchor: mode => {
		const input = current.value!;
		input.hide();
		input.anchor = mode === 'point' ? { x: 200, y: 180 } : document.querySelector('button');
		input.anchorPosition = mode === 'overlay' ? 'overlay' : 'below';
		input.show();
	},
	lifecycle,
	opened,
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

declare global {
	interface Window {
		quickTreeTest: {
			snapshot(): { checked: (string | undefined)[]; active: (string | undefined)[]; collapsed: boolean; buttonEvents: string[]; };
			dispose(): void;
			setFilterOptions(label: boolean, description: boolean): void;
			setDescription(value: string | undefined): void;
			setValidation(value: string | undefined, severity: Severity): void;
			replaceItems(): void;
			setEnabled(value: boolean): void;
			setBusy(value: boolean): void;
			setAnchor(mode: 'overlay' | 'point'): void;
			readonly lifecycle: string[];
			readonly opened: string[];
		};
	}
}
