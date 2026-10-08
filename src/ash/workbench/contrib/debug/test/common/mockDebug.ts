import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createFileSystemProviderError, FileKind, FileNotFoundError, FileSystemProviderErrorCode, IFileService, type IFileStat, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService, type IAnyWorkspaceIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { IWorkspaceOpenService } from '../../../../services/workspaces/browser/workspaceOpenService.js';
import type { DebugBreakpoint, IBaseBreakpoint, IDataBreakpoint, IDataBreakpointInfoResponse, IDataBreakpointOptions, IFunctionBreakpoint, IFunctionBreakpointOptions, IInstructionBreakpoint, IInstructionBreakpointOptions, DebugEvaluateContext, DebugSessionState, DebugSteppingGranularity, IDebugBreakpoint, IDebugBreakpointUpdate, IDebugCompound, IDebugConfiguration, IDebugEvaluateResult, IDebugScope, IDebugService, IDebugSession, IDisassembledInstruction, IDebugSource, IDebugSourceContent, IDebugStackFrame, IDebugThread, IDebugVariable } from '../../../../services/debug/common/debugService.js';

export class MockDebugService extends Disposable implements IDebugService {
	private readonly configurationEmitter = this._register(new Emitter<readonly IDebugConfiguration[]>());
	private readonly breakpointEmitter = this._register(new Emitter<readonly DebugBreakpoint[]>());
	private readonly watchEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	private readonly frameEmitter = this._register(new Emitter<IDebugStackFrame | undefined>());
	public readonly onDidFocusStackFrame = this.frameEmitter.event;
	public focusedStackFrame: IDebugStackFrame | undefined;
	public focusStackFrame(frame: IDebugStackFrame | undefined): void { this.focusedStackFrame = frame; this.frameEmitter.fire(frame); }
	public configurations: readonly IDebugConfiguration[] = Object.freeze([configuration('One')]);
	public readonly operations: string[] = [];
	public readonly compounds: readonly IDebugCompound[] = Object.freeze([]);
	public breakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	public functionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	public dataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	public instructionBreakpoints: readonly IInstructionBreakpoint[] = Object.freeze([]);
	private nextBreakpointId = 0;
	public watchExpressions: readonly string[] = Object.freeze(['answer']);
	public exceptionBreakpoints: readonly string[] = Object.freeze(['uncaught']);
	public readonly sessions: readonly IDebugSession[];
	public session: IDebugSession | undefined;
	public readonly onDidChangeConfigurations = this.configurationEmitter.event;
	public readonly onDidChangeBreakpoints = this.breakpointEmitter.event;
	public readonly onDidChangeWatchExpressions = this.watchEmitter.event;
	public readonly onDidChangeExceptionBreakpoints = this.exceptionEmitter.event;
	public readonly onDidChangeSession = this.sessionEmitter.event;
	constructor(source: IDebugSource = { name: 'generated.ts', sourceReference: 33 }) {
		super();
		this.sessions = Object.freeze([this._register(new MockDebugSession('session-one', 'One', source)), this._register(new MockDebugSession('session-two', 'Two', source))]);
	}
	public async refresh(): Promise<readonly IDebugConfiguration[]> { this.configurationEmitter.fire(this.configurations); return this.configurations; }
	public async start(): Promise<IDebugSession> { this.operations.push('start'); return this.sessions[0]!; }
	public async startDebugging(): Promise<IDebugSession> { return this.sessions[0]!; }
	public async startCompound(): Promise<readonly IDebugSession[]> { return this.sessions; }
	public setActiveSession(session: IDebugSession): void { this.activate(session); }
	public async restart(session = this.session): Promise<IDebugSession> { return session!; }
	public async stop(): Promise<void> { this.operations.push('stop'); }
	public async stopAll(): Promise<void> { }
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
	public activate(session: IDebugSession | undefined): void { this.session = session; this.focusStackFrame(undefined); this.sessionEmitter.fire(session); }
}

export class MockDebugSession extends Disposable implements IDebugSession {
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	private selectedThread = 1;
	public readonly configuration: IDebugConfiguration;
	public readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, supportsSetVariable: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsDisassembleRequest: true, supportsSteppingGranularity: true, exceptionBreakpointFilters: Object.freeze([{ filter: 'uncaught', label: 'Uncaught', default: true }, { filter: 'caught', label: 'Caught', default: false }]) });
	public state: DebugSessionState = 'stopped';
	public readonly operations: string[] = [];
	public readonly assignments: { reference: number; name: string; value: string; }[] = [];
	public watchValue = '42';
	public readonly reason = 'breakpoint';
	public readonly onDidChangeState = this.stateEmitter.event;
	public readonly onDidOutput = this.outputEmitter.event;
	public readonly output = '';
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
	public selectThread(threadId: number): void { this.selectedThread = threadId; }
	public async stackTrace(): Promise<readonly IDebugStackFrame[]> { return Object.freeze([{ id: 10, name: 'main', source: this.stackSource, lineNumber: 1, columnNumber: 1 }]); }
	public async scopes(): Promise<readonly IDebugScope[]> { return Object.freeze([{ name: 'Locals', variablesReference: 20, expensive: false }]); }
	public async variables(reference: number): Promise<readonly IDebugVariable[]> { return reference === 20 ? Object.freeze([{ name: 'parent', value: 'Object', variablesReference: 21 }]) : Object.freeze([{ name: 'child', value: 'value', variablesReference: 0 }]); }
	public async setVariable(reference: number, name: string, value: string): Promise<IDebugVariable> { this.assignments.push({ reference, name, value }); this.watchValue = value; return { name, value, type: 'string', variablesReference: 0 }; }
	public async evaluate(_expression: string, _frameId: number | undefined, _context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { return { result: this.watchValue, type: 'number', variablesReference: 0 }; }
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
	public readonly workspace: WorkspaceContextService;
	public readonly documents = new Map<string, string>();
	public folderOpens = 0;
	public writes = 0;

	constructor(identifier: IAnyWorkspaceIdentifier = { id: 'workspace', uri: URI.file('/workspace') }) {
		super();
		this.workspace = this._register(new WorkspaceContextService(identifier));
	}

	public register(services: ServiceCollection): ServiceCollection {
		const stat = (resource: URI): IFileStat => ({ resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
		services.set(IWorkspaceContextService, this.workspace);
		services.set(IWorkspaceOpenService, { canOpenFolder: true, canOpenWorkspace: true, openFolder: async () => { this.folderOpens++; }, openWorkspace: unexpected, pickFolder: unexpected });
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
