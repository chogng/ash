import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/scm/browser/scm.contribution.js';
import { PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { SCMHistoryViewPane } from '../../../src/ash/workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { SCMViewService } from '../../../src/ash/workbench/contrib/scm/browser/scmViewService.js';
import { SCMService } from '../../../src/ash/workbench/contrib/scm/common/scmService.js';
import { ISCMViewService } from '../../../src/ash/workbench/contrib/scm/common/scm.js';
import type { ISCMHistoryProvider } from '../../../src/ash/workbench/contrib/scm/common/history.js';
const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const root = document.querySelector<HTMLElement>('#history-root')!;
const configuration = resources.add(new WorkbenchConfigurationService());
const dependencies = resources.add(createTestEditorServices(configuration));
registerCodeEditorServices(dependencies);
const services = resources.add(dependencies.createChild());
const themes = services.get(IThemeService) as TestThemeService;
themes.setColorTheme(lightColorTheme);
resources.add(bindTestColorTheme(themes, root));
services.registerInstance(ILayoutService, { mainContainer: root } as ILayoutService);
services.registerInstance(IMenuService, services.createInstance(MenuService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, services.get(IContextViewService), services.get(IContextMenuService))));
services.registerInstance(IAccessibleViewService, resources.add(services.createInstance(AccessibleViewService)));
services.registerInstance(IClipboardService, new BrowserClipboardService(navigator.clipboard));
// Editor transport is covered by smoke; this fixture owns only row and hover rendering.
services.registerInstance(IEditorService, { openEditor: async () => undefined } as unknown as IEditorService);
const scm = resources.add(new SCMService());
const view = resources.add(new SCMViewService(scm));
services.registerInstance(ISCMViewService, view);
const hash = 'a'.repeat(40);
const timestamp = 1_700_000_000;
const subject = `History metadata: a long title that uses the space previously occupied by the commit hash and date ${'long-commit-identifier'.repeat(6)}`;
const message = Array.from({ length: 24 }, (_, index) => `    Detail ${index + 1}: the complete explanation remains available without taking space from the history title.`).join('\n');
const provider: ISCMHistoryProvider = {
	onDidChange: Event.None,
	historyItemRef: observableValue('fixture.history.head', undefined),
	refresh() { },
	provideHistoryItems: async () => [{ id: hash, displayId: hash.slice(0, 7), parentIds: [], subject, message, remoteLinks: [{ name: 'origin', uri: URI.parse(`https://github.com/ash-test/history/commit/${hash}`) }], references: [{ id: 'localBranch:metadata-topic', name: 'metadata-topic', category: 'localBranch' }, { id: 'tag:metadata-v1', name: 'metadata-v1', category: 'tag' }] }],
	resolveHistoryItemDetails: async () => ({ authorName: 'History Author', authorEmail: 'history@example.invalid', timestamp: timestamp * 1000, message, statistics: { files: 2, additions: 2, deletions: 0 } }),
	provideHistoryItemChanges: async () => [],
	resolveHistoryItemChangeContents: async () => { throw new Error('Editor contents must be tested through the product host'); },
	resolveHistoryItemChatContext: async () => undefined,
	resolveHistoryItemChangeRangeChatContext: async () => undefined,
};
resources.add(scm.registerSCMProvider({
	id: 'fixture.history', providerId: 'git', label: 'History', rootUri: URI.file('/workspace'), groups: [], onDidChangeResources: Event.None,
	input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
	activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false, historyProvider: provider,
	refresh: async () => { }, activate: async () => { },
}));
const panes = resources.add(new PaneView(root));
const history = resources.add(services.createInstance(SCMHistoryViewPane, root, { id: 'fixture.history', title: 'History' }));
panes.addPane(history, 600);
panes.layout(600, 560);
history.setVisible(true);
const fixture = {
	hash, timestamp, subject, message,
	resize(width: number): void { root.style.width = `${width}px`; panes.layout(600, width); },
	setTheme(index: number): void { themes.setColorTheme([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]!); },
};
declare global { interface Window { ashSCMHistoryIntegration: typeof fixture; } }
window.ashSCMHistoryIntegration = fixture;
