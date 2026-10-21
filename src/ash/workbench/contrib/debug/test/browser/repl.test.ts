import { ViewModel } from '../../common/debugViewModel.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { DebugEvaluateContext, DebugSessionState, IDebugConfiguration, IDebugEvaluateResult, IDebugService, IDebugSession, IDebugStackFrame } from "../../common/debug.js";
import { ReplModel } from "../../common/replModel.js";
import { mock } from 'node:test';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Debug Console output batching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ReplModel batches a burst without delaying retained output or session changes', () => {
		using debug = new FakeDebugService();
		using consoleService = new ReplModel(debug as unknown as IDebugService);
		const session = debug.addSession();
		let notifications = 0;
		using listener = consoleService.onDidChange(() => notifications++);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			for (let index = 0; index < 200; index++) session.emitOutput(`line-${index}\n`);
			assert.equal(consoleService.activeSession?.output, Array.from({ length: 200 }, (_, index) => `line-${index}\n`).join(''));
			assert.equal(notifications, 0, 'A DAP batch must not trigger a render per message');
			mock.timers.tick(16);
			assert.equal(notifications, 1);
			session.emitOutput('tail\n');
			debug.finishSession();
			assert.equal(consoleService.activeSession?.state, 'terminated');
			assert.ok(consoleService.activeSession?.output.endsWith('tail\n'));
			assert.equal(notifications, 2);
			mock.timers.tick(16);
			assert.equal(notifications, 2, 'Publishing the state already includes the pending output');
		} finally { mock.timers.reset(); }
	});

	test('ReplModel cancels pending output notifications on clear and disposal', async () => {
		using debug = new FakeDebugService();
		const consoleService = new ReplModel(debug as unknown as IDebugService);
		const session = debug.addSession();
		let notifications = 0;
		using listener = consoleService.onDidChange(() => notifications++);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			session.emitOutput('before clear');
			await consoleService.clear();
			assert.equal(consoleService.activeSession?.output, '');
			assert.equal(notifications, 1);
			session.emitOutput('before disposal');
			consoleService.dispose();
			mock.timers.tick(16);
			assert.equal(notifications, 1);
		} finally { consoleService.dispose(); mock.timers.reset(); }
	});

});

test("ReplModel captures output while hidden, evaluates, and retains terminated sessions", async () => {
	using debug = new FakeDebugService();
	using consoleService = new ReplModel(debug as unknown as IDebugService);
	const session = debug.addSession();

	session.emitOutput("adapter ready\n");
	assert.equal(consoleService.activeSession?.output, "adapter ready\n");

	await consoleService.evaluate("answer");
	assert.equal(consoleService.activeSession?.output, "adapter ready\n> answer\n42 : number\n");

	debug.finishSession();
	assert.equal(consoleService.activeSession?.state, "terminated");
	assert.equal(consoleService.activeSession?.canEvaluate, false);
	assert.match(consoleService.activeSession?.output ?? "", /adapter ready/);

	await consoleService.clear();
	assert.equal(consoleService.activeSession?.output, "");
});

test('ReplModel evaluates in the selected paused frame, including frame zero', async () => {
	using debug = new FakeDebugService();
	using repl = new ReplModel(debug as unknown as IDebugService);
	const session = debug.addSession();
	session.state = 'stopped';
	debug.getViewModel().setFocus({ id: 0, name: 'top', lineNumber: 1, columnNumber: 1 }, undefined, session, true);
	await repl.evaluate('answer');
	debug.getViewModel().setFocus({ id: 7, name: 'caller', lineNumber: 2, columnNumber: 1 }, undefined, session, true);
	await repl.evaluate('answer + 1');
	assert.deepEqual(session.evaluations, [
		{ expression: 'answer', frameId: 0, context: 'repl' },
		{ expression: 'answer + 1', frameId: 7, context: 'repl' },
	]);
});

