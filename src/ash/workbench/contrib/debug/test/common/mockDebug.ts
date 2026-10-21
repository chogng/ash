import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { getUriFromSource } from '../../common/debugSource.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { DISASSEMBLY_VIEW_ID } from '../../common/debug.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { localize } from '../../../../../nls.js';
import { ViewModel } from '../../common/debugViewModel.js';
import type { DebugConsoleEntry } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { ConfigurationManager } from '../../browser/debugConfigurationManager.js';
import { ReplModel } from '../../common/replModel.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ModelService } from '../../../../../editor/common/services/modelService.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextModelResolverService } from '../../../../services/textmodelResolver/common/textModelResolverService.js';
import { DebugContentProvider } from '../../common/debugContentProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type IDebugAdapterTrackerFactory, type DebugAdapterTrackerFactoryRegistration, type DebugConfiguration, type DebugConfigurationProviderRegistration, type IDebugConfigurationProvider, IDebugService, type DebugBreakpoint, type IBaseBreakpoint, type IDataBreakpoint, type IDataBreakpointInfoResponse, type IDataBreakpointOptions, type IFunctionBreakpoint, type IFunctionBreakpointOptions, type IInstructionBreakpoint, type IInstructionBreakpointOptions, type DebugEvaluateContext, type DebugSessionState, type DebugSteppingGranularity, type IDebugBreakpoint, type IDebugBreakpointUpdate, type IDebugCompound, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugScope, type IDebugSession, type IDisassembledInstruction, type IDebugSource, type IDebugSourceContent, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from '../../common/debug.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createFileSystemProviderError, FileKind, FileNotFoundError, FileSystemProviderErrorCode, IFileService, type IFileStat, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService, type IAnyWorkspaceIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ViewsRegistry, IViewDescriptorService, ViewContainerLocation, WorkbenchViewContainerId } from '../../../../common/views.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import '../../browser/debug.contribution.js';
import { DebugViewPaneContainer } from '../../browser/debugViewlet.js';
import { PaneCompositePart } from '../../../../browser/parts/paneCompositePart.js';
import { IActivityService } from '../../../../services/activity/common/activity.js';
import { ActivityService } from '../../../../services/activity/browser/activityService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ViewsService } from '../../../../services/views/browser/viewsService.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';

