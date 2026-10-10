import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { AbstractDisposable, Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionClientOperation, type ExtensionClientResult, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IDebugService, type DebugConfiguration, type IDebugSessionOptions, type IDebugSession, type IDebugBreakpoint, type IFunctionBreakpoint } from '../../services/debug/common/debugService.js';

/** Exposes the existing Workbench sessions to connection-owned extension callbacks. */
export class MainThreadDebugService extends Disposable {
	private readonly observers = this._register(new DisposableMap<string, DebugObserver>());
	private readonly sessionListeners = this._register(new DisposableMap<IDebugSession, DisposableStore>());
	private sequence = 0;
	private activeSessionId: string | undefined;
	private stackItemSignature: string | undefined;
	private breakpointSnapshots = new Map<string, JsonValue>();

	constructor(
		private readonly timeoutMillis: number,
		private readonly reportError: (error: unknown) => void,
		@IDebugService private readonly debug: IDebugService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
	) {
		super();
		this.activeSessionId = debug.session?.id;
		this.stackItemSignature = JSON.stringify(this.stackItemSnapshot());
		this.breakpointSnapshots = this.currentBreakpoints();
		this._register(debug.onDidChangeBreakpoints(() => {
			const current = this.currentBreakpoints();
			const added: JsonValue[] = [], changed: JsonValue[] = [], removed: JsonValue[] = [];
			for (const [id, point] of current) {
				const previous = this.breakpointSnapshots.get(id);
				if (previous === undefined) { added.push(point); }
				else if (JSON.stringify(previous) !== JSON.stringify(point)) { changed.push(point); }
			}
			for (const [id, point] of this.breakpointSnapshots) { if (!current.has(id)) { removed.push(point); } }
			this.breakpointSnapshots = current;
			if (added.length || changed.length || removed.length) { this.emit({ type: 'breakpoints', added, changed, removed }); }
		}));
		this._register(debug.onWillNewSession(session => this.observeSession(session)));
		this._register(debug.onDidNewSession(session => this.emit({ type: 'start', session: this.sessionSnapshot(session) })));
		this._register(debug.onDidEndSession(session => {
			this.emit({ type: 'end', session: this.sessionSnapshot(session) });
			this.sessionListeners.deleteAndDispose(session);
			this.emitStackItem();
		}));
		this._register(debug.onDidChangeSession(session => {
			this.emitStackItem();
			if (session?.id === this.activeSessionId) { return; }
			this.activeSessionId = session?.id;
			this.emit({ type: 'active', session: session ? this.sessionSnapshot(session) : null });
		}));
		this._register(debug.onDidFocusStackFrame(() => this.emitStackItem()));
		for (const session of debug.sessions) { this.observeSession(session); }
	}

