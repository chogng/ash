import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { create, createModel } from '../../../src/ash/editor/standalone/browser/standaloneEditor.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { IDebugService, type IDebugVariable } from '../../../src/ash/workbench/services/debug/common/debugService.js';
import { IEditorService, type EditorOpenOptions } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { DebugViewPane } from '../../../src/ash/workbench/contrib/debug/browser/debugViewPane.js';
import { MockDebugService, MockDebugSession } from '../../../src/ash/workbench/contrib/debug/test/common/mockDebug.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debug.css';

if (new URLSearchParams(location.search).get('locale') === 'zh-cn') {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const store = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = store.add(new TestThemeService(themes.light));
store.add(bindColorTheme(theme, document.body));
const resource = URI.file('/workspace/main.ts');
const debug = store.add(new MockDebugService({ name: 'main.ts', resource }));
const session = debug.sessions[0] as MockDebugSession;
session.stackTrace = async () => [{ id: 10, name: 'main', source: { name: 'main.ts', resource }, lineNumber: 2, columnNumber: 1 }];
const model = store.add(createModel('const answer = 42;\nconsole.log(answer);\nconsole.log("finished");', 'javascript', resource));
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, automaticLayout: true }));
const editors: IEditorService = {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
	openEditor: async (_input, options?: EditorOpenOptions) => {
		if (options?.selection) editor.setSelection(options.selection);
	},
	focusActiveEditor: () => editor.focus(),
};
const services = store.add(new InstantiationService(new ServiceCollection(
	[IDebugService, debug], [IEditorService, editors],
	[IContextMenuService, { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() {}, hideContextMenu() {} }],
)));
const pane = store.add(services.createInstance(DebugViewPane, document.querySelector<HTMLElement>('#debug')!, { id: 'debug.integration', title: 'Debug' }));
pane.setVisible(true);
debug.activate(session);
let pendingAssignment: DeferredPromise<IDebugVariable> | undefined;

window.ashDebugIntegration = {
	assignments: () => session.assignments,
	position: () => editor.getPosition()?.lineNumber,
	theme: name => theme.setColorTheme(themes[name]),
	resize: width => { document.querySelector<HTMLElement>('#debug')!.style.width = width + 'px'; },
	failAssignment: () => { session.setVariable = async () => { throw new Error('Invalid value'); }; },
	holdAssignment: () => {
		pendingAssignment = new DeferredPromise<IDebugVariable>();
		session.setVariable = async () => pendingAssignment!.p;
	},
	releaseAssignment: () => pendingAssignment!.complete({ name: 'parent', value: 'obsolete', variablesReference: 0 }),
	resume: () => { session.state = 'running'; debug.activate(session); },
	dispose: () => store.dispose(),
};
window.addEventListener('pagehide', () => store.dispose(), { once: true });

declare global {
	interface Window {
		ashDebugIntegration: {
			assignments(): readonly unknown[];
			position(): number | undefined;
			theme(name: keyof typeof themes): void;
			resize(width: number): void;
			failAssignment(): void;
			holdAssignment(): void;
			releaseAssignment(): Promise<void>;
			resume(): void;
			dispose(): void;
		};
	}
}
