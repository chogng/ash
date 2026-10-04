import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { type IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { HoverConfiguration } from '../../../src/ash/platform/hover/common/hoverService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { Link } from '../../../src/ash/platform/opener/browser/link.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { OutputViewPane } from '../../../src/ash/workbench/contrib/output/browser/outputViewPane.js';
import type { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { OutputService } from '../../../src/ash/workbench/services/output/browser/outputService.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';

declare global {
	interface Window {
		ashLinkIntegration: {
			readonly opened: readonly string[];
			readonly customOpened: readonly string[];
			readonly files: readonly { resource: string; line: number; column: number }[];
			setEnabled(enabled: boolean): void;
			update(label: string, title?: string, tabIndex?: number, elementLabel?: boolean): void;
			setTheme(index: number): void;
			blockOpening(): void;
			disposeLink(): void;
			appendOutput(): void;
			clearOutput(): void;
			disposeOutput(): void;
		}
	}
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const services = resources.add(new InstantiationService());
const configuration = resources.add(new InMemoryConfigurationService());
await configuration.updateValue(HoverConfiguration.delay, 0);
const contextViews = resources.add(new BrowserContextViewService(document.body));
// Menu presentation and editor display are boundaries outside this component scenario.
const menus: IContextMenuService = {
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() {},
};
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, contextViews, menus)));
services.registerInstance(ICodeEditorService, resources.add(new StandaloneCodeEditorService()));
const opener = resources.add(services.createInstance(OpenerService));
services.registerInstance(IOpenerService, opener);
const opened: string[] = [];
opener.setDefaultExternalOpener({ openExternal: async href => { opened.push(href); return true; } });
const themes = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme];
const themeService = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(themeService, document.body));
const link = resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#default-link')!, {
	label: 'Documentation', href: 'https://example.test/docs', title: 'Read documentation',
}, {}));
const customOpened: string[] = [];
resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#custom-link')!, {
	label: 'Custom action', href: 'https://example.test/custom',
}, { opener: (href: string) => customOpened.push(href), textLinkForeground: '#ff8080' }));
const output = resources.add(new OutputService());
const channel = resources.add(output.createChannel({ id: 'link-test', label: 'Link test' }));
const workspace = resources.add(new WorkspaceContextService({ id: 'link-test', uri: URI.file('/workspace') }));
const files: { resource: string; line: number; column: number }[] = [];
const editors: IEditorService = {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
	openEditor: async (input, options) => {
		const position = options!.selection!.getStartPosition();
		files.push({ resource: input.resource.toString(), line: position.lineNumber, column: position.column });
	}, focusActiveEditor() {},
};
const pane = resources.add(new OutputViewPane(document.querySelector<HTMLElement>('#output')!, { id: 'link-test', title: 'Output' }, output, menus, services, undefined, editors, workspace));
pane.setVisible(true);
channel.append({ text: 'src/main.ts:12:7: check this file', severity: 'warning' });
window.ashLinkIntegration = {
	opened, customOpened, files,
	setEnabled: enabled => { link.enabled = enabled; },
	update: (label, title, tabIndex, elementLabel) => {
		const content = document.createElement('span');
		content.textContent = label;
		link.link = { label: elementLabel ? content : label, href: 'https://example.test/updated', title, tabIndex };
	},
	setTheme: index => themeService.setColorTheme(themes[index]!),
	blockOpening: () => { resources.add(opener.registerValidator({ shouldOpen: async () => false })); },
	disposeLink: () => link.dispose(),
	appendOutput: () => channel.append({ text: 'src/other.ts(4,2): next file', severity: 'warning' }),
	clearOutput: () => channel.clear(),
	disposeOutput: () => pane.dispose(),
};