export class MockDebugService extends Disposable implements IDebugService {
	public readonly onWillNewSession = Event.None;
	public readonly onDidNewSession = Event.None;
	public readonly onDidEndSession = Event.None;
	public readonly onDidWriteTerminalData = Event.None;
	private readonly configurationManager = this._register(new ConfigurationManager());
	private readonly breakpointEmitter = this._register(new Emitter<readonly DebugBreakpoint[]>());
	private readonly watchEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	private readonly viewModel = this._register(new ViewModel());
	public getViewModel(): ViewModel { return this.viewModel; }
	private focusGeneration = 0;
	public onNavigationError: (error: unknown) => void = () => { };
	public navigateFrame: ((frame: IDebugStackFrame, session: IDebugSession, isCurrent: () => boolean, explicit: boolean, preserveFocus?: boolean) => Promise<void>) | undefined;
	public async focusStackFrame(frame: IDebugStackFrame | undefined, thread?: IDebugThread, session = this.session, options?: { explicit?: boolean; preserveFocus?: boolean; }): Promise<void> {
		const generation = ++this.focusGeneration;
		this.viewModel.setFocus(frame, thread, session, options?.explicit ?? true);
		if (frame && session) await this.navigateFrame?.(frame, session, () => !this.isDisposed && generation === this.focusGeneration && this.session === session && session.state === 'stopped', options?.explicit ?? true, options?.preserveFocus);
	}
	public getConfigurationManager(): ConfigurationManager { return this.configurationManager; }
	public get configurations(): readonly IDebugConfiguration[] { return this.configurationManager.configurations; }
	public set configurations(value: readonly IDebugConfiguration[]) { this.configurationManager.setConfigurations(value, this.compounds); }
	public readonly operations: string[] = [];
	public get compounds(): readonly IDebugCompound[] { return this.configurationManager.compounds; }
	public set compounds(value: readonly IDebugCompound[]) { this.configurationManager.setConfigurations(this.configurations, value); }
	public breakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	public functionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	public dataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	public instructionBreakpoints: readonly IInstructionBreakpoint[] = Object.freeze([]);
	private nextBreakpointId = 0;
	public watchExpressions: readonly string[] = Object.freeze(['answer']);
	public exceptionBreakpoints: readonly string[] = Object.freeze(['uncaught']);
	public readonly sessions: readonly IDebugSession[];
	public session: IDebugSession | undefined;
	public readonly replModel: ReplModel;
	public getSession(id: string): IDebugSession | undefined { return this.sessions.find(session => session.id === id); }
	public readonly onDidChangeConfigurations = this.configurationManager.onDidChangeConfigurations;
	public readonly onDidChangeBreakpoints = this.breakpointEmitter.event;
	public readonly onDidChangeWatchExpressions = this.watchEmitter.event;
	public readonly onDidChangeExceptionBreakpoints = this.exceptionEmitter.event;
	public readonly onDidChangeSession = this.sessionEmitter.event;
	constructor(source: IDebugSource = { name: 'generated.ts', sourceReference: 33 }) {
		super();
		this.configurations = [configuration('One')];
		this.sessions = Object.freeze([this._register(new MockDebugSession('session-one', 'One', source)), this._register(new MockDebugSession('session-two', 'Two', source))]);
		this.replModel = this._register(new ReplModel(this));
		for (const session of this.sessions) this._register(session.onDidChangeThread(() => {
			if (this.session === session) this.activate(session);
		}));
	}
	public initialConfigurations: readonly DebugConfiguration[] = [];
	public async provideDebugConfigurations(_folder: URI, _signal?: AbortSignal): Promise<readonly DebugConfiguration[]> { return this.initialConfigurations; }
	public registerDebugAdapterTrackerFactories(_factories: readonly IDebugAdapterTrackerFactory[]): DebugAdapterTrackerFactoryRegistration {
		const registration = toDisposable(() => { }) as DebugAdapterTrackerFactoryRegistration;
		registration.replace = () => { };
		return registration;
	}
	public registerDebugConfigurationProviders(_providers: readonly IDebugConfigurationProvider[]): DebugConfigurationProviderRegistration {
		const registration = toDisposable(() => { }) as DebugConfigurationProviderRegistration;
		registration.replace = () => { };
		return registration;
	}
	public async refresh(): Promise<readonly IDebugConfiguration[]> { return this.configurations; }
	public async start(): Promise<IDebugSession> { this.operations.push('start'); return this.sessions[0]!; }
	public async startDynamicDebugging(_folder: URI, _configuration: DebugConfiguration): Promise<IDebugSession> { this.operations.push('startDynamic'); return this.sessions[0]!; }
	public async startDebugging(): Promise<IDebugSession> { return this.sessions[0]!; }
	public async startCompound(): Promise<readonly IDebugSession[]> { return this.sessions; }
	public setActiveSession(session: IDebugSession): void { this.activate(session); }
	public async restart(session = this.session): Promise<IDebugSession> { return session!; }
	public async stop(): Promise<void> { this.operations.push('stop'); }
	public async stopAll(): Promise<void> { }
	public addBreakpoints(): void { throw new Error('Bulk breakpoints are unsupported in this fixture'); }
	public removeBreakpoints(ids: readonly string[]): void { for (const id of ids) { this.removeBreakpoint(id); } }
	public toggleBreakpoint(resource: URI, lineNumber: number): void {
		const id = `${resource.toString()}:${lineNumber}`;
		if (this.breakpoints.some(point => point.id === id)) this.removeBreakpoint(id);
		else {
			this.breakpoints = Object.freeze([...this.breakpoints, { id, resource, lineNumber, enabled: true, verified: false }]);
			this.breakpointEmitter.fire(this.breakpoints);
		}
	}
	public removeBreakpoint(id: string): void {
		this.breakpoints = Object.freeze(this.breakpoints.filter(point => point.id !== id));
		this.functionBreakpoints = Object.freeze(this.functionBreakpoints.filter(point => point.id !== id));
		this.dataBreakpoints = Object.freeze(this.dataBreakpoints.filter(point => point.id !== id));
		this.instructionBreakpoints = Object.freeze(this.instructionBreakpoints.filter(point => point.id !== id));
		this.breakpointEmitter.fire(this.breakpoints);
	}
	public updateBreakpoint(id: string, update: IDebugBreakpointUpdate): void {
		const change = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => point.id === id ? { ...point, ...update } : point));
		this.breakpoints = change(this.breakpoints);
		this.functionBreakpoints = change(this.functionBreakpoints);
		this.dataBreakpoints = change(this.dataBreakpoints);
		this.instructionBreakpoints = change(this.instructionBreakpoints);
		this.breakpointEmitter.fire(this.breakpoints);
	}
	public setBreakpointsEnabled(enabled: boolean): void {
		this.breakpoints = Object.freeze(this.breakpoints.map(point => ({ ...point, enabled })));
		this.functionBreakpoints = Object.freeze(this.functionBreakpoints.map(point => ({ ...point, enabled })));
		this.dataBreakpoints = Object.freeze(this.dataBreakpoints.map(point => ({ ...point, enabled })));
		this.instructionBreakpoints = Object.freeze(this.instructionBreakpoints.map(point => ({ ...point, enabled })));
		this.breakpointEmitter.fire(this.breakpoints);
	}
	public removeAllBreakpoints(): void {
		this.breakpoints = Object.freeze([]);
		this.functionBreakpoints = Object.freeze([]);
		this.dataBreakpoints = Object.freeze([]);
		this.instructionBreakpoints = Object.freeze([]);
		this.breakpointEmitter.fire([]);
	}
	public addFunctionBreakpoint(options: IFunctionBreakpointOptions): void {
		this.functionBreakpoints = Object.freeze([...this.functionBreakpoints, { ...options, kind: 'function', id: `function-${++this.nextBreakpointId}`, enabled: true, verified: false }]);
		this.breakpointEmitter.fire(this.functionBreakpoints);
	}
	public addDataBreakpoint(options: IDataBreakpointOptions): void {
		this.dataBreakpoints = Object.freeze([...this.dataBreakpoints, { ...options, kind: 'data', adapterType: this.session!.configuration.type, id: `data-${++this.nextBreakpointId}`, enabled: true, verified: false }]);
		this.breakpointEmitter.fire(this.dataBreakpoints);
	}
	public addInstructionBreakpoint(options: IInstructionBreakpointOptions): void {
		this.instructionBreakpoints = Object.freeze([...this.instructionBreakpoints, { ...options, kind: 'instruction', sessionId: this.session!.id, id: `instruction-${++this.nextBreakpointId}`, enabled: true, verified: false }]);
		this.breakpointEmitter.fire(this.instructionBreakpoints);
	}
	public addWatchExpression(expression: string): void {
		if (!expression.trim()) return;
		this.watchExpressions = Object.freeze([...this.watchExpressions, expression]);
		this.watchEmitter.fire(this.watchExpressions);
	}
	public removeWatchExpression(expression: string): void {
		this.watchExpressions = Object.freeze(this.watchExpressions.filter(candidate => candidate !== expression));
		this.watchEmitter.fire(this.watchExpressions);
	}
	public async setExceptionBreakpoints(filters: readonly string[]): Promise<void> { this.exceptionBreakpoints = Object.freeze([...filters]); this.exceptionEmitter.fire(this.exceptionBreakpoints); }
	public activate(session: IDebugSession | undefined): void {
		this.session = session;
		void this.focusStackFrame(undefined);
		this.sessionEmitter.fire(session);
		const generation = this.focusGeneration;
		if (session?.state === 'stopped') void session.inspectStack(session.threadId).then(inspection => {
			if (this.isDisposed || generation !== this.focusGeneration || this.session !== session || session.state !== 'stopped') return;
			session.selectThread(inspection.threadId!);
			this.viewModel.setFocus(inspection.frames[0], inspection.threads.find(thread => thread.id === inspection.threadId), session, false);
			if (inspection.frames[0]) return this.navigateFrame?.(inspection.frames[0], session, () => !this.isDisposed && generation === this.focusGeneration && this.session === session && session.state === 'stopped', false);
		}).catch(error => this.onNavigationError(error));
	}
}

