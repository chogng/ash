import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { DisassemblyView } from '../../../src/ash/workbench/contrib/debug/browser/disassemblyView.js';
import { DISASSEMBLY_VIEW_ID } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { type IDisassembledInstruction } from '../../../src/ash/workbench/services/debug/common/debugService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { create, createModel } from '../../../src/ash/editor/standalone/browser/standaloneEditor.js';
import { type TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { IDebugService, type IDebugVariable, type IDataBreakpointInfoResponse } from '../../../src/ash/workbench/services/debug/common/debugService.js';
import { IEditorService, type EditorOpenOptions } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { DebugViewPane } from '../../../src/ash/workbench/contrib/debug/browser/debugViewPane.js';
import { BreakpointEditorContribution } from '../../../src/ash/workbench/contrib/debug/browser/breakpointEditorContribution.js';
import { DebugViewTestServices, MockDebugService, MockDebugSession } from '../../../src/ash/workbench/contrib/debug/test/common/mockDebug.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debug.css';
import '../../../src/ash/base/browser/ui/styles.css';

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
const disassemblyRequests: unknown[] = [];
let pendingDisassembly: DeferredPromise<readonly IDisassembledInstruction[]> | undefined;
let holdNextDisassembly = false;
session.disassemble = async (reference: string, offset: number, instructionOffset: number, instructionCount: number) => {
	disassemblyRequests.push({ reference, offset, instructionOffset, instructionCount });
	if (holdNextDisassembly) { holdNextDisassembly = false; return pendingDisassembly!.p; }
	return Array.from({ length: instructionCount }, (_, index) => ({ address: '0x' + (Number(reference) + offset + (instructionOffset + index) * 4).toString(16), instructionBytes: '90 90', instruction: 'mov r0, r1', symbol: index === 0 ? 'main' : undefined, location: new URLSearchParams(location.search).has('virtual') ? { name: 'generated.ts', sourceReference: 33 } : { name: 'main.ts', resource }, line: 2, column: 1 }));
};
session.stackTrace = async () => [{ id: 10, name: 'main', source: { name: 'main.ts', resource }, lineNumber: 2, columnNumber: 1, instructionPointerReference: new URLSearchParams(location.search).has('no-address') ? undefined : '0x1000' }];
const model = store.add(createModel('const answer = 42;\nconsole.log(answer);\nconsole.log("finished");', 'javascript', resource));
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, automaticLayout: true }));
store.add(new BreakpointEditorContribution(editor, model as TextModel, debug));
if (new URLSearchParams(location.search).has('breakpoints')) {
	debug.toggleBreakpoint(resource, 2);
	debug.toggleBreakpoint(resource, 3);
}
let activeInput: IResourceEditorInput | undefined;
const openedSources: unknown[] = [];
const editors: IEditorService = {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, get activeEditor() { return activeInput; }, visibleEditors: [],
	openEditor: async (_input, options?: EditorOpenOptions) => {
		activeInput = _input;
		if (_input.editorId === DISASSEMBLY_VIEW_ID) {
			disassembly.domNode.hidden = false;
			await disassembly.setInput(_input, new AbortController().signal);
			disassembly.focus();
			return;
		}
		openedSources.push({ resource: _input.resource.toString(), initialText: _input.initialText, readOnly: _input.readOnly, line: options?.selection?.startLineNumber });
		if (options?.selection) editor.setSelection(options.selection);
	},
	focusActiveEditor: () => editor.focus(),
};
const support = store.add(new DebugViewTestServices(new URLSearchParams(location.search).has('empty') ? { id: 'empty' } : { id: 'workspace', uri: URI.file('/workspace') }));
const services = store.add(new InstantiationService(support.register(new ServiceCollection(
	[IDebugService, debug], [IEditorService, editors],
	[IConfigurationService, StandaloneServices.get(IConfigurationService)],
	[IContextKeyService, StandaloneServices.get(IContextKeyService)],
	[IKeybindingService, StandaloneServices.get(IKeybindingService)],
	[IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }],
	[IContextMenuService, { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } }],
))));
const disassemblyContainer = document.createElement('div');
document.body.append(disassemblyContainer);
const disassembly = store.add(registerTestComponentServices(services).createInstance(DisassemblyView));
disassembly.create(disassemblyContainer);
disassembly.layout({ width: 900, height: 420 });
disassembly.domNode.hidden = true;
if (new URLSearchParams(location.search).has('welcome')) {
	debug.configurations = [];
}
const pane = store.add(services.createInstance(DebugViewPane, document.querySelector<HTMLElement>('#debug')!, { id: 'debug.integration', title: 'Debug' }));
pane.setVisible(true);
if (!new URLSearchParams(location.search).has('welcome')) debug.activate(session);
let pendingAssignment: DeferredPromise<IDebugVariable> | undefined;
let pendingDataInfo: DeferredPromise<IDataBreakpointInfoResponse> | undefined;

