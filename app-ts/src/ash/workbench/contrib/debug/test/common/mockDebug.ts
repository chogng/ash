import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { DebugEvaluateContext, DebugSessionState, IDebugBreakpoint, IDebugCompound, IDebugConfiguration, IDebugEvaluateResult, IDebugScope, IDebugService, IDebugSession, IDebugSource, IDebugSourceContent, IDebugStackFrame, IDebugThread, IDebugVariable } from '../../../../services/debug/common/debugService.js';

export class MockDebugService extends Disposable implements IDebugService {
	private readonly configurationEmitter = this._register(new Emitter<readonly IDebugConfiguration[]>());
	private readonly breakpointEmitter = this._register(new Emitter<readonly IDebugBreakpoint[]>());
	private readonly watchEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	public configurations: readonly IDebugConfiguration[] = Object.freeze([configuration('One')]);
	public readonly operations: string[] = [];
	public readonly compounds: readonly IDebugCompound[] = Object.freeze([]);
	public readonly breakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	public readonly watchExpressions = Object.freeze(['answer']);
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
	public async stopAll(): Promise<void> {}
	public toggleBreakpoint(): void {}
	public removeBreakpoint(): void {}
	public addWatchExpression(): void {}
	public removeWatchExpression(): void {}
	public async setExceptionBreakpoints(filters: readonly string[]): Promise<void> { this.exceptionBreakpoints = Object.freeze([...filters]); this.exceptionEmitter.fire(this.exceptionBreakpoints); }
	public activate(session: IDebugSession | undefined): void { this.session = session; this.sessionEmitter.fire(session); }
}

export class MockDebugSession extends Disposable implements IDebugSession {
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	private selectedThread = 1;
	public readonly configuration: IDebugConfiguration;
	public readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, supportsSetVariable: true, exceptionBreakpointFilters: Object.freeze([{ filter: 'uncaught', label: 'Uncaught', default: true }, { filter: 'caught', label: 'Caught', default: false }]) });
	public state: DebugSessionState = 'stopped';
	public readonly operations: string[] = [];
	public readonly assignments: { reference: number; name: string; value: string }[] = [];
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
	public async continue(): Promise<void> {}
	public async pause(): Promise<void> { this.operations.push('pause'); }
	public async stepOver(): Promise<void> { this.operations.push('stepOver'); }
	public async stepInto(): Promise<void> {}
	public async stepOut(): Promise<void> {}
	public async restart(): Promise<void> {}
	public async threads(): Promise<readonly IDebugThread[]> { return Object.freeze([{ id: 1, name: 'main' }, { id: 2, name: 'worker' }]); }
	public selectThread(threadId: number): void { this.selectedThread = threadId; }
	public async stackTrace(): Promise<readonly IDebugStackFrame[]> { return Object.freeze([{ id: 10, name: 'main', source: this.stackSource, lineNumber: 1, columnNumber: 1 }]); }
	public async scopes(): Promise<readonly IDebugScope[]> { return Object.freeze([{ name: 'Locals', variablesReference: 20, expensive: false }]); }
	public async variables(reference: number): Promise<readonly IDebugVariable[]> { return reference === 20 ? Object.freeze([{ name: 'parent', value: 'Object', variablesReference: 21 }]) : Object.freeze([{ name: 'child', value: 'value', variablesReference: 0 }]); }
	public async setVariable(reference: number, name: string, value: string): Promise<IDebugVariable> { this.assignments.push({ reference, name, value }); this.watchValue = value; return { name, value, type: 'string', variablesReference: 0 }; }
	public async evaluate(_expression: string, _frameId: number | undefined, _context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { return { result: this.watchValue, type: 'number', variablesReference: 0 }; }
	public async source(_source: IDebugSource): Promise<IDebugSourceContent> { return { content: 'const generated = true;', mimeType: 'text/typescript' }; }
	public async setExceptionBreakpoints(): Promise<void> {}
	public async disconnect(): Promise<void> {}
}

function configuration(name: string): IDebugConfiguration { return { id: name, name, type: 'demo', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }; }