	private observeSession(session: IDebugSession): void {
		if (this.sessionListeners.has(session)) { return; }
		const store = new DisposableStore();
		this.sessionListeners.set(session, store);
		store.add(session.onDidChangeName(() => this.emit({ type: 'name', session: this.sessionSnapshot(session) })));
		store.add(session.onDidChangeThread(() => this.emitStackItem()));
		store.add(session.onDidChangeState(() => this.emitStackItem()));
		store.add(session.onDidCustomEvent(event => this.emit({
			type: 'custom', session: this.sessionSnapshot(session), event: event.event,
			body: event.body === undefined ? null : normalizeExtensionHostPayload(event.body), hasBody: event.body !== undefined,
		})));
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const retained = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'debugEvents') { continue; }
				const identity = {
					extensionId: runtime.id, activationGeneration: runtime.activationGeneration,
					incarnation: runtime.incarnation, registrationId: registration.registrationId,
				};
				const key = JSON.stringify([identity.extensionId, identity.activationGeneration, identity.incarnation, identity.registrationId]);
				retained.add(key);
				if (this.observers.has(key)) { continue; }
				const observer = new DebugObserver(
					(event, signal) => this.api.invoke({
						...identity, operation: 'debugEvent', payload: event,
						deadlineUnixMillis: Date.now() + this.timeoutMillis,
					}, signal),
					error => { if (!this.isDisposed) { this.reportError(error); } },
				);
				this.observers.set(key, observer);
				observer.send({ type: 'snapshot', ...this.snapshot(), activeStackItem: this.stackItemSnapshot() });
			}
		}
		for (const key of this.observers.keys()) {
			if (!retained.has(key)) { this.observers.deleteAndDispose(key); }
		}
	}

	public clear(): void { this.observers.clearAndDisposeAll(); }

	private stackItemSnapshot(): JsonValue {
		const session = this.debug.session;
		if (!session || session.state !== 'stopped' || session.threadId === undefined) return null;
		const frame = this.debug.focusedStackFrame;
		// A stack reply retains the thread that requested it. Selection can change before its frame is focused.
		const frameId = frame && (frame.threadId === undefined || frame.threadId === session.threadId) ? frame.id : undefined;
		return {
			kind: frameId === undefined ? 'thread' : 'frame', session: this.sessionSnapshot(session), threadId: session.threadId,
			...(frameId === undefined ? {} : { frameId }),
		};
	}

	private emitStackItem(): void {
		const item = this.stackItemSnapshot();
		const signature = JSON.stringify(item);
		if (signature === this.stackItemSignature) return;
		this.stackItemSignature = signature;
		this.emit({ type: 'stackItem', item });
	}

	private emit(event: Readonly<Record<string, JsonValue>>): void {
		if (this.isDisposed) { return; }
		const value = normalizeExtensionHostPayload({ ...event, sequence: ++this.sequence });
		for (const [, observer] of this.observers) { observer.send(value); }
	}

	public async handle(
		operation: Extract<ExtensionClientOperation, { operation: 'listDebugSessions' | 'startDebugging' | 'stopDebugging' | 'debugCustomRequest' | 'addDebugBreakpoints' | 'removeDebugBreakpoints' | 'getDebugProtocolBreakpoint' | 'setDebugSessionName'; }>,
		signal: AbortSignal,
	): Promise<ExtensionClientResult> {
		this.assertNotDisposed();
		throwIfCancelled(signal);
		if (operation.operation === 'listDebugSessions') { return { result: 'debugSessions', ...this.snapshot() }; }
		if (operation.operation === 'setDebugSessionName') {
			const session = this.debug.getSession(operation.sessionId);
			if (!session) { throw new Error('Debug session has ended'); }
			session.setName(operation.name);
			return { result: 'done' };
		}
		if (operation.operation === 'addDebugBreakpoints') {
			if (operation.breakpoints.length > 10000) { throw new RangeError('Too many debug breakpoints'); }
			this.debug.addBreakpoints(operation.breakpoints.map(decodeBreakpoint));
			return { result: 'done' };
		}
		if (operation.operation === 'removeDebugBreakpoints') {
			if (operation.breakpointIds.length > 10000) { throw new RangeError('Too many debug breakpoints'); }
			this.debug.removeBreakpoints(operation.breakpointIds.map(id => breakpointText(id, 'id')));
			return { result: 'done' };
		}
		if (operation.operation === 'getDebugProtocolBreakpoint') {
			const session = this.debug.getSession(operation.sessionId);
			if (!session) { throw new Error('Debug session has ended'); }
			const value = session.getDebugProtocolBreakpoint(breakpointText(operation.breakpointId, 'id'));
			return { result: 'debugResponse', value: value === undefined ? null : normalizeExtensionHostPayload(value), hasBody: value !== undefined };
		}
		if (operation.operation === 'stopDebugging') {
			if (operation.sessionId === null) { await this.debug.stopAll(); }
			else {
				const session = this.debug.getSession(operation.sessionId);
				if (session) { await this.debug.stop(session); }
			}
			return { result: 'done' };
		}
		if (operation.operation === 'debugCustomRequest') {
			const session = this.debug.getSession(operation.sessionId);
			if (!session) { throw new Error('Debug session has ended'); }
			const value = await session.customRequest(operation.command, operation.hasArguments ? operation.arguments : undefined);
			throwIfCancelled(signal);
			return { result: 'debugResponse', value: value === undefined ? null : normalizeExtensionHostPayload(value), hasBody: value !== undefined };
		}
		const folder = operation.folder === null
			? undefined
			: this.workspace.getWorkspaceFolder(URI.parse(operation.folder)) ?? undefined;
		if (operation.folder !== null && !folder) { throw new Error('Debugging requires a current workspace folder'); }
		const parentSession = operation.options?.parentSessionId === undefined ? undefined : this.debug.getSession(operation.options.parentSessionId);
		if (operation.options?.parentSessionId !== undefined && !parentSession) throw new Error('The parent debug session has ended');
		const { parentSessionId, ...values } = operation.options ?? {};
		const options: IDebugSessionOptions = { ...values, ...(parentSession === undefined ? {} : { parentSession }) };
		let session: IDebugSession;
		try {
			if (typeof operation.configuration === 'string') {
				const configurations = await this.debug.refresh();
				throwIfCancelled(signal);
				const matches = configurations.filter(value => value.name === operation.configuration && (folder === undefined || value.dirId === folder.id));
				if (matches.length !== 1) { throw new Error('Debug configuration name must identify one configuration in the workspace folder'); }
				session = await this.debug.start(matches[0]!, options);
			} else {
				const value = operation.configuration as Readonly<Record<string, JsonValue>>;
				if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.type !== 'string' || !['launch', 'attach'].includes(String(value.request))) {
					throw new TypeError('Invalid extension debug configuration');
				}
				session = await this.debug.startDynamicDebugging(folder?.uri, value as DebugConfiguration, options);
			}
		} catch (error) {
			// Provider cancellation is a completed launch attempt; a retired invocation still rejects.
			throwIfCancelled(signal);
			this.assertNotDisposed();
			if (isCancellationError(error)) { return { result: 'debugStarted', started: false }; }
			throw error;
		}
		// A disconnected invocation must not leave an unclaimed late launch running.
		if (signal.aborted || this.isDisposed) {
			await this.debug.stop(session);
			throwIfCancelled(signal);
			this.assertNotDisposed();
		}
		return { result: 'debugStarted', started: true };
	}

	private sessionSnapshot(session: IDebugSession): JsonValue {
		const configuration = session.resolvedConfiguration ?? session.configuration;
		const folder = this.workspace.getWorkspace().folders.find(value => value.id === configuration.dirId);
		return normalizeExtensionHostPayload({
			id: session.id, type: configuration.type, name: session.name,
			...(session.parentSession ? { parentSessionId: session.parentSession.id } : {}),
			configuration: { ...configuration.arguments, name: configuration.name, type: configuration.type, request: configuration.request },
			workspaceFolder: folder ? { uri: folder.uri.toString(), name: folder.name, index: folder.index } : null,
		});
	}

	private currentBreakpoints(): Map<string, JsonValue> {
		return new Map([...this.debug.breakpoints, ...this.debug.functionBreakpoints].map(point => [point.id, breakpointSnapshot(point)]));
	}

	private snapshot(): { sequence: number; sessions: readonly JsonValue[]; activeSession: string | null; breakpoints: readonly JsonValue[]; } {
		return { sequence: this.sequence, sessions: this.debug.sessions.map(session => this.sessionSnapshot(session)), activeSession: this.debug.session?.id ?? null, breakpoints: [...this.currentBreakpoints().values()] };
	}
}

