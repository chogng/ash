import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
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
import { DISASSEMBLY_VIEW_ID, type IDisassembledInstruction, IDebugService, type IDebugVariable, type IDataBreakpointInfoResponse, type IDebugConfiguration, type IDebugCompound, START_DEBUG_COMMAND_ID } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { bindTestColorTheme } from './themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { create, createModel } from '../../../src/ash/editor/standalone/browser/standaloneEditor.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { IEditorService, type EditorOpenOptions } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { DebugConsoleViewPane } from '../../../src/ash/workbench/contrib/debug/browser/debugConsoleViewPane.js';
import { DebugViewTestServices, MockDebugService, MockDebugSession } from '../../../src/ash/workbench/contrib/debug/test/common/mockDebug.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debug.css';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';

if (new URLSearchParams(location.search).get('locale') === 'zh-cn') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const store = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = store.add(new TestThemeService(themes.light));
store.add(bindTestColorTheme(theme, document.body));
const resource = URI.file('/workspace/main.ts');
const launchControls = new URLSearchParams(location.search).has('launch-controls');
const debug = store.add(new MockDebugService({ name: 'main.ts', resource }));
if (launchControls) debug.compounds = [{ id: 'all', name: 'All', dirId: 'second', workspaceFolderName: 'Second', configurations: ['first', 'second'], stopAll: false }];
const session = debug.sessions[0] as MockDebugSession;
const launches: string[] = [];
if (launchControls) {
	const configuration = debug.configurations[0]!;
	debug.configurations = [
		{ ...configuration, id: 'first', name: 'Run', dirId: 'first', workspaceFolderName: 'First' },
		{ ...configuration, id: 'second', name: 'Run', dirId: 'second', workspaceFolderName: 'Second' },
	];
	debug.start = async (configuration?: IDebugConfiguration) => { launches.push(configuration!.id); return session; };
	debug.startCompound = async (compound?: IDebugCompound) => { launches.push(compound!.id); return debug.sessions; };
}
const disassemblyRequests: unknown[] = [];
let pendingDisassembly: DeferredPromise<readonly IDisassembledInstruction[]> | undefined;
let holdNextDisassembly = false;
session.disassemble = async (reference: string, offset: number, instructionOffset: number, instructionCount: number) => {
	disassemblyRequests.push({ reference, offset, instructionOffset, instructionCount });
	if (holdNextDisassembly) { holdNextDisassembly = false; return pendingDisassembly!.p; }
	return Array.from({ length: instructionCount }, (_, index) => ({ address: '0x' + (Number(reference) + offset + (instructionOffset + index) * 4).toString(16), instructionBytes: '90 90', instruction: 'mov r0, r1', symbol: index === 0 ? 'main' : undefined, location: new URLSearchParams(location.search).has('virtual') ? { name: 'generated.ts', sourceReference: 33 } : { name: 'main.ts', resource }, line: 2, column: 1 }));
};
session.stackTrace = async () => [{ id: 10, name: 'main', source: { name: 'main.ts', resource }, lineNumber: 2, columnNumber: 1, instructionPointerReference: new URLSearchParams(location.search).has('no-address') ? undefined : '0x1000' }];
StandaloneServices.initialize().registerInstance(IDebugService, debug);
const model = store.add(createModel('const answer = 42;\nconsole.log(answer);\nconsole.log("finished");', 'javascript', resource));
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, automaticLayout: true }));
if (new URLSearchParams(location.search).has('breakpoints')) {
	debug.toggleBreakpoint(resource, 2);
	debug.toggleBreakpoint(resource, 3);
}
let activeInput: IResourceEditorInput | undefined;
const openedSources: unknown[] = [];
const editors: IEditorService = {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, get activeEditor() { return activeInput; }, visibleEditors: [], visibleEditorPanes: [],
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
if (launchControls) {
	support.workspace.updateWorkspace({
		id: 'multi', folders: [
			{ id: 'first', uri: URI.file('/workspace'), name: 'First', index: 0 },
			{ id: 'second', uri: URI.file('/second'), name: 'Second', index: 1 },
		]
	});
}
const services = store.add(new InstantiationService(support.register(new ServiceCollection(
	[IDebugService, debug], [IEditorService, editors], [IThemeService, theme],
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
const { pane, part, container: debugContainer } = support.createContainer(services, document.querySelector<HTMLElement>('#debug')!);
pane.setVisible(true);
if (!new URLSearchParams(location.search).has('welcome')) debug.activate(session);
const debugConsole = debug.replModel;
if (new URLSearchParams(location.search).has('console')) {
	const container = document.createElement('div');
	document.body.append(container);
	const consolePane = store.add(new DebugConsoleViewPane(container, { id: 'debug.console.integration', title: 'Debug Console' }, debug));
	consolePane.setVisible(true);
}
let pendingAssignment: DeferredPromise<IDebugVariable> | undefined;
let pendingDataInfo: DeferredPromise<IDataBreakpointInfoResponse> | undefined;

window.ashDebugIntegration = {
	burstOutput: count => {
		const started = performance.now();
		for (let index = 0; index < count; index++) session.emitOutput(`burst-${index}\n`);
		return { duration: performance.now() - started, output: debugConsole.activeSession?.output };
	},
	openedSources: () => openedSources,
	launches: () => launches,
	refreshConfigurations: () => debug.refresh(),
	selectedConfiguration: () => debug.getConfigurationManager().selectedConfiguration?.id,
	reopenContainer: () => { part.setVisible(false); part.setVisible(true); part.showComposite(debugContainer.id); },
	startCommand: () => services.get(ICommandService).executeCommand(START_DEBUG_COMMAND_ID),
	disassemblyRequests: () => disassemblyRequests,
	stepRequests: () => session.operations,
	focusInstruction: reference => debug.focusStackFrame({ id: 10, name: 'main', lineNumber: 2, columnNumber: 1, instructionPointerReference: reference }),
	holdDisassembly: () => { holdNextDisassembly = true; pendingDisassembly = new DeferredPromise<readonly IDisassembledInstruction[]>(); },
	releaseDisassembly: () => { const pending = pendingDisassembly!; pendingDisassembly = undefined; return pending.complete([{ address: '0xdead', instruction: 'obsolete' }]); },
	assignments: () => session.assignments,
	breakpoints: () => debug.breakpoints.map(({ lineNumber, enabled, condition, hitCondition, logMessage }) => ({ lineNumber, enabled, condition, hitCondition, logMessage })),
	additionalBreakpoints: () => [...debug.functionBreakpoints, ...debug.dataBreakpoints, ...debug.instructionBreakpoints],
	setBreakpointCount: count => {
		debug.removeAllBreakpoints();
		for (let index = 0; index < count; index++) debug.toggleBreakpoint(resource, index + 1);
	},
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
	starting: () => { session.state = 'starting'; debug.activate(session); },
	dispose: () => store.dispose(),
};
window.addEventListener('pagehide', () => store.dispose(), { once: true });

declare global {
	interface Window {
		ashDebugIntegration: {
			burstOutput(count: number): { duration: number; output: string | undefined; };
			openedSources(): readonly unknown[];
			launches(): readonly string[];
			refreshConfigurations(): Promise<readonly unknown[]>;
			selectedConfiguration(): string | undefined;
			reopenContainer(): void;
			startCommand(): Promise<unknown>;
			disassemblyRequests(): readonly unknown[];
			stepRequests(): readonly string[];
			focusInstruction(reference: string): void;
			holdDisassembly(): void;
			releaseDisassembly(): Promise<void>;
			assignments(): readonly unknown[];
			breakpoints(): readonly unknown[];
			additionalBreakpoints(): readonly unknown[];
			setBreakpointCount(count: number): void;
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
			starting(): void;
			dispose(): void;
		};
	}
}