test('ReplModel never sends a frame belonging to a running or different session', async () => {
	using debug = new FakeDebugService();
	using repl = new ReplModel(debug as unknown as IDebugService);
	const first = debug.addSession();
	debug.getViewModel().setFocus({ id: 7, name: 'old frame', lineNumber: 1, columnNumber: 1 }, undefined, first, true);
	await repl.evaluate('running');
	const second = debug.addSession();
	second.state = 'stopped';
	debug.getViewModel().setFocus({ id: 9, name: 'other adapter', lineNumber: 1, columnNumber: 1 }, undefined, second, true);
	// A retained console can still be rendered during a session-selection event.
	// The focused frame must never escape its actual DebugService session.
	debug.session = first;
	await repl.evaluate('different session');
	assert.deepEqual(first.evaluations, [{ expression: 'running', frameId: undefined, context: 'repl' }]);
	assert.deepEqual(second.evaluations, [{ expression: 'different session', frameId: undefined, context: 'repl' }]);
});

class FakeDebugService extends Disposable {
	private readonly viewModel = this._register(new ViewModel());
	getViewModel(): ViewModel { return this.viewModel; }
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	readonly onDidChangeSession = this.sessionEmitter.event;
	sessions: readonly IDebugSession[] = Object.freeze([]);
	session: IDebugSession | undefined;

	addSession(): FakeDebugSession {
		const session = this._register(new FakeDebugSession(`debug-${this.sessions.length + 1}`));
		this.sessions = Object.freeze([session]);
		this.session = session;
		this.sessionEmitter.fire(session);
		return session;
	}

	setActiveSession(session: IDebugSession): void {
		this.session = session;
		this.sessionEmitter.fire(session);
	}

	finishSession(): void {
		this.sessions = Object.freeze([]);
		this.session = undefined;
		this.sessionEmitter.fire(undefined);
	}
}

class FakeDebugSession extends Disposable implements IDebugSession {
	inspectionRevision = 0;
	readonly onDidProgressStart = Event.None;
	readonly onDidProgressUpdate = Event.None;
	readonly onDidProgressEnd = Event.None;
	readonly onDidLoadedSource = Event.None;
	readonly onDidInvalidateMemory = Event.None;
	async loadedSources(): Promise<never> { throw new Error('Loaded-source IO is not configured in this fixture'); }
	async readMemory(): Promise<never> { throw new Error('Memory IO is not configured in this fixture'); }
	async writeMemory(): Promise<never> { throw new Error('Memory IO is not configured in this fixture'); }
	async exceptionInfo(): Promise<never> { throw new Error('Exception IO is not configured in this fixture'); }
	async cancelProgress(): Promise<void> { }

	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<void>());
	constructor(readonly id = "debug-1") { super(); }
	consoleCatalogRevision = 1;
	retainedIds: readonly string[] | undefined;
	readonly configuration: IDebugConfiguration = Object.freeze({ id: "one", name: "One", type: "demo", request: "launch", adapter: Object.freeze({ program: "adapter", arguments: Object.freeze([]) }), arguments: Object.freeze({}) });
	readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, supportsSetVariable: false, supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, supportsCompletionsRequest: false, supportsCancelRequest: false, completionTriggerCharacters: [], exceptionBreakpointFilters: Object.freeze([]) });
	state: DebugSessionState = "running";
	readonly onDidChangeState = this.stateEmitter.event;
	readonly onDidChangeReplElements = this.outputEmitter.event;
	public readonly onDidCustomEvent = Event.None;
	public readonly onDidChangeName = Event.None;
	public readonly onDidChangeThread = Event.None;
	readonly exceptionBreakpoints: readonly string[] = ['uncaught'];
	readonly onDidChangeExceptionBreakpoints = Event.None;
	public readonly name = "One";
	public setName(): void { throw new Error("Renaming is unsupported in this fixture"); }
	public async inspectStack() { return { threads: [], frames: [] }; }
	public async inspectFrame() { return []; }
	public async evaluateWatchExpressions() { return []; }
	public getDebugProtocolBreakpoint(): undefined { return undefined; }
	public async customRequest(): Promise<never> { throw new Error("Custom requests are unsupported in this fixture"); }
	readonly evaluations: Array<{ expression: string; frameId: number | undefined; context: DebugEvaluateContext; }> = [];
	private retainedOutput = "";
	get output(): string { return this.retainedOutput; }
	get consoleSessionId(): string { return this.id; }
	get replElementsRevision(): number { return this.output.length; }
	get retainedConsoleSessionIds(): readonly string[] { return this.retainedIds ?? [this.id]; }
	getReplElements() { return this.output ? [{ id: 1, sessionId: this.id, kind: 'output' as const, output: this.output, category: 'console', parentId: null, collapsed: false, variablesReference: null, source: null, line: null, column: null, data: null }] : []; }
	async clearRepl(): Promise<void> { this.retainedOutput = ''; this.outputEmitter.fire(); }

	emitOutput(value: string): void { this.retainedOutput += value; this.outputEmitter.fire(); }
	async completions() { return undefined; }
	async evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { this.evaluations.push({ expression, frameId, context }); this.emitOutput(`> ${expression}\n42 : number\n`); return { result: "42", type: "number", variablesReference: 0 }; }
	async continue() { }
	async pause() { }
	async stepOver() { }
	async stepInto() { }
	async stepOut() { }
	async restart() { }
	async threads() { return []; }
	selectThread() { }
	async stackTrace() { return []; }
	async scopes() { return []; }
	async variables() { return []; }
	async setVariable(): Promise<never> { throw new Error("Variables are read-only in this fixture"); }
	async source() { return { content: "" }; }
	async dataBreakpointInfo(): Promise<never> { throw new Error("No data breakpoints in the console fixture"); }
	async disassemble(): Promise<never> { throw new Error("No disassembly in the console fixture"); }
	async setExceptionBreakpoints() { }
	async disconnect() { }
}