/** Slow extension callbacks have a bounded, incarnation-owned queue. */
class DebugObserver extends AbstractDisposable {
	private readonly controller = new AbortController();
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;

	constructor(
		private readonly invoke: (event: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
		private readonly reportError: (error: unknown) => void,
	) { super(); }

	public send(event: JsonValue): void {
		if (this.isDisposed) { return; }
		if (++this.pending > 64) {
			this.reportError(new Error('Extension debug event queue exceeded 64 pending events'));
			this.dispose();
			return;
		}
		this.queue = this.queue.then(async () => {
			throwIfCancelled(this.controller.signal);
			await this.invoke(event, this.controller.signal);
		}).catch(error => {
			if (!this.controller.signal.aborted) { this.reportError(error); }
		}).finally(() => { this.pending--; });
	}

	protected override disposeCore(): void {
		this.controller.abort();
	}
}

function breakpointSnapshot(point: IDebugBreakpoint | IFunctionBreakpoint): JsonValue {
	return normalizeExtensionHostPayload({
		id: point.id, enabled: point.enabled,
		...('kind' in point ? { kind: 'function', name: point.name } : { kind: 'source', uri: point.resource.toString(), line: point.lineNumber - 1, column: point.columnNumber === undefined ? null : point.columnNumber - 1 }),
		...(point.condition === undefined ? {} : { condition: point.condition }),
		...(point.hitCondition === undefined ? {} : { hitCondition: point.hitCondition }),
		...('logMessage' in point && point.logMessage !== undefined ? { logMessage: point.logMessage } : {}),
	});
}

function breakpointText(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0')) { throw new TypeError(`Invalid breakpoint ${field}`); }
	return value;
}

function decodeBreakpoint(input: JsonValue): IDebugBreakpoint | IFunctionBreakpoint {
	if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new TypeError('Invalid debug breakpoint'); }
	const value = input as Readonly<Record<string, JsonValue>>;
	const allowed = new Set(['kind', 'id', 'enabled', 'condition', 'hitCondition', 'logMessage', ...(value.kind === 'source' ? ['uri', 'line', 'column'] : ['name'])]);
	if (Object.keys(value).some(key => !allowed.has(key)) || typeof value.enabled !== 'boolean') { throw new TypeError('Invalid debug breakpoint fields'); }
	const expressions: { condition?: string; hitCondition?: string; logMessage?: string; } = {};
	for (const field of ['condition', 'hitCondition', 'logMessage'] as const) {
		if (value[field] !== undefined) {
			if (typeof value[field] !== 'string' || value[field].length > 32768 || value[field].includes('\0')) { throw new TypeError(`Invalid breakpoint ${field}`); }
			expressions[field] = value[field];
		}
	}
	const state = { id: breakpointText(value.id, 'id'), enabled: value.enabled, verified: false, ...expressions };
	if (value.kind === 'function') { return { ...state, kind: 'function', name: breakpointText(value.name, 'name') }; }
	if (value.kind !== 'source' || typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 0 || value.line >= Number.MAX_SAFE_INTEGER || value.column !== null && (typeof value.column !== 'number' || !Number.isSafeInteger(value.column) || value.column < 0 || value.column >= Number.MAX_SAFE_INTEGER)) {
		throw new TypeError('Invalid source breakpoint position');
	}
	return { ...state, resource: URI.parse(breakpointText(value.uri, 'URI')), lineNumber: value.line + 1, ...(value.column === null ? {} : { columnNumber: (value.column as number) + 1 }) };
}
