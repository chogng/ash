import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Keybinding, physicalKey } from '../../../src/ash/base/common/keybindings.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { WorkerBasedDiffProviderFactoryService } from '../../../src/ash/editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../src/ash/platform/accessibility/browser/accessibilityService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { KeybindingRegistry } from '../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { EditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { EditorPaneRegistry } from '../../../src/ash/workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { TextDiffEditor } from '../../../src/ash/workbench/browser/parts/editor/textDiffEditor.js';
import { StatusbarPart } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { isEditorPaneWithScrolling } from '../../../src/ash/workbench/common/editor.js';
import { createDiffEditorInput, DIFF_EDITOR_ID, isDiffEditorInput } from '../../../src/ash/workbench/common/editor/diffEditorInput.js';
import { BrowserEditorService } from '../../../src/ash/workbench/services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { IStatusbarService, StatusbarService } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import '../../../src/ash/workbench/contrib/scrollLocking/browser/scrollLocking.contribution.js';

const resources = new DisposableStore();
const root = document.createElement('div');
root.className = 'stanza-workbench';
root.style.cssText = 'position:relative;width:1200px;height:450px;display:flex;flex-direction:column';
document.body.append(root);
const services = resources.add(createTestEditorServices());
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IUserDataProfileService, new UserDataProfileService());
services.registerInstance(INotificationService, resources.add(new NotificationService()));
const contexts = services.get(IContextKeyService);
const registry = new KeybindingRegistry();
const layouts = resources.add(new BrowserKeyboardLayoutService({ navigator }));
const keys = resources.add(services.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document, commandService: commands, contextKeyService: contexts, keyboardLayoutService: layouts, registry,
}));
services.registerInstance(IKeybindingService, keys);
resources.add(registry.registerKeybindingRule({ command: 'workbench.action.holdLockedScrolling', keybinding: Keybinding.single(physicalKey('KeyL', { ctrlKey: true })) }));
resources.add(registry.registerKeybindingRule({ command: 'workbench.action.toggleLockedScrolling', keybinding: Keybinding.single(physicalKey('KeyL', { ctrlKey: true, shiftKey: true })) }));
services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({ root, contextKeyService: contexts, configurationService: services.get(IConfigurationService) })));
registerCodeEditorServices(services);
resources.add(bindColorTheme(services.get(IThemeService), root));
const store: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
	save: async () => ({ revision: undefined }),
};
const panes = new EditorPaneRegistry();
resources.add(panes.registerEditorPane({
	id: CODE_EDITOR_ID, name: 'Text', canOpen: input => isDiffEditorInput(input) ? EditorPaneMatch.None : EditorPaneMatch.Default,
	create: () => services.createInstance(TextResourceEditor, store, { lineWrapping: 'off', lineHeight: 20 }),
}));
const factory = new WorkerBasedDiffProviderFactoryService();
resources.add(panes.registerEditorPane({
	id: DIFF_EDITOR_ID, name: 'Diff', canOpen: input => isDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: () => services.createInstance(TextDiffEditor, store, { modelService: services.get(ITextModelResourceService), createComputationService: () => factory.createDiffProvider(), lineHeight: 20 }),
}));
const part = resources.add(services.createInstance(EditorPart, root, { registry: panes }));
part.layout({ width: 1200, height: 420 });
const editors = resources.add(new BrowserEditorService(part));
services.registerInstance(IEditorService, editors);
const statusbar = resources.add(new StatusbarService());
services.registerInstance(IStatusbarService, statusbar);
resources.add(services.createInstance(StatusbarPart, root, statusbar));
const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.syncScrolling']));
host.advance(WorkbenchPhase.Eventually);
const text = Array.from({ length: 200 }, (_, index) => `${index}: ${'abcdefghij '.repeat(25)}`).join('\n');
const input = (name: string) => ({ resource: URI.file(`/scroll/${name}.txt`), initialText: text, readOnly: true });
await part.openEditor(input('first'));
await part.openEditor(input('second'), {}, 'sideGroup');
await part.openEditor(createDiffEditorInput(input('before'), input('after')), {}, 'sideGroup');

const harness = {
	read() { return editors.visibleEditorPanes.filter(isEditorPaneWithScrolling).map(pane => pane.getScrollPosition()); },
	scroll(index: number, top: number, left: number) {
		const pane = editors.visibleEditorPanes[index];
		if (!isEditorPaneWithScrolling(pane)) throw new Error('Expected a scrollable pane');
		pane.setScrollPosition({ scrollTop: top, scrollLeft: left });
	},
	toggle: () => commands.executeCommand('workbench.action.toggleLockedScrolling'),
	async hideSecond() { part.setGroupVisible(part.groups[1].id, false); },
	async modal() { await part.openEditor(input('modal'), {}, 'modalGroup'); },
	async closeLast() { await part.closeEditor(part.activeInput!); },
	stop() { host.dispose(); },
	diffSides() {
		const pane = editors.visibleEditorPanes.find(pane => pane instanceof TextDiffEditor);
		const widget = pane?.getControl();
		return widget ? [widget.originalEditor.getScrollTop(), widget.modifiedEditor.getScrollTop()] : [];
	},
	dispose() { resources.dispose(); },
};
declare global { interface Window { ashScrollLockingIntegration: typeof harness; } }
window.ashScrollLockingIntegration = harness;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