test('ReplModel evaluates in the selected stack frame including frame zero', async () => {
	using debug = new FakeDebugService();
	using model = new ReplModel(debug as unknown as IDebugService);
	const session = debug.addSession();
	session.state = 'stopped';
	debug.getViewModel().setFocus({ id: 0, name: 'selected', lineNumber: 1, columnNumber: 1 }, undefined, session, true);
	await model.evaluate(' answer ');
	assert.deepEqual(session.evaluations, [{ expression: 'answer', frameId: 0, context: 'repl' }]);
	assert.match(model.activeSession!.output, /> answer\n42 : number/);
});

test('ReplModel retains ended consoles when an earlier admission publishes after a newer one', () => {
	using debug = new FakeDebugService();
	using model = new ReplModel(debug as unknown as IDebugService);
	using first = new FakeDebugSession('first');
	using later = new FakeDebugSession('later');
	using last = new FakeDebugSession('last');
	using next = new FakeDebugSession('next');
	first.consoleCatalogRevision = 1;
	first.retainedIds = ['first'];
	last.consoleCatalogRevision = 3;
	last.retainedIds = ['first', 'later', 'last'];
	later.consoleCatalogRevision = 2;
	later.retainedIds = ['first', 'later'];
	debug.sessions = [first]; debug.setActiveSession(first);
	debug.sessions = [first, last]; debug.setActiveSession(last);
	last.emitOutput('retained\n');
	debug.sessions = [first]; debug.setActiveSession(first);
	debug.sessions = [first, later]; debug.setActiveSession(later);
	assert.deepEqual(model.sessions.map(session => session.id), ['first', 'last', 'later']);
	assert.equal(model.sessions.find(session => session.id === 'last')!.output, 'retained\n');
	next.consoleCatalogRevision = 4;
	next.retainedIds = ['first', 'later', 'next'];
	debug.sessions = [first, later, next]; debug.setActiveSession(next);
	assert.deepEqual(model.sessions.map(session => session.id), ['first', 'later', 'next']);
});
