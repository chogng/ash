import type { DebugConsoleEntry } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { combinedDisposable, Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type IReplModel, type IDebugConsoleSession, type IDebugService, type IDebugSession } from './debug.js';

interface DebugConsoleRecord {
	readonly id: string;
	label: string;
	state: IDebugConsoleSession['state'];
	elements: readonly DebugConsoleEntry[];
	revision: number;
	owner: IDebugSession;
	session: IDebugSession | undefined;
	readonly members: Map<string, { readonly session: IDebugSession; readonly listener: IDisposable }>;
}
/** Keeps read-only Rust console snapshots and selection independently of panel visibility. */
export class ReplModel extends Disposable implements IReplModel {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly outputNotification = this._register(new RunOnceScheduler(() => this.changeEmitter.fire(), 16));
	private readonly records = new Map<string, DebugConsoleRecord>();
	private activeSessionId: string | undefined;
	private consoleCatalog: { readonly revision: number; readonly ids: readonly string[] } | undefined;
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly debug: IDebugService) {
		super();
		this._register(debug.onDidChangeSession(() => this.synchronize()));
		this._register(
			toDisposable(() => {
				for (const record of this.records.values())
					for (const member of record.members.values()) member.listener.dispose();
				this.records.clear();
			}),
		);
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
		if (!record)
			throw new Error(localize('debug.repl.unavailable', 'Debug Console session is no longer available'));
		if (this.activeSessionId === id) return;
		this.activeSessionId = id;
		if (record.session) this.debug.setActiveSession(record.session);
		this.changeEmitter.fire();
	}

	async clear(sessionId: string | undefined = this.activeSessionId): Promise<void> {
		const record = sessionId ? this.records.get(sessionId) : undefined;
		if (!record) return;
		await record.owner.clearRepl();
		if (this.isDisposed) return;
		record.elements = record.owner.getReplElements();
		record.revision = record.owner.replElementsRevision;
		this.outputNotification.cancel();
		this.changeEmitter.fire();
	}

	async evaluate(expression: string): Promise<void> {
		const normalized = expression.trim();
		if (!normalized || normalized.length > 32_768 || normalized.includes('\0'))
			throw new TypeError(
				localize('debug.repl.invalidExpression', 'Debug Console expression must contain 1 to 32768 characters'),
			);
		const record = this.activeSessionId ? this.records.get(this.activeSessionId) : undefined;
		if (!record?.session)
			throw new Error(localize('debug.repl.activeRequired', 'Debug Console requires an active session'));
		const session = record.session;
		// Capture the selected frame at submission; frame IDs belong to one paused adapter session.
		const frame =
			this.debug.session === session && session.state === 'stopped'
				? this.debug.getViewModel().focusedStackFrame
				: undefined;
		await session.evaluate(normalized, frame?.id, 'repl');
		if (this.isDisposed) return;
		if (session.replElementsRevision >= record.revision) {
			record.elements = session.getReplElements();
			record.revision = session.replElementsRevision;
		}
		this.changeEmitter.fire();
	}

	private synchronize(): void {
		const active = new Map(this.debug.sessions.map(session => [session.id, session]));
		for (const record of this.records.values()) {
			for (const [id, member] of record.members) {
				if (active.get(id) === member.session) continue;
				member.listener.dispose();
				record.members.delete(id);
			}
		}
		for (const session of active.values()) this.ensureRecord(session);
		for (const record of this.records.values()) {
			const selected = this.debug.session;
			record.session =
				selected && record.members.has(selected.id)
					? selected
					: (record.members.get(record.id)?.session ?? [...record.members.values()].at(-1)?.session);
			if (record.session) record.state = record.session.state;
			else if (record.state !== 'error') record.state = 'terminated';
		}
		if (this.debug.session) this.activeSessionId = this.debug.session.consoleSessionId;
		else if (!this.activeSessionId || !this.records.has(this.activeSessionId))
			this.activeSessionId = [...this.records.keys()].at(-1);
		this.trimRecords();
		this.outputNotification.cancel();
		this.changeEmitter.fire();
	}

	private ensureRecord(session: IDebugSession): DebugConsoleRecord {
		const owner = this.debug.sessions.find(candidate => candidate.id === session.consoleSessionId) ?? session;
		let record = this.records.get(session.consoleSessionId);
		if (!record) {
			record = {
				id: session.consoleSessionId,
				label: owner.name,
				state: owner.state,
				elements: session.getReplElements(),
				revision: session.replElementsRevision,
				owner: session,
				session,
				members: new Map(),
			};
			this.records.set(record.id, record);
		}
		if (session.id === record.id) {
			record.owner = session;
			record.label = session.name;
		}
		if (record.members.has(session.id)) return record;
		// A later-published parent may carry an older snapshot than its child.
		// Fresh connection scopes use new session IDs even if their clock restarts.
		if (
			!this.consoleCatalog ||
			session.consoleCatalogRevision >= this.consoleCatalog.revision ||
			!this.consoleCatalog.ids.includes(session.consoleSessionId)
		) {
			this.consoleCatalog = { revision: session.consoleCatalogRevision, ids: session.retainedConsoleSessionIds };
		}
		// Shared-console snapshots replace the cache only in backend revision order.
		// Listener ownership follows the emitting session even for a shared console.
		const target = record;
		if (session.replElementsRevision >= target.revision) {
			target.revision = session.replElementsRevision;
			target.elements = session.getReplElements();
		}
		const output = session.onDidChangeReplElements(() => {
			if (session.replElementsRevision >= target.revision) {
				target.revision = session.replElementsRevision;
				target.elements = session.getReplElements();
			}
			if (!this.outputNotification.isScheduled()) this.outputNotification.schedule();
		});
		const state = session.onDidChangeState(() => this.synchronize());
		const name = session.onDidChangeName(value => {
			if (session.id === target.id) target.label = value;
			this.changeEmitter.fire();
		});
		record.members.set(session.id, { session, listener: combinedDisposable(output, state, name) });
		return record;
	}

	private trimRecords(): void {
		const ids = this.consoleCatalog?.ids;
		if (!ids) return;
		const retained = new Set(ids);
		for (const [id, record] of this.records) {
			if (record.session || retained.has(id)) continue;
			for (const member of record.members.values()) member.listener.dispose();
			this.records.delete(id);
		}
	}
}

function snapshot(record: DebugConsoleRecord): IDebugConsoleSession {
	return Object.freeze({
		id: record.id,
		label: record.label,
		state: record.state,
		elements: record.elements,
		output: record.elements.map(entry => entry.output).join(''),
		canEvaluate: record.session !== undefined,
	});
}