export class MockDebugSession extends Disposable implements IDebugSession {
	inspectionRevision = 0;
	readonly onDidProgressStart = Event.None;
	readonly onDidProgressUpdate = Event.None;
	readonly onDidProgressEnd = Event.None;
	readonly onDidLoadedSource = Event.None;
	readonly onDidInvalidateMemory = Event.None;
	async loadedSources(): ReturnType<IDebugSession['loadedSources']> { throw new Error('Loaded-source IO is not configured in this fixture'); }
	async readMemory(..._args: Parameters<IDebugSession['readMemory']>): ReturnType<IDebugSession['readMemory']> { throw new Error('Memory IO is not configured in this fixture'); }
	async writeMemory(..._args: Parameters<IDebugSession['writeMemory']>): ReturnType<IDebugSession['writeMemory']> { throw new Error('Memory IO is not configured in this fixture'); }
	async exceptionInfo(): ReturnType<IDebugSession['exceptionInfo']> { throw new Error('Exception IO is not configured in this fixture'); }
	async cancelProgress(_progressId: string): Promise<void> { }

	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<void>());
	private selectedThread = 1;
	private readonly threadEmitter = this._register(new Emitter<number | undefined>());
	public readonly configuration: IDebugConfiguration;
	public readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, supportsSetVariable: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsDisassembleRequest: true, supportsSteppingGranularity: true, supportsCompletionsRequest: false, supportsCancelRequest: false, completionTriggerCharacters: [], exceptionBreakpointFilters: Object.freeze([{ filter: 'uncaught', label: 'Uncaught', default: true }, { filter: 'caught', label: 'Caught', default: false }]) });
	public state: DebugSessionState = 'stopped';
	public readonly operations: string[] = [];
	public readonly assignments: { reference: number; name: string; value: string; }[] = [];
	public watchValue = '42';
	public readonly reason = 'breakpoint';
	public readonly onDidChangeState = this.stateEmitter.event;
	public readonly onDidChangeReplElements = this.outputEmitter.event;
	public readonly onDidCustomEvent = Event.None;
	public readonly onDidChangeName = Event.None;
	public readonly onDidChangeThread = this.threadEmitter.event;
	readonly exceptionBreakpoints: readonly string[] = ['uncaught'];
	readonly onDidChangeExceptionBreakpoints = Event.None;
	public get name(): string { return this.configuration.name; }
	public setName(): void { throw new Error("Renaming is unsupported in this fixture"); }
	public async inspectStack(threadId?: number) {
		const threads = await this.threads();
		const selected = threads.find(thread => thread.id === threadId) ?? threads[0];
		return { threads, frames: selected ? await this.stackTrace(selected.id) : [], ...(selected ? { threadId: selected.id } : {}) };
	}
	public async inspectFrame(frameId: number) {
		return Promise.all((await this.scopes(frameId)).map(async scope => ({ scope, variables: scope.variablesReference > 0 ? await this.variables(scope.variablesReference) : [] })));
	}
	public async evaluateWatchExpressions(expressions: readonly string[], frameId?: number) {
		return Promise.all(expressions.map(async expression => { try { return { expression, result: await this.evaluate(expression, frameId, 'watch') }; } catch (error) { return { expression, error: error instanceof Error ? error.message : String(error) }; } }));
	}
	public getDebugProtocolBreakpoint(): undefined { return undefined; }
	public async customRequest(): Promise<never> { throw new Error("Custom requests are unsupported in this fixture"); }
	private consoleEntries: readonly DebugConsoleEntry[] = [];
	private consoleRevision = 0;
	get output(): string { return this.consoleEntries.map(entry => entry.output).join(''); }
	get consoleSessionId(): string { return this.id; }
	get replElementsRevision(): number { return this.consoleRevision; }
	get retainedConsoleSessionIds(): readonly string[] { return [this.id]; }
	readonly consoleCatalogRevision = 1;
	getReplElements() { return this.consoleEntries; }
	async clearRepl(): Promise<void> { this.consoleEntries = []; this.consoleRevision++; this.outputEmitter.fire(); }
	public emitOutput(value: string): void { this.emitConsoleEntry({ output: value }); }
	public emitConsoleEntry(entry: Partial<DebugConsoleEntry>): void {
		this.consoleEntries = [...this.consoleEntries, { id: ++this.consoleRevision, sessionId: this.id, kind: 'output', output: '', category: 'console', parentId: null, collapsed: false, variablesReference: null, source: null, line: null, column: null, data: null, ...entry }];
		this.outputEmitter.fire();
	}

	constructor(public readonly id: string, name: string, private readonly stackSource: IDebugSource) {
		super();
		this.configuration = configuration(name);
	}
	public get threadId(): number { return this.selectedThread; }
	public async continue(): Promise<void> { }
	public async pause(): Promise<void> { this.operations.push('pause'); }
	public async stepOver(granularity?: DebugSteppingGranularity): Promise<void> { this.operations.push(granularity ? `stepOver:${granularity}` : 'stepOver'); }
	public async stepInto(): Promise<void> { }
	public async stepOut(): Promise<void> { }
	public async restart(): Promise<void> { }
	public async threads(): Promise<readonly IDebugThread[]> { return Object.freeze([{ id: 1, name: 'main' }, { id: 2, name: 'worker' }]); }
	public selectThread(threadId: number): void { if (this.selectedThread !== threadId) { this.selectedThread = threadId; this.threadEmitter.fire(threadId); } }
	public async stackTrace(_threadId?: number): Promise<readonly IDebugStackFrame[]> { return Object.freeze([{ id: 10, name: 'main', source: this.stackSource, lineNumber: 1, columnNumber: 1 }]); }
	public async scopes(_frameId?: number): Promise<readonly IDebugScope[]> { return Object.freeze([{ name: 'Locals', variablesReference: 20, expensive: false }]); }
	public async variables(reference: number): Promise<readonly IDebugVariable[]> { return reference === 20 ? Object.freeze([{ name: 'parent', value: 'Object', variablesReference: 21 }]) : Object.freeze([{ name: 'child', value: 'value', variablesReference: 0 }]); }
	public async setVariable(reference: number, name: string, value: string): Promise<IDebugVariable> { this.assignments.push({ reference, name, value }); this.watchValue = value; return { name, value, type: 'string', variablesReference: 0 }; }
	public async completions() { return undefined; }

	public async evaluate(_expression: string, _frameId: number | undefined, _context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { if (_context === 'repl') this.emitOutput(`> ${_expression}\n${this.watchValue} : number\n`); return { result: this.watchValue, type: 'number', variablesReference: 0 }; }
	public async source(_source: IDebugSource): Promise<IDebugSourceContent> { return { content: 'const generated = true;', mimeType: 'text/typescript' }; }
	public readonly dataInfoRequests: unknown[] = [];
	public async dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse> {
		this.dataInfoRequests.push({ name, variablesReference, frameId });
		return { dataId: `variable:${variablesReference}:${name}`, description: name, canPersist: false, accessTypes: ['read', 'write', 'readWrite'] };
	}
	public async setExceptionBreakpoints(): Promise<void> { }
	public async disassemble(_reference: string, _offset: number, _instructionOffset: number, _instructionCount: number): Promise<readonly IDisassembledInstruction[]> { return []; }
	public async disconnect(): Promise<void> { }
}

