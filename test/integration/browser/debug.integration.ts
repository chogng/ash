import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { StatusbarService, IStatusbarService } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { StatusbarPart } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js';
import { StatusBarColorProvider } from '../../../src/ash/workbench/contrib/debug/browser/statusbarColorProvider.js';
import { ChatContextPickService } from '../../../src/ash/workbench/services/chat/browser/chatContextPickService.js';
import { DebugChatContextContribution } from '../../../src/ash/workbench/contrib/debug/browser/debugChatIntegration.js';
import { ContentHoverController } from '../../../src/ash/editor/contrib/hover/browser/contentHoverController.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import type { IDebugBreakpoint } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { Position } from '../../../src/ash/editor/common/core/position.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import '../../../src/ash/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { QuickInputService } from '../../../src/ash/platform/quickinput/browser/quickInputService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { registerTestCodeEditorFeatures } from '../../fixtures/codeEditorFeatures.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { OpenFolderWorkspaceSupportContext } from '../../../src/ash/workbench/common/contextkeys.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import type { IDebugCompletionItem, IDebugCompletionsResponse } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
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
import { Repl } from '../../../src/ash/workbench/contrib/debug/browser/repl.js';
import { DebugViewTestServices, MockDebugService, MockDebugSession } from '../../../src/ash/workbench/contrib/debug/test/common/mockDebug.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debugViewlet.css';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';

