import '../../../../../../base/browser/ui/styles.css';
import '../../../../../../platform/theme/common/sizes/baseSizes.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../../base/parts/ipc/common/ipc.js';
import { setNlsMessages } from '../../../../../../nls.js';
import messages from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IAccessibleViewService, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { BrowserClipboardService } from '../../../../../../platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IMainProcessService } from '../../../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { BrowserLayoutService, ILayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import type { IProcessService, IResolvedProcessInformation } from '../../../../../../platform/process/common/process.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { StandaloneServices } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import { EditorPanes } from '../../../../../browser/editor.js';
import { IEditorPart } from '../../../../../browser/parts/editor/editorPart.js';
import { ProcessExplorerEditor } from '../../../browser/processExplorerEditor.js';
import { AccessibleViewService } from '../../../../accessibility/browser/accessibleView.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import '../../../../../services/process/electron-browser/processService.js';
import '../../../electron-browser/processExplorer.contribution.js';
import '../../../../accessibility/browser/accessibilityConfiguration.js';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', messages); }
setARIAContainer(document.body);
const resources = new DisposableStore();
const root = document.querySelector<HTMLElement>('#explorer')!;
const configuration = resources.add(new InMemoryConfigurationService());
const contexts = resources.add(new ContextKeyService());
const services = resources.add(new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IConfigurationService, configuration], [IContextKeyService, contexts])));
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(themes.dark));
services.registerInstance(IThemeService, theme);
registerTestComponentServices(services);
services.registerInstance(IKeybindingService, StandaloneServices.get(IKeybindingService));
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: document.body })));
const menus: IContextMenuService = { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() { } };
services.registerInstance(IContextMenuService, menus);
const views = resources.add(new BrowserContextViewService(document.body));
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, views, menus)));
let copied = '';
services.registerInstance(IClipboardService, resources.add(new BrowserClipboardService({ writeText: async value => { copied = value; } } as Clipboard)));
let pane: ProcessExplorerEditor | undefined;
services.registerInstance(IEditorPart, { get activePane() { return pane; } } as IEditorPart);
services.registerInstance(IAccessibleViewService, resources.add(services.createInstance(AccessibleViewService)));
resources.add(bindTestColorTheme(theme, document.body));

let requests = 0;
let fail = false;
let snapshot: IResolvedProcessInformation = {
	pidToNames: [[101, 'Ash Main'], [102, 'Renderer: Editor']],
	processes: [{ name: 'Desktop', rootProcess: { name: 'ash', cmd: 'ash', pid: 101, ppid: 1, load: 2.5, mem: 16 * 2 ** 20, children: [{ name: 'renderer', cmd: 'renderer', pid: 102, ppid: 101, load: 1.2, mem: 8 * 2 ** 20 }, { name: 'worker', cmd: 'worker', pid: 103, ppid: 101, load: 0, mem: 4 * 2 ** 20 }] } }],
};
let held: DeferredPromise<IResolvedProcessInformation> | undefined;
const host: IProcessService = {
	_serviceBrand: undefined,
	resolveProcesses: async () => { requests++; if (held) { return held.p; } if (fail) { throw new Error('Collection failed'); } return snapshot; },
	getSystemInfo: async () => { throw new Error('Unexpected system collection'); },
	getSystemStatus: async () => { throw new Error('Unexpected status collection'); },
	getPerformanceInfo: async () => { throw new Error('Unexpected performance collection'); },
};
const server = ProxyChannel.fromService(host, resources);
services.registerInstance(IMainProcessService, {
	_serviceBrand: undefined,
	getChannel: name => { if (name !== 'process') { throw new Error('Unexpected channel'); } return { call: (command, args) => server.call('window:1', command, JSON.parse(JSON.stringify(args))), listen: () => Event.None }; },
	registerChannel() { },
});
services.registerInstance(IEditorService, {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], activeEditorPane: undefined, visibleEditorPanes: [],
	openEditor: async input => {
		if (pane) { pane.focus(); return; }
		pane = await EditorPanes.getEditorPane(input)!.create({ instantiationService: services }) as ProcessExplorerEditor;
		pane.create(root);
		pane.layout({ width: innerWidth, height: innerHeight });
		await pane.setInput(input, new AbortController().signal);
		pane.focus();
	},
	focusActiveEditor: () => pane?.focus(),
});
const commands = resources.add(new CommandService(services));
window.ashProcessExplorerIntegration = {
	open: () => commands.executeCommand('workbench.action.openProcessExplorer'),
	close: () => { pane?.dispose(); pane = undefined; },
	requests: () => requests,
	copy: () => copied,
	fail: value => { fail = value; },
	hold: () => { held = new DeferredPromise<IResolvedProcessInformation>(); },
	release: async () => { const pending = held!; held = undefined; await pending.complete(snapshot); },
	update: () => { snapshot = { pidToNames: [[101, 'Ash Main']], processes: [{ name: 'Desktop', rootProcess: { name: 'ash', cmd: 'ash', pid: 101, ppid: 1, load: 7.5, mem: 32 * 2 ** 20, children: [{ name: 'worker-new', cmd: 'worker-new', pid: 104, ppid: 101, load: 3, mem: 2 * 2 ** 20 }] } }] }; },
	malformed: () => { snapshot = { processes: [{ name: 'Desktop', rootProcess: { pid: -1 } }], pidToNames: [] } as unknown as IResolvedProcessInformation; },
	show: type => services.get(IAccessibleViewService).show(type === 'help' ? AccessibleViewType.Help : AccessibleViewType.View),
	verbosity: value => configuration.updateValue(AccessibilityVerbositySettingId.ProcessExplorer, value),
	theme: name => theme.setColorTheme(themes[name]),
	resize: width => pane?.layout({ width, height: innerHeight }),
	dispose: () => { pane?.dispose(); pane = undefined; resources.dispose(); },
};
window.addEventListener('pagehide', () => window.ashProcessExplorerIntegration.dispose(), { once: true });

declare global {
	interface Window {
		ashProcessExplorerIntegration: {
			open(): Promise<unknown>; close(): void; requests(): number; copy(): string; fail(value: boolean): void;
			hold(): void; release(): Promise<void>; update(): void; malformed(): void;
			show(type: 'help' | 'view'): boolean; verbosity(value: boolean): Promise<void>;
			theme(name: keyof typeof themes): void; resize(width: number): void; dispose(): void;
		};
	}
}
