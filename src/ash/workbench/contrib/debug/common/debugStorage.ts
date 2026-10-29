import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IDebugAdapterProcessService,
	type DebugWorkspaceState,
	type DebugWorkspaceSnapshot,
	type DebugWorkspaceEdit,
} from '../../../../platform/debug/common/debugAdapterProcessService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IBaseBreakpoint, IDebugBreakpoint, IFunctionBreakpoint, IDataBreakpoint } from './debug.js';

export interface PersistedDebugState {
	readonly version: 2;
	readonly breakpoints: readonly PersistedBreakpoint[];
	readonly functionBreakpoints: readonly IFunctionBreakpoint[];
	readonly dataBreakpoints: readonly IDataBreakpoint[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: Readonly<Record<string, readonly string[]>>;
}

interface PersistedBreakpoint {
	readonly id?: string;
	readonly columnNumber?: number;
	readonly resource: string;
	readonly lineNumber: number;
	readonly enabled: boolean;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}

const LEGACY_KEY = 'memento/debug.workspace';
const EMPTY_STATE: PersistedDebugState = Object.freeze({
	version: 2,
	breakpoints: [],
	functionBreakpoints: [],
	dataBreakpoints: [],
	watchExpressions: [],
	exceptionBreakpoints: {},
});
interface WorkspaceRead {
	readonly id: string;
	state: PersistedDebugState;
	snapshot: DebugWorkspaceSnapshot | undefined;
	queue: Promise<void>;
	edits: number;
	blocked: boolean;
	pending: number;
}

/** Workbench storage and one-way Memento migration. Rust owns the document,
 * revision and edit application; this object retains only the current facade
 * and unacknowledged UI edits. Every queued operation captures its workspace. */
export class DebugStorage extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<PersistedDebugState>());
	readonly onDidChangeState = this.changeEmitter.event;
	private current: WorkspaceRead;
	private readonly contexts = new Set<WorkspaceRead>();

	constructor(
		@IDebugAdapterProcessService private readonly backend: IDebugAdapterProcessService | undefined,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILogService private readonly log: ILogService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		try {
			this.current = this.openWorkspace();
		} catch (error) {
			this.dispose();
			throw error;
		}
		this._register(
			workspace.onDidChangeWorkspace(() => {
				if (this.current.id === workspace.getWorkspace().id) return;
				const previous = this.current;
				this.current = this.openWorkspace();
				if (previous.pending === 0) this.contexts.delete(previous);
				this.changeEmitter.fire(this.current.state);
			}),
		);
		this._register(
			backend?.onConnectionState(state => {
				if (state === 'ready') void this.reload().catch(error => this.report(error));
			}) ?? Disposable.None,
		);
		this._register(
			lifecycle.onWillShutdown(event => {
				if ([...this.contexts].some(context => context.pending > 0))
					event.join(
						() => this.flush(),
						localize('debug.workspaceSave', 'Save debug workspace definitions'),
						() => [...this.contexts].every(context => context.pending === 0),
					);
			}),
		);
		if (backend) {
			const poll = setInterval(() => {
				void this.reload().catch(error => this.report(error));
			}, 1000);
			this._register(toDisposable(() => clearInterval(poll)));
		}
	}

	get state(): PersistedDebugState {
		return this.current.state;
	}
	whenReady(): Promise<void> {
		return this.current.queue;
	}

	storeState(state: PersistedDebugState, commands: readonly DebugWorkspaceEdit[] = []): void {
		const current = this.current;
		const edits = [...changes(domainState(current.state), domainState(state)), ...commands];
		if (!edits.length) return;
		if (!this.backend)
			throw new Error(localize('debug.workspaceUnavailable', 'Debug workspace storage is unavailable.'));
		if (current.blocked)
			throw new Error(
				localize('debug.workspaceBlocked', 'Resolve the debug workspace storage conflict before editing.'),
			);
		current.state = state;
		const version = ++current.edits;
		current.pending++;
		current.queue = current.queue.then(async () => {
			if (current.blocked || !this.backend || !current.snapshot)
				throw new Error(localize('debug.workspaceUnavailable', 'Debug workspace storage is unavailable.'));
			const result = await this.backend.editWorkspaceState(current.id, current.snapshot.revision, edits);
			if (result.status === 'conflict') {
				current.blocked = true;
				throw new Error(
					localize(
						'debug.workspaceConflict',
						'Debug workspace definitions changed in another window. Local edits were retained; reopen the workspace to load the saved definitions.',
					),
				);
			}
			current.snapshot = result.snapshot;
			current.pending--;
			if (current.pending === 0 && this.current !== current) this.contexts.delete(current);
			if (version === current.edits) {
				const updated = fromDomain(result.snapshot.state);
				const changed = changes(domainState(current.state), domainState(updated)).length > 0;
				current.state = updated;
				if (changed && !this.isDisposed && this.current === current) this.changeEmitter.fire(current.state);
			}
		});
		void current.queue.catch(error => {
			current.blocked = true;
			this.report(error);
		});
	}

	/** Poll a complete revisioned snapshot only while no local work is pending.
	 * Reads never replay writes after a lost connection. */
	async reload(): Promise<void> {
		const current = this.current;
		if (!this.backend || current.blocked) return;
		const queue = current.queue;
		await queue;
		if (this.isDisposed || this.current !== current || queue !== current.queue) return;
		const result = await this.backend.readWorkspaceState(current.id);
		if (
			this.isDisposed ||
			this.current !== current ||
			queue !== current.queue ||
			(current.snapshot !== undefined && result.snapshot.revision <= current.snapshot.revision)
		)
			return;
		current.snapshot = result.snapshot;
		current.state = fromDomain(result.snapshot.state);
		this.changeEmitter.fire(current.state);
	}

	private async flush(): Promise<void> {
		// Include edits appended while an earlier write was awaiting its reply.
		while ([...this.contexts].some(context => context.pending > 0)) {
			await Promise.all([...this.contexts].filter(context => context.pending > 0).map(context => context.queue));
		}
	}

	private openWorkspace(): WorkspaceRead {
		const id = this.workspace.getWorkspace().id;
		const legacy = this.storage.get(LEGACY_KEY, StorageScope.WORKSPACE);
		const decoded: unknown = legacy === undefined ? undefined : JSON.parse(legacy);
		const state =
			decoded === undefined ||
			(decoded && typeof decoded === 'object' && !Array.isArray(decoded) && Object.keys(decoded).length === 0)
				? EMPTY_STATE
				: parsePersistedDebugState(decoded);
		const current: WorkspaceRead = {
			id,
			state,
			snapshot: undefined,
			queue: Promise.resolve(),
			edits: 0,
			blocked: false,
			pending: 0,
		};
		// An explicitly unavailable host may display legacy values, but cannot
		// migrate them or own pending writes to the backend document.
		if (!this.backend) return current;
		current.queue = Promise.resolve().then(async () => {
			const result = await this.backend!.readWorkspaceState(
				id,
				legacy === undefined ? undefined : domainState(state),
			);
			if (result.status === 'conflict') {
				current.blocked = true;
				throw new Error(
					localize(
						'debug.workspaceMigrationConflict',
						'Existing debug workspace definitions conflict with legacy data. Both copies were retained.',
					),
				);
			}
			current.snapshot = result.snapshot;
			// Cleanup belongs to the captured storage scope and exact source.
			// A later workspace or externally changed Memento must remain intact.
			if (
				!this.isDisposed &&
				this.current === current &&
				legacy !== undefined &&
				this.storage.get(LEGACY_KEY, StorageScope.WORKSPACE) === legacy
			) {
				this.storage.remove(LEGACY_KEY, StorageScope.WORKSPACE);
			}
			if (!current.edits) {
				current.state = fromDomain(result.snapshot.state);
				if (!this.isDisposed && this.current === current) this.changeEmitter.fire(current.state);
			}
		});
		void current.queue.catch(error => {
			current.blocked = true;
			this.report(error);
		});
		this.contexts.add(current);
		return current;
	}

	private report(error: unknown): void {
		this.log.error(
			'debug.storage',
			localize('debug.workspaceStorageFailed', 'Debug workspace storage failed.'),
			error,
		);
	}
}