if (new URLSearchParams(location.search).get('locale') === 'zh-cn') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const store = new DisposableStore();
store.add(registerTestCodeEditorFeatures(['editor.contrib.placeholderText', 'editor.contrib.hover', 'editor.contrib.marginHover']));
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = store.add(new TestThemeService(themes.light));
store.add(bindTestColorTheme(theme, document.body));
const resource = URI.file('/workspace/main.ts');
const launchControls = new URLSearchParams(location.search).has('launch-controls');
const debug = store.add(new MockDebugService({ name: 'main.ts', resource }));
if (launchControls) debug.compounds = [{ id: 'all', name: 'All', dirId: 'second', workspaceFolderName: 'Second', configurations: ['first', 'second'], stopAll: false }];
const session = debug.sessions[0] as MockDebugSession;
if (new URLSearchParams(location.search).has('loaded-sources')) {
	Object.defineProperty(session, 'capabilities', { value: { ...session.capabilities, supportsLoadedSourcesRequest: true } });
	session.loadedSources = async () => [{ name: 'generated.ts', sourceReference: 25 }];
}
if (new URLSearchParams(location.search).has('exception-details')) {
	Object.defineProperty(session, 'capabilities', { value: { ...session.capabilities, supportsExceptionInfoRequest: true } });
	Object.defineProperty(session, 'reason', { value: 'exception' });
	session.exceptionInfo = async () => ({ exceptionId: 'TypeError', description: 'Bad input', breakMode: 'always', details: { stackTrace: 'at main (main.ts:2)' } });
}
if (new URLSearchParams(location.search).has('editor-inspection')) session.variables = async () => [{ name: 'answer', value: '42', variablesReference: 0 }];
const completionRequests: Array<{ sessionId: string; frameId: number | undefined; threadId: number; text: string; lineNumber: number; column: number; cancelled: boolean; held: boolean; }> = [];
let holdNextCompletion = false;
let pendingCompletion: DeferredPromise<IDebugCompletionsResponse> | undefined;
if (new URLSearchParams(location.search).has('console-tools')) {
	for (const candidate of debug.sessions) {
		Object.defineProperty(candidate, 'capabilities', { value: Object.freeze({ ...candidate.capabilities, supportsCompletionsRequest: true, supportsCancelRequest: true, completionTriggerCharacters: ['.'] }) });
		candidate.completions = async (frameId, threadId, text, position, token) => {
			const held = holdNextCompletion;
			holdNextCompletion = false;
			const request = { sessionId: candidate.id, frameId, threadId, text, lineNumber: position.lineNumber, column: position.column, cancelled: token.isCancellationRequested, held };
			completionRequests.push(request);
			const cancellation = token.onCancellationRequested(() => { request.cancelled = true; });
			try {
				if (held) return await pendingCompletion!.p;
				const targets: IDebugCompletionItem[] = [
					{ label: 'alpha', text: 'alpha', start: 1, length: text.length, sortText: '01' },
					{ label: 'beta', text: 'beta', start: 1, length: text.length, sortText: '02' },
				];
				if (text === 'pre obj.pa tail') targets.push({ label: 'pair', text: 'pair(value)', start: 9, length: 2, selectionStart: 5, selectionLength: 5, sortText: '03', detail: 'pair with an argument' });
				return { body: { targets } };
			} finally { cancellation.dispose(); }
		};
	}
	store.add(toDisposable(() => { if (pendingCompletion && !pendingCompletion.isSettled) void pendingCompletion.complete({ body: { targets: [] } }); }));
}
const launches: string[] = [];
if (launchControls) {
	const configuration = debug.configurations[0]!;
	const name = new URLSearchParams(location.search).has('long-launch-name') ? 'Run configuration with a very long name' : 'Run';
	debug.configurations = [
		{ ...configuration, id: 'first', name, dirId: 'first', workspaceFolderName: 'First' },
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
if (new URLSearchParams(location.search).has('breakpoints')) {
	debug.toggleBreakpoint(resource, 2);
	debug.toggleBreakpoint(resource, 3);
}
if (new URLSearchParams(location.search).has('inline-breakpoint')) {
	debug.addBreakpoints([{ id: 'inline', resource, lineNumber: 2, columnNumber: 7, condition: 'answer > 0', enabled: true, verified: false }]);
}
let activeInput: IResourceEditorInput | undefined;
const openedSources: unknown[] = [];
const editors: IEditorService = {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, get activeEditor() { return activeInput; }, visibleEditors: [], activeEditorPane: undefined, visibleEditorPanes: [],
	openEditor: async (_input, options?: EditorOpenOptions, target?: Parameters<IEditorService['openEditor']>[2]) => {
		activeInput = _input;
		if (_input.editorId === DISASSEMBLY_VIEW_ID) {
			disassembly.domNode.hidden = false;
			await disassembly.setInput(_input, new AbortController().signal);
			disassembly.focus();
			return;
		}
		openedSources.push({ resource: _input.resource.toString(), initialText: _input.initialText, readOnly: _input.readOnly, line: options?.selection?.startLineNumber, ...(target ? { column: options?.selection?.startColumn, target } : {}) });
		if (options?.selection) editor.setSelection(options.selection);
	},
	focusActiveEditor: () => editor.focus(),
};
const support = store.add(new DebugViewTestServices(new URLSearchParams(location.search).has('empty') ? { id: 'empty' } : { id: 'workspace', uri: URI.file('/workspace') }));
// This test host implements Open Folder; advertise that capability
// so the welcome action follows the same gate as a real Workbench host.
const folderSupport = OpenFolderWorkspaceSupportContext.bindTo(StandaloneServices.get(IContextKeyService));
folderSupport.set(true);
store.add(toDisposable(() => folderSupport.reset()));
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
	[IAccessibleViewService, new SyncDescriptor(AccessibleViewService)],
	[IQuickInputService, new SyncDescriptor(QuickInputService)],
	[ICodeEditorService, StandaloneServices.get(ICodeEditorService)],
	[IConfigurationService, StandaloneServices.get(IConfigurationService)],
	[IContextKeyService, StandaloneServices.get(IContextKeyService)],
	[IKeybindingService, StandaloneServices.get(IKeybindingService)],
	[IContextMenuService, StandaloneServices.get(IContextMenuService)],
))));
registerCodeEditorServices(services);
services.registerInstance(ILayoutService, store.add(new BrowserLayoutService({ root: document.body })));
const openedLinks: string[] = [];
services.get(IOpenerService).setDefaultExternalOpener({ openExternal: async target => { openedLinks.push(target); return true; } });
const storage = store.add(new BrowserStorageService({ ownerWindow: window, workspaceId: new URLSearchParams(location.search).get('console-workspace') ?? 'debug-console-integration', flushInterval: 0 }));
services.registerInstance(IStorageService, storage);
StandaloneServices.initialize().registerInstance(IExtensionService, services.get(IExtensionService));
StandaloneServices.initialize().registerInstance(IAccessibleViewService, services.get(IAccessibleViewService));
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, automaticLayout: true }));

