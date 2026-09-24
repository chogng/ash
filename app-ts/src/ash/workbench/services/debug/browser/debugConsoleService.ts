import { Emitter } from "../../../../base/common/event.js";
import { combinedDisposable, Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IDebugConsoleService, IDebugConsoleSession } from "../common/debugConsoleService.js";
import type { IDebugService, IDebugSession } from "../common/debugService.js";

interface DebugConsoleRecord {
	readonly id: string;
	readonly label: string;
	state: IDebugConsoleSession["state"];
	output: string;
	session: IDebugSession | undefined;
	listener: IDisposable | undefined;
}

const MAXIMUM_CONSOLE_SESSIONS = 20;
const MAXIMUM_CONSOLE_CHARACTERS = 128_000;

/** Captures DAP output independently of whether the Debug Console panel is visible. */
export class DebugConsoleService extends Disposable implements IDebugConsoleService {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly records = new Map<string, DebugConsoleRecord>();
	private activeSessionId: string | undefined;
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly debug: IDebugService) {
		super();
		this._register(debug.onDidChangeSession(() => this.synchronize()));
		this._register(toDisposable(() => {
			for (const record of this.records.values()) record.listener?.dispose();
			this.records.clear();
		}));
		this.synchronize();
	}

	get sessions(): readonly IDebugConsoleSession[] {
		return Object.freeze([...this.records.values()].map(record => snapshot(record)));
	}

	get activeSession(): IDebugConsoleSession | undefined {
		const record = this.activeSessionId ? this.records.get(this.activeSessionId) : undefined;
		return record ? snapshot(record) : undefined;
	}

	selectSession(id: string): void {
		const record = this.records.get(id);
		if (!record) throw new Error("Debug Console session is no longer available");
		if (this.activeSessionId === id) return;
		this.activeSessionId = id;
		if (record.session) this.debug.setActiveSession(record.session);
		this.changeEmitter.fire();
	}

	clear(sessionId: string | undefined = this.activeSessionId): void {
		const record = sessionId ? this.records.get(sessionId) : undefined;
		if (!record || !record.output) return;
		record.output = "";
		this.changeEmitter.fire();
	}

	async evaluate(expression: string): Promise<void> {
		const normalized = expression.trim();
		if (!normalized || normalized.length > 32_768 || normalized.includes("\0")) throw new TypeError("Debug Console expression must contain 1 to 32768 characters");
		const record = this.activeSessionId ? this.records.get(this.activeSessionId) : undefined;
		if (!record?.session) throw new Error("Debug Console requires an active session");
		this.append(record, `> ${normalized}\n`);
		try {
			const result = await record.session.evaluate(normalized, undefined, "repl");
			this.append(record, `${result.result}${result.type ? ` : ${result.type}` : ""}\n`);
		} catch (error) {
			this.append(record, `Error: ${message(error)}\n`);
		}
	}

	private synchronize(): void {
		const active = new Map(this.debug.sessions.map(session => [session.id, session]));
		for (const record of this.records.values()) {
			if (active.has(record.id) || !record.session) continue;
			record.listener?.dispose();
			record.listener = undefined;
			record.session = undefined;
			if (record.state !== "error") record.state = "terminated";
		}
		for (const session of active.values()) this.ensureRecord(session);
		if (this.debug.session) this.activeSessionId = this.debug.session.id;
		else if (!this.activeSessionId || !this.records.has(this.activeSessionId)) this.activeSessionId = [...this.records.keys()].at(-1);
		this.trimRecords();
		this.changeEmitter.fire();
	}

	private ensureRecord(session: IDebugSession): DebugConsoleRecord {
		const existing = this.records.get(session.id);
		if (existing) {
			existing.state = session.state;
			existing.session = session;
			return existing;
		}
		const record: DebugConsoleRecord = { id: session.id, label: session.configuration.name, state: session.state, output: session.output, session, listener: undefined };
		const output = session.onDidOutput(value => this.append(record, value));
		const state = session.onDidChangeState(value => { record.state = value; this.changeEmitter.fire(); });
		record.listener = this._register(combinedDisposable(output, state));
		this.records.set(session.id, record);
		return record;
	}

	private append(record: DebugConsoleRecord, value: string): void {
		if (!value) return;
		record.output = `${record.output}${value}`.slice(-MAXIMUM_CONSOLE_CHARACTERS);
		this.changeEmitter.fire();
	}

	private trimRecords(): void {
		while (this.records.size > MAXIMUM_CONSOLE_SESSIONS) {
			const candidate = [...this.records.values()].find(record => !record.session && record.id !== this.activeSessionId);
			if (!candidate) return;
			candidate.listener?.dispose();
			this.records.delete(candidate.id);
		}
	}
}

function snapshot(record: DebugConsoleRecord): IDebugConsoleSession {
	return Object.freeze({ id: record.id, label: record.label, state: record.state, output: record.output, canEvaluate: record.session !== undefined });
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