function domainState(state: PersistedDebugState): DebugWorkspaceState {
	const base = (point: IBaseBreakpoint) => ({
		id: point.id,
		enabled: point.enabled,
		...breakpointExpressions(point),
	});
	return {
		breakpoints: state.breakpoints.map(point => ({
			id: point.id ?? `${point.resource}:${point.lineNumber}`,
			enabled: point.enabled,
			...breakpointExpressions(point),
			resource: point.resource,
			lineNumber: point.lineNumber,
			...(point.columnNumber === undefined ? {} : { columnNumber: point.columnNumber }),
		})),
		functionBreakpoints: state.functionBreakpoints.map(point => ({ ...base(point), name: point.name })),
		dataBreakpoints: state.dataBreakpoints
			.filter(point => point.canPersist)
			.map(point => ({
				...base(point),
				dataId: point.dataId,
				description: point.description,
				adapterType: point.adapterType,
				accessType: point.accessType,
				accessTypes: point.accessTypes,
			})),
		watchExpressions: state.watchExpressions,
		exceptionBreakpoints: state.exceptionBreakpoints,
	};
}

function fromDomain(state: DebugWorkspaceState): PersistedDebugState {
	return {
		version: 2,
		...state,
		functionBreakpoints: state.functionBreakpoints.map(point => ({ ...point, kind: 'function', verified: false })),
		dataBreakpoints: state.dataBreakpoints.map(point => ({
			...point,
			kind: 'data',
			canPersist: true,
			verified: false,
		})),
	};
}

