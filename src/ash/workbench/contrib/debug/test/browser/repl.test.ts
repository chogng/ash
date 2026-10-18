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

	test('ReplModel cancels pending output notifications on clear and disposal', () => {
		using debug = new FakeDebugService();
		const consoleService = new ReplModel(debug as unknown as IDebugService);
		const session = debug.addSession();
		let notifications = 0;
		using listener = consoleService.onDidChange(() => notifications++);
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			session.emitOutput('before clear');
			consoleService.clear();
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

	consoleService.clear();
	assert.equal(consoleService.activeSession?.output, "");
});

test('ReplModel evaluates in the selected paused frame, including frame zero', async () => {
	using debug = new FakeDebugService();
	using repl = new ReplModel(debug as unknown as IDebugService);
	const session = debug.addSession();
	session.state = 'stopped';
	debug.focusedStackFrame = { id: 0, name: 'top', lineNumber: 1, columnNumber: 1 };
	await repl.evaluate('answer');
	debug.focusedStackFrame = { id: 7, name: 'caller', lineNumber: 2, columnNumber: 1 };
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
	debug.focusedStackFrame = { id: 7, name: 'old frame', lineNumber: 1, columnNumber: 1 };
	await repl.evaluate('running');
	const second = debug.addSession();
	second.state = 'stopped';
	debug.focusedStackFrame = { id: 9, name: 'other adapter', lineNumber: 1, columnNumber: 1 };
	// A retained console can still be rendered during a session-selection event.
	// The focused frame must never escape its actual DebugService session.
	debug.session = first;
	await repl.evaluate('different session');
	assert.deepEqual(first.evaluations, [{ expression: 'running', frameId: undefined, context: 'repl' }]);
	assert.deepEqual(second.evaluations, [{ expression: 'different session', frameId: undefined, context: 'repl' }]);
});

class FakeDebugService extends Disposable {
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	readonly onDidChangeSession = this.sessionEmitter.event;
	sessions: readonly IDebugSession[] = Object.freeze([]);
	session: IDebugSession | undefined;
	focusedStackFrame: IDebugStackFrame | undefined;

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
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	constructor(readonly id: string) { super(); }
	readonly evaluations: { expression: string; frameId: number | undefined; context: DebugEvaluateContext; }[] = [];
	readonly configuration: IDebugConfiguration = Object.freeze({ id: "one", name: "One", type: "demo", request: "launch", adapter: Object.freeze({ program: "adapter", arguments: Object.freeze([]) }), arguments: Object.freeze({}) });
	readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, supportsSetVariable: false, supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, exceptionBreakpointFilters: Object.freeze([]) });
	state: DebugSessionState = "running";
	readonly onDidChangeState = this.stateEmitter.event;
	readonly onDidOutput = this.outputEmitter.event;
	public readonly onDidCustomEvent = Event.None;
	public readonly onDidChangeName = Event.None;
	public readonly onDidChangeThread = Event.None;
	public readonly name = "One";
	public setName(): void { throw new Error("Renaming is unsupported in this fixture"); }
	public async inspectStack() { return { threads: [], frames: [] }; }
	public async inspectFrame() { return []; }
	public async evaluateWatchExpressions() { return []; }
	public getDebugProtocolBreakpoint(): undefined { return undefined; }
	public async customRequest(): Promise<never> { throw new Error("Custom requests are unsupported in this fixture"); }
	private retainedOutput = "";
	get output(): string { return this.retainedOutput; }
	emitOutput(value: string): void { this.retainedOutput += value; this.outputEmitter.fire(value); }
	async evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult> {
		this.evaluations.push({ expression, frameId, context });
		return { result: "42", type: "number", variablesReference: 0 };
	}
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
