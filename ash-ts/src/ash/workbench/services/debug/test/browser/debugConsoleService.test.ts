import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { DebugEvaluateContext, DebugSessionState, IDebugConfiguration, IDebugEvaluateResult, IDebugService, IDebugSession } from "../../common/debugService.js";
import { DebugConsoleService } from "../../browser/debugConsoleService.js";

test("DebugConsoleService captures output while hidden, evaluates, and retains terminated sessions", async () => {
	using debug = new FakeDebugService();
	using consoleService = new DebugConsoleService(debug as unknown as IDebugService);
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

class FakeDebugService extends Disposable {
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	readonly onDidChangeSession = this.sessionEmitter.event;
	sessions: readonly IDebugSession[] = Object.freeze([]);
	session: IDebugSession | undefined;

	addSession(): FakeDebugSession {
		const session = this._register(new FakeDebugSession());
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
	readonly id = "debug-1";
	readonly configuration: IDebugConfiguration = Object.freeze({ id: "one", name: "One", type: "demo", request: "launch", adapter: Object.freeze({ program: "adapter", arguments: Object.freeze([]) }), arguments: Object.freeze({}) });
	readonly capabilities = Object.freeze({ supportsRestart: true, supportsTerminate: true, exceptionBreakpointFilters: Object.freeze([]) });
	state: DebugSessionState = "running";
	readonly onDidChangeState = this.stateEmitter.event;
	readonly onDidOutput = this.outputEmitter.event;
	private retainedOutput = "";
	get output(): string { return this.retainedOutput; }
	emitOutput(value: string): void { this.retainedOutput += value; this.outputEmitter.fire(value); }
	async evaluate(_expression: string, _frameId: number | undefined, _context: DebugEvaluateContext): Promise<IDebugEvaluateResult> { return { result: "42", type: "number", variablesReference: 0 }; }
	async continue() {}
	async pause() {}
	async stepOver() {}
	async stepInto() {}
	async stepOut() {}
	async restart() {}
	async threads() { return []; }
	selectThread() {}
	async stackTrace() { return []; }
	async scopes() { return []; }
	async variables() { return []; }
	async source() { return { content: "" }; }
	async setExceptionBreakpoints() {}
	async disconnect() {}
}