function changes(before: DebugWorkspaceState, after: DebugWorkspaceState): DebugWorkspaceEdit[] {
	const edits: DebugWorkspaceEdit[] = [];
	const removed = [...before.breakpoints, ...before.functionBreakpoints, ...before.dataBreakpoints]
		.filter(
			point =>
				![...after.breakpoints, ...after.functionBreakpoints, ...after.dataBreakpoints].some(
					value => value.id === point.id,
				),
		)
		.map(point => point.id);
	if (removed.length) edits.push({ kind: 'remove', ids: removed });
	const different = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
	for (const point of after.breakpoints)
		if (
			different(
				before.breakpoints.find(value => value.id === point.id),
				point,
			)
		)
			edits.push({ kind: 'source', point });
	for (const point of after.functionBreakpoints)
		if (
			different(
				before.functionBreakpoints.find(value => value.id === point.id),
				point,
			)
		)
			edits.push({ kind: 'function', point });
	for (const point of after.dataBreakpoints)
		if (
			different(
				before.dataBreakpoints.find(value => value.id === point.id),
				point,
			)
		)
			edits.push({ kind: 'data', point });
	for (const expression of before.watchExpressions)
		if (!after.watchExpressions.includes(expression)) edits.push({ kind: 'removeWatch', expression });
	for (const expression of after.watchExpressions)
		if (!before.watchExpressions.includes(expression)) edits.push({ kind: 'addWatch', expression });
	for (const [adapterType, filters] of Object.entries(after.exceptionBreakpoints))
		if (different(before.exceptionBreakpoints[adapterType], filters))
			edits.push({ kind: 'exceptions', adapterType, filters });
	return edits;
}

function parsePersistedDebugState(value: unknown): PersistedDebugState {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Debug workspace state must be an object');
	const input = value as Record<string, unknown>;
	if (input.version !== 1 && input.version !== 2) throw new TypeError('Debug workspace state version is unsupported');
	if (
		!Array.isArray(input.breakpoints) ||
		!Array.isArray(input.watchExpressions) ||
		!input.exceptionBreakpoints ||
		typeof input.exceptionBreakpoints !== 'object' ||
		Array.isArray(input.exceptionBreakpoints)
	)
		throw new TypeError('Debug workspace state is malformed');
	const breakpoints = Object.freeze(
		input.breakpoints.map((candidate, index) => parsePersistedBreakpoint(candidate, index)),
	);
	const watchExpressions = Object.freeze(
		input.watchExpressions.map((candidate, index) =>
			normalizePersistedString(candidate, `watchExpressions[${index}]`, 32_768),
		),
	);
	const exceptionBreakpoints = Object.freeze(
		Object.fromEntries(
			Object.entries(input.exceptionBreakpoints as Record<string, unknown>).map(([type, filters]) => {
				if (!type || type.length > 128 || !Array.isArray(filters))
					throw new TypeError('Debug exception breakpoint state is malformed');
				return [
					type,
					Object.freeze(
						filters.map((filter, index) =>
							normalizePersistedString(filter, `exceptionBreakpoints.${type}[${index}]`, 256),
						),
					),
				];
			}),
		),
	);
	// Version 1 only stored source breakpoints. Normalize both legacy shapes
	// for one-way import; the current writer never emits a Memento.
	let functionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	let dataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	if (input.version === 2) {
		if (!Array.isArray(input.functionBreakpoints) || !Array.isArray(input.dataBreakpoints))
			throw new TypeError('Debug breakpoint state is malformed');
		functionBreakpoints = Object.freeze(input.functionBreakpoints.map(parsePersistedFunctionBreakpoint));
		dataBreakpoints = Object.freeze(input.dataBreakpoints.map(parsePersistedDataBreakpoint));
	}
	return Object.freeze({
		version: 2,
		breakpoints,
		functionBreakpoints,
		dataBreakpoints,
		watchExpressions,
		exceptionBreakpoints,
	});
}