function configuration(name: string): IDebugConfiguration { return { id: name, name, type: 'demo', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }; }

/** Workspace dependencies for the debug pane's production creation path. */
export class DebugViewTestServices extends Disposable {
	public readonly workspace: TestWorkspaceService;
	public readonly documents = new Map<string, string>();
	public readonly notifications = this._register(new NotificationService());
	public folderOpens = 0;
	public writes = 0;

	constructor(identifier: IAnyWorkspaceIdentifier = { id: 'workspace', uri: URI.file('/workspace') }) {
		super();
		this.workspace = this._register(new TestWorkspaceService(identifier));
	}

	/** Mounts the registered Debug constructor through the real Part title renderer. */
	public createContainer(services: InstantiationService, parent: HTMLElement): { part: PaneCompositePart; container: DebugViewPaneContainer; } {
		setIconResolver(parent.ownerDocument, icon => getIconDefinition(icon));
		if (!services.has(IContextKeyService)) services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		if (!services.has(IStorageService)) services.registerInstance(IStorageService, this._register(new BrowserStorageService({ ownerWindow: parent.ownerDocument.defaultView!, workspaceId: 'debug-view', flushInterval: 0, onError() { } })));
		if (!services.has(IThemeService)) services.registerInstance(IThemeService, this._register(new TestThemeService(lightColorTheme)));
		const descriptors = this._register(services.createInstance(ViewDescriptorService, { registry: ViewsRegistry }));
		services.registerInstance(IViewDescriptorService, descriptors);
		if (!services.has(IActivityService)) services.registerInstance(IActivityService, this._register(services.createInstance(ActivityService)));
		if (!services.has(IMenuService)) services.registerInstance(IMenuService, services.createInstance(MenuService));
		if (!services.has(INotificationService)) services.registerInstance(INotificationService, this.notifications);
		if (!services.has(IAccessibilityService)) services.registerInstance(IAccessibilityService, this._register(new AccessibilityService({ root: parent, configurationService: services.get(IConfigurationService), contextKeyService: services.get(IContextKeyService) })));
		const contextKeys = services.get(IContextKeyService);
		const part = this._register(services.createInstance(PaneCompositePart, parent, {
			id: 'sidebar', location: ViewContainerLocation.Sidebar, ariaLabel: 'Run and Debug', viewsAriaLabel: 'Views',
			viewDescriptorService: descriptors, contextKeyService: contextKeys,
			compositeBarContextMenuProvider: services.get(IContextMenuService),
			openComposite: async (id: string) => { part.showComposite(id); return part.getComposite(id)!; },
		}));
		const descriptor = descriptors.getViewContainers(ViewContainerLocation.Sidebar).find(candidate => candidate.id === WorkbenchViewContainerId.Debug)!;
		services.registerInstance(IViewsService, this._register(new ViewsService(descriptors, {
			onDidPaneCompositeOpen: Event.map(part.onDidCompositeOpen, event => ({ composite: part.getComposite(event.composite.getId())!, viewContainerLocation: ViewContainerLocation.Sidebar })),
			onDidPaneCompositeClose: Event.map(part.onDidCompositeClose, composite => ({ composite: part.getComposite(composite.getId())!, viewContainerLocation: ViewContainerLocation.Sidebar })),
			getActivePaneComposite: () => part.getComposite(part.activeCompositeId ?? ''), getLastActivePaneCompositeId: () => part.activeCompositeId,
			getPartId: () => 'sidebar', openPaneComposite: async (id, _location, focus) => { part.showComposite(id ?? container.id, focus); return part.getComposite(container.id); },
			hideActivePaneComposite: () => part.setVisible(false),
		}, contextKeys)));
		const container = services.createInstance(descriptor.ctorDescriptor!, part.domNode, {
			viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id), instantiationService: services,
			contextKeyService: contextKeys, localizationService: { whenReady: Promise.resolve(), translate: (bundle: string, key: string, fallback: string, parameters?: Readonly<Record<string, string | number>>) => localize({ bundle, key }, fallback, ...Object.values(parameters ?? {})) }, onDidFailCreateView: (error: unknown) => { throw error; },
		});
		if (!(container instanceof DebugViewPaneContainer)) throw new Error('Debug container registration uses the wrong owner');
		part.addComposite(container);