if (new URLSearchParams(location.search).has('status-color')) {
	const statusbar = store.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	const root = document.createElement('div');
	root.id = 'debug-statusbar';
	document.body.append(root);
	store.add(services.createInstance(StatusbarPart, root, statusbar));
	store.add(services.createInstance(StatusBarColorProvider));
}
const chatContexts = new ChatContextPickService();
store.add(new DebugChatContextContribution(debug, chatContexts));
const disassemblyContainer = document.createElement('div');
document.body.append(disassemblyContainer);
const disassembly = store.add(registerTestComponentServices(services).createInstance(DisassemblyView));
disassembly.create(disassemblyContainer);
disassembly.layout({ width: 900, height: 420 });
disassembly.domNode.hidden = true;
if (new URLSearchParams(location.search).has('welcome')) {
	debug.configurations = [];
}
const { part, container: debugContainer } = support.createContainer(services, document.querySelector<HTMLElement>('#debug')!);
if (!new URLSearchParams(location.search).has('welcome')) debug.activate(session);
const debugConsole = debug.replModel;
let consolePane: Repl | undefined;
let consoleContainer: HTMLElement | undefined;
function createConsole(): void {
	consolePane?.dispose();
	consoleContainer?.remove();
	consoleContainer = document.createElement('div');
	document.body.append(consoleContainer);
	consolePane = services.createInstance(Repl, consoleContainer, { id: 'debug.console.integration', title: 'Debug Console' });
	consolePane.setVisible(true);
	consolePane.layout(360, 0, 640);
}
if (new URLSearchParams(location.search).has('console')) {
	createConsole();
	store.add(toDisposable(() => { consolePane?.dispose(); consoleContainer?.remove(); }));
}
let pendingAssignment: DeferredPromise<IDebugVariable> | undefined;
let pendingDataInfo: DeferredPromise<IDataBreakpointInfoResponse> | undefined;