function parsePersistedFunctionBreakpoint(value: unknown): IFunctionBreakpoint {
	const point = parsePersistedBreakpointState(value);
	if (point.input.logMessage !== undefined && typeof point.input.logMessage !== 'string') {
		throw new TypeError('logMessage must be a string');
	}
	return Object.freeze({
		...point.state,
		kind: 'function',
		name: normalizePersistedString(point.input.name, 'function breakpoint name', 32_768),
		...(point.input.logMessage === undefined
			? {}
			: { logMessage: normalizeBreakpointExpression(point.input.logMessage, 'logMessage') }),
	});
}

function parsePersistedDataBreakpoint(value: unknown): IDataBreakpoint {
	const point = parsePersistedBreakpointState(value);
	const input = point.input;
	if (typeof input.description !== 'string') throw new TypeError('Data breakpoint description must be a string');
	if (
		input.canPersist !== true ||
		!Array.isArray(input.accessTypes) ||
		!input.accessTypes.every(type => type === 'read' || type === 'write' || type === 'readWrite') ||
		!input.accessTypes.includes(input.accessType)
	)
		throw new TypeError('Persistent data breakpoint is malformed');
	return Object.freeze({
		...point.state,
		kind: 'data',
		dataId: normalizeBreakpointReference(input.dataId, 'dataId'),
		description: input.description,
		adapterType: normalizePersistedString(input.adapterType, 'adapterType', 256),
		canPersist: true,
		accessTypes: Object.freeze(input.accessTypes as IDataBreakpoint['accessTypes']),
		accessType: input.accessType as IDataBreakpoint['accessType'],
	});
}

function parsePersistedBreakpointState(value: unknown): { input: Record<string, unknown>; state: IBaseBreakpoint } {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Breakpoint state must be an object');
	const input = value as Record<string, unknown>;
	if (typeof input.enabled !== 'boolean') throw new TypeError('Breakpoint enabled state must be a boolean');
	const expressions: { condition?: string; hitCondition?: string } = {};
	for (const field of ['condition', 'hitCondition'] as const) {
		if (input[field] === undefined) continue;
		if (typeof input[field] !== 'string') throw new TypeError(`${field} must be a string`);
		expressions[field] = normalizeBreakpointExpression(input[field], field);
	}
	return {
		input,
		state: {
			id: normalizePersistedString(input.id, 'id', 32768),
			enabled: input.enabled,
			verified: false,
			...expressions,
		},
	};
}

function parsePersistedBreakpoint(value: unknown, index: number): PersistedBreakpoint {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError(`breakpoints[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const resource = URI.parse(
		normalizePersistedString(input.resource, `breakpoints[${index}].resource`, 16_384),
	).toString();
	if (
		!Number.isSafeInteger(input.lineNumber) ||
		(input.lineNumber as number) <= 0 ||
		typeof input.enabled !== 'boolean'
	)
		throw new TypeError(`breakpoints[${index}] is malformed`);
	const expressions: { condition?: string; hitCondition?: string; logMessage?: string } = {};
	for (const field of ['condition', 'hitCondition', 'logMessage'] as const) {
		if (input[field] === undefined) continue;
		if (typeof input[field] !== 'string') throw new TypeError(`breakpoints[${index}].${field} must be a string`);
		expressions[field] = normalizeBreakpointExpression(input[field], field);
	}
	if (
		input.columnNumber !== undefined &&
		(!Number.isSafeInteger(input.columnNumber) || (input.columnNumber as number) < 1)
	)
		throw new TypeError('Debug breakpoint column must be a positive integer');
	return Object.freeze({
		resource,
		lineNumber: input.lineNumber as number,
		enabled: input.enabled,
		...(input.id === undefined ? {} : { id: normalizePersistedString(input.id, 'breakpoint ID', 32768) }),
		...(input.columnNumber === undefined ? {} : { columnNumber: input.columnNumber as number }),
		...breakpointExpressions(expressions),
	});
}

function normalizePersistedString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0'))
		throw new TypeError(`${path} must contain 1 to ${maximum} characters`);
	return value.trim();
}

function normalizeBreakpointExpression(value: string, field: string): string | undefined {
	if (value.length > 32_768 || value.includes('\0'))
		throw new TypeError(`${field} must contain at most 32768 characters and no null characters`);
	return value.trim() ? value : undefined;
}
function breakpointExpressions(value: Pick<IDebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage'>) {
	return {
		...(value.condition === undefined ? {} : { condition: value.condition }),
		...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
		...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
	};
}

function normalizeBreakpointReference(value: unknown, field: string): string {
	// DAP references are opaque adapter identifiers; whitespace is part of their identity.
	if (typeof value !== 'string' || !value.trim() || value.length > 32_768 || value.includes('\0'))
		throw new TypeError(`${field} must contain 1 to 32768 characters`);
	return value;
}