		part.showComposite(container.id);
		return { part, container, };
	}

	public register(services: ServiceCollection): ServiceCollection {
		if (!services.get(IAccessibleViewService)) services.set(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp() { }, dispose() { }, [Symbol.dispose]() { } });
		if (!services.get(IContextKeyService)) services.set(IContextKeyService, this._register(new ContextKeyService()));
		if (!services.get(INotificationService)) services.set(INotificationService, this.notifications);
		// This fixture also runs in a real browser; model resolution must not load jsdom or editor widgets.
		const configuration = this._register(new WorkbenchConfigurationService());
		const languages = this._register(new LanguageService());
		const models = this._register(new ModelService(configuration, { _serviceBrand: undefined, getEOL: () => '\n' }, languages));
		const identity = this._register(new TestUriIdentityServices());
		const fileModels = this._register(identity.createInstance(BrowserTextModelService, {
			onDidChange: Event.None,
			resolve: async () => { throw new Error('Filesystem acquisition is outside this Debug scenario'); },
			save: async () => { throw new Error('Filesystem acquisition is outside this Debug scenario'); },
		}, {}));
		services.set(IUriIdentityService, identity.get(IUriIdentityService));
		services.set(ILogService, new NullLoggerService());
		services.set(IModelService, models);
		services.set(ILanguageService, languages);
		const textModels = new TextModelResolverService(fileModels);
		services.set(ITextModelService, textModels);
		const debug = services.get(IDebugService);
		const editor = services.get(IEditorService) as IEditorService | undefined;
		if (debug instanceof MockDebugService && editor) {
			// The UI fixture supplies the service's navigation effect. Production
			// sequencing and cancellation are exercised by DebugService and Desktop tests.
			debug.onNavigationError = error => this.notifications.error(error instanceof Error ? error.message : String(error));
			debug.navigateFrame = async (frame, session, isCurrent, explicit, preserveFocus) => {
				if (!frame.source || !isCurrent() || !explicit && (frame.lineNumber <= 0 || frame.columnNumber <= 0 || editor.activeEditor?.editorId === DISASSEMBLY_VIEW_ID)) return;
				const resource = getUriFromSource(frame.source, frame.source.path, session.id, identity.get(IUriIdentityService), services.get(ILogService)! as ILogService);
				const selection = frame.lineNumber > 0 && frame.columnNumber > 0 ? Range.fromPositions(new Position(frame.lineNumber, frame.columnNumber)) : undefined;
				if (resource.scheme === 'debug') {
					using reference = await textModels.createModelReference(resource);
					if (isCurrent()) await editor.openEditor({ resource, label: frame.source.name, readOnly: true }, { selection, preserveFocus });
				} else await editor.openEditor({ resource, label: frame.source.name }, { selection, preserveFocus });
			};
			this._register(toDisposable(() => { debug.navigateFrame = undefined; debug.onNavigationError = () => { }; }));
		}
		const providerServices = this._register(new InstantiationService(services));
		if (!services.get(IConfigurationService)) services.set(IConfigurationService, configuration);
		services.set(IContextViewService, this._register(new BrowserContextViewService(document.body)));
		services.set(IActionWidgetService, this._register(providerServices.createInstance(ActionWidgetService)));
		services.set(ICommandService, this._register(new CommandService(providerServices)));
		this._register(providerServices.createInstance(DebugContentProvider));
		const stat = (resource: URI): IFileStat => ({ resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
		if (!services.get(IExtensionService)) services.set(IExtensionService, this._register(new TestExtensionService()));
		services.set(IWorkspaceContextService, this.workspace);
		services.set(IFileDialogService, { pickFolderAndOpen: async () => { this.folderOpens++; }, pickWorkspaceAndOpen: unexpected, pickFileToSave: unexpected, showOpenDialog: unexpected, showSaveDialog: unexpected, showSaveConfirm: unexpected });
		services.set(IFileService, this._register(createTestFileService({
			capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
			onDidChangeCapabilities: Event.None,
			watch: (): IDisposable => Disposable.None,

			onDidChangeFiles: Event.None,
			stat: async resource => {
				if (!this.documents.has(resource.toString())) throw new FileNotFoundError(resource);
				return stat(resource);
			},
			createDirectory: async resource => ({ ...stat(resource), kind: FileKind.Directory }), readFile: unexpected, readDirectory: unexpected,
			writeFile: async (resource, bytes, options) => {
				const key = resource.toString();
				if (this.documents.has(key) && !options.overwrite) { throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists); }
				if (!this.documents.has(key) && !options.create) { throw new FileNotFoundError(resource); }
				this.documents.set(key, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
				this.writes++;
				return { stat: { ...stat(resource), sizeBytes: bytes.byteLength }, revision: String(this.writes) };
			},
			createFile: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
		})));
		return services;
	}
}