window.ashDebugIntegration = {
	getControl: () => editor,
	breakpointDefinitions: () => debug.breakpoints,
	createSplitEditor: () => {
		const node = document.createElement('div');
		node.id = 'editor-copy'; node.style.width = '600px'; node.style.height = '200px';
		document.body.append(node);
		store.add(create(node, { model, automaticLayout: true }));
	},
	endSessions: () => { for (const candidate of debug.sessions) (candidate as MockDebugSession).state = 'terminated'; debug.activate(undefined); },
	loadedSourcesView: async () => { await services.get(IViewsService).openView('workbench.debug.loadedScriptsView', true); },
	chatContext: async () => (await chatContexts.items[0].providePicks('parent'))[0]?.attachment.resolve(),
	debugHover: () => { editor.setPosition(new Position(2, 14)); editor.getContribution<ContentHoverController>('editor.contrib.hover')!.showContentHover(new Position(2, 14)); },
	quickAccess: () => services.get(IQuickInputService).quickAccess.show('debug '),
	showDebugHelp: () => services.get(IAccessibleViewService).show(AccessibleViewType.Help),
	consoleANSI: () => { session.emitOutput('\x1b[31;1merror\x1b[0m https://exa\x1b[32mmple.test\x1b[0m/path\n'); },
	command: id => services.get(ICommandService).executeCommand(id),
	notifications: () => support.notifications.model.getNotifications().map(notification => notification.message),
	consoleOutput: () => {
		const group = session.replElementsRevision + 1;
		session.emitConsoleEntry({ kind: 'group', output: 'Build group\n', collapsed: true });
		session.emitConsoleEntry({ output: 'Alpha success\n', parentId: group });
		session.emitConsoleEntry({ output: 'Beta failure\n', parentId: group });
		session.emitConsoleEntry({ output: 'Gamma outside\n' });
	},
	consoleStats: () => consolePane!.getFilterStats(),
	consoleInput: () => {
		const editor = consolePane!.getReplInput();
		const model = editor.getModel()!;
		const selection = editor.getSelection()!;
		return { value: editor.getValue(), start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()), selection: model.getValueInRange(selection), lineCount: model.getLineCount(), height: editor.getDomNode().getBoundingClientRect().height };
	},
	consoleAccessibility: () => {
		const actualViews = services.get(IViewsService);
		const getView = actualViews.getViewWithId.bind(actualViews);
		actualViews.getViewWithId = () => consolePane as never;
		try {
			const content = (type: AccessibleViewType): string => {
				const provider = AccessibleViewRegistry.getImplementations().find(item => item.name === `debug.repl.${type}`)!.getProvider(services)!;
				try { return provider.provideContent(); } finally { provider.dispose(); }
			};
			return { help: content(AccessibleViewType.Help), view: content(AccessibleViewType.View) };
		} finally { actualViews.getViewWithId = getView; }
	},
	recreateConsole: () => createConsole(),
	consoleWorkspace: id => storage.switchWorkspace(id),
	resizeConsole: (width, height = 360) => { consoleContainer!.style.width = `${width}px`; consolePane!.layout(height, 0, width); },
	completionRequests: () => completionRequests,
	holdCompletion: () => { holdNextCompletion = true; pendingCompletion = new DeferredPromise<IDebugCompletionsResponse>(); },
	releaseCompletion: () => { const pending = pendingCompletion!; pendingCompletion = undefined; return pending.complete({ body: { targets: [{ label: 'obsolete-result' }] } }); },
	focusConsoleFrame: id => debug.focusStackFrame({ id, threadId: 2, name: `frame-${id}`, source: { name: 'main.ts', resource }, lineNumber: 2, columnNumber: 1 }),
	selectConsoleSession: id => debug.setActiveSession(debug.sessions.find(candidate => candidate.id === id)!),
	structuredOutput: () => {
		const group = session.replElementsRevision + 1;
		session.emitConsoleEntry({ kind: 'group', output: 'Structured group', collapsed: true });
		session.emitConsoleEntry({ output: 'Object output', variablesReference: 20, parentId: group, category: 'stderr', source: { name: 'main.ts', path: '/workspace/main.ts' }, line: 2, column: 1 });
		session.emitConsoleEntry({ output: 'outside\n' });
	},
	burstOutput: count => {
		const started = performance.now();
		for (let index = 0; index < count; index++) session.emitOutput(`burst-${index}\n`);
		return { duration: performance.now() - started, output: debugConsole.activeSession?.output };
	},
	openedSources: () => openedSources,
	consoleLinks: () => {
		support.documents.set(resource.toString(), 'const answer = 42;\nconsole.log(answer);\n');
		session.emitOutput('See https://exa');
		session.emitOutput('mple.test/path?q=one#two.\n');
		session.emitOutput('File /workspace/main.ts:2:1 and /workspace/missing.ts:9\n');
	},
	openedLinks: () => openedLinks,
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
			getControl(): typeof editor;
			breakpointDefinitions(): readonly IDebugBreakpoint[];
			createSplitEditor(): void;
			endSessions(): void;
			loadedSourcesView(): Promise<void>;
			chatContext(): Promise<{ name: string; content: string; } | undefined>;
			debugHover(): void;
			quickAccess(): void;
			showDebugHelp(): boolean;
			consoleANSI(): void;
			command(id: string): Promise<unknown>;
			notifications(): readonly string[];
			consoleOutput(): void;
			consoleInput(): { value: string; start: number; end: number; selection: string; lineCount: number; height: number; };
			consoleStats(): { total: number; filtered: number; };
			consoleAccessibility(): { help: string; view: string; };
			recreateConsole(): void;
			consoleWorkspace(id: string): void;
			resizeConsole(width: number, height?: number): void;
			completionRequests(): readonly { sessionId: string; frameId: number | undefined; threadId: number; text: string; lineNumber: number; column: number; cancelled: boolean; held: boolean; }[];
			holdCompletion(): void;
			releaseCompletion(): Promise<void>;
			focusConsoleFrame(id: number): void;
			selectConsoleSession(id: string): void;
			structuredOutput(): void;
			burstOutput(count: number): { duration: number; output: string | undefined; };
			openedSources(): readonly unknown[];
			consoleLinks(): void;
			openedLinks(): readonly string[];
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