window.ashDebugIntegration = {
	openedSources: () => openedSources,
	disassemblyRequests: () => disassemblyRequests,
	stepRequests: () => session.operations,
	focusInstruction: reference => debug.focusStackFrame({ id: 10, name: 'main', lineNumber: 2, columnNumber: 1, instructionPointerReference: reference }),
	holdDisassembly: () => { holdNextDisassembly = true; pendingDisassembly = new DeferredPromise<readonly IDisassembledInstruction[]>(); },
	releaseDisassembly: () => { const pending = pendingDisassembly!; pendingDisassembly = undefined; return pending.complete([{ address: '0xdead', instruction: 'obsolete' }]); },
	assignments: () => session.assignments,
	breakpoints: () => debug.breakpoints.map(({ lineNumber, enabled, condition, hitCondition, logMessage }) => ({ lineNumber, enabled, condition, hitCondition, logMessage })),
	additionalBreakpoints: () => [...debug.functionBreakpoints, ...debug.dataBreakpoints, ...debug.instructionBreakpoints],
	dataInfoRequests: () => session.dataInfoRequests,
	denyDataBreakpoint: () => { session.dataBreakpointInfo = async () => ({ dataId: null, description: 'The variable has no stable memory location.', canPersist: false, accessTypes: [] }); },
	holdDataInfo: () => {
		pendingDataInfo = new DeferredPromise<IDataBreakpointInfoResponse>();
		session.dataBreakpointInfo = async () => pendingDataInfo!.p;
	},
	releaseDataInfo: () => pendingDataInfo!.complete({ dataId: 'obsolete', description: 'parent', canPersist: false, accessTypes: ['write'] }),
	position: () => editor.getPosition()?.lineNumber,
	theme: name => theme.setColorTheme(themes[name]),
	resize: width => { document.querySelector<HTMLElement>('#debug')!.style.width = width + 'px'; },
	start: () => debug.activate(session),
	stop: () => debug.activate(undefined),
	folderOpens: () => support.folderOpens,
	clearConfigurations: () => { debug.configurations = []; return debug.refresh(); },
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
			openedSources(): readonly unknown[];
			disassemblyRequests(): readonly unknown[];
			stepRequests(): readonly string[];
			focusInstruction(reference: string): void;
			holdDisassembly(): void;
			releaseDisassembly(): Promise<void>;
			assignments(): readonly unknown[];
			breakpoints(): readonly unknown[];
			additionalBreakpoints(): readonly unknown[];
			dataInfoRequests(): readonly unknown[];
			denyDataBreakpoint(): void;
			holdDataInfo(): void;
			releaseDataInfo(): Promise<void>;
			position(): number | undefined;
			theme(name: keyof typeof themes): void;
			resize(width: number): void;
			start(): void;
			stop(): void;
			folderOpens(): number;
			clearConfigurations(): Promise<readonly unknown[]>;
			failAssignment(): void;
			holdAssignment(): void;
			releaseAssignment(): Promise<void>;
			resume(): void;
			dispose(): void;
		};
	}
}
