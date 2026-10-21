import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import type { IDebugMemoryRead, IDebugExceptionInfo, IDebugExceptionDetails, IDebugProgressStart, IDebugProgressUpdate } from '../common/debug.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Position } from '../../../../editor/common/core/position.js';
import { RawDebugSession } from './rawDebugSession.js';
import type { IDebugCompletionItem, IDebugCompletionsResponse, IDebugScopeInspection, IDebugStackInspection, IDebugWatchResult, DebugBreakpoint, DebugEvaluateContext, DebugSessionState, DebugSteppingGranularity, IDisassembledInstruction, IBaseBreakpoint, IDataBreakpointInfoResponse, DataBreakpointAccessType, IDebugBreakpoint, IDebugConfiguration, IDebugEvaluateResult, IDebugScope, IDebugSession, IDebugSessionOptions, IDebugSessionCapabilities, IDebugSource, IDebugSourceContent, IDebugStackFrame, IDebugThread, IDebugVariable, IDebugAdapterTracker } from '../common/debug.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TaskQueue, timeout, raceCancellation } from "../../../../base/common/async.js";
import { CancellationError, getErrorMessage } from "../../../../base/common/errors.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { Schemas } from '../../../../base/common/network.js';
import { localize } from "../../../../nls.js";
import { type DebugExceptionsSnapshot, type DebugBreakpointIntent, type DebugBreakpointsSnapshot, type DebugBreakpointUnsupported, type DebugConsoleSnapshot, type DebugSessionSnapshot, type IDebugAdapterProcessService } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { getRemoteWorkspacePath, isRemoteResource, withRemoteWorkspacePath } from "../../../../platform/remote/common/remote.js";

interface DapResponse { readonly seq: number; readonly type: "response"; readonly request_seq: number; readonly success: boolean; readonly command: string; readonly message?: string; readonly body?: unknown; }
interface DapEvent { readonly seq: number; readonly type: "event"; readonly event: string; readonly body?: unknown; }

const POLL_DELAY_MS = 40;
const TRACKER_CALLBACK_TIMEOUT_MS = 1_000;

export interface DebugSessionStartOptions {
	readonly admitted?: boolean;
	readonly id?: string;
	readonly createDebugAdapterTrackers?: (session: IDebugSession) => PromiseLike<readonly IDebugAdapterTracker[]>;
	readonly createDebugAdapterDescriptor?: (session: IDebugSession) => PromiseLike<IDebugConfiguration['adapter'] | null>;
	readonly configuration: IDebugConfiguration;
	readonly sessionOptions?: IDebugSessionOptions;
	readonly onWillStart?: (session: IDebugSession) => void;
	/** Execution data is resolved by DebugService; the source configuration remains available for restart. */
	readonly resolvedConfiguration: Pick<IDebugConfiguration, 'adapter' | 'arguments'>;
	readonly processService: IDebugAdapterProcessService;
	readonly breakpoints: () => readonly IDebugBreakpoint[];
	readonly additionalBreakpoints?: () => readonly Exclude<DebugBreakpoint, IDebugBreakpoint>[];
	readonly workspace?: URI;
	readonly runInTerminal?: (argumentsValue: unknown) => Promise<Readonly<Record<string, unknown>>>;
	readonly startDebugging?: (argumentsValue: unknown) => Promise<void>;
	readonly updateBreakpoints?: (updates: readonly { readonly id: string; readonly verified: boolean; readonly message?: string; }[]) => void;
	/** The catalog owner inserts without notifying; verification publishes after the protocol binding exists. */
	readonly addBreakpoint?: (source: IDebugSource, line: number, column?: number, id?: string) => IDebugBreakpoint | undefined;
	readonly removeBreakpoint?: (id: string) => void;
	readonly exceptionBreakpoints?: () => readonly string[] | undefined;
}

/** Workbench debug session backed by a Rust-owned DAP request client. */
export class DebugSession extends Disposable implements IDebugSession {
	private readonly progressStarts = this._register(new Emitter<IDebugProgressStart>());
	private readonly progressUpdates = this._register(new Emitter<IDebugProgressUpdate>());
	private readonly progressEnds = this._register(new Emitter<{ progressId: string; }>());
	private readonly memoryChanges = this._register(new Emitter<{ memoryReference: string; offset: number; count: number; }>());
	readonly onDidInvalidateMemory = this.memoryChanges.event;
	private readonly loadedSourceChanges = this._register(new Emitter<{ reason: 'new' | 'changed' | 'removed'; source: IDebugSource; }>());
	readonly onDidProgressStart = this.progressStarts.event;
	readonly onDidProgressUpdate = this.progressUpdates.event;
	readonly onDidProgressEnd = this.progressEnds.event;
	readonly onDidLoadedSource = this.loadedSourceChanges.event;

	async loadedSources(): Promise<readonly IDebugSource[]> {
		if (!this.capabilities.supportsLoadedSourcesRequest) throw new Error(localize('debug.loadedSourcesUnsupported', 'The debug adapter does not support loaded sources.'));
		const body = record((await this.request('loadedSources')).body, 'loadedSources body');
		const entries = array(body.sources, 'loaded sources');
		if (entries.length > 4096) throw new RangeError(localize('debug.loadedSourcesLimit', 'The debug adapter returned too many loaded sources.'));
		return Object.freeze(entries.map((value, index) => source(value, `sources[${index}]`, this.workspace) ?? invalidLoadedSource()));
	}

	async readMemory(memoryReference: string, offset: number, count: number): Promise<IDebugMemoryRead> {
		this.checkMemory(memoryReference, offset, count, false);
		const body = record((await this.request('readMemory', { memoryReference, offset, count })).body, 'readMemory body');
		const encoded = body.data === undefined ? '' : string(body.data, 'memory data');
		if (encoded.length > 5464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new TypeError(localize('debug.invalidMemoryData', 'The debug adapter returned invalid memory bytes.'));
		const data = decodeBase64(encoded).buffer;
		const unreadableBytes = body.unreadableBytes === undefined ? 0 : positiveInteger(body.unreadableBytes, 'unreadable memory bytes', true);
		if (data.length + unreadableBytes > count) throw new RangeError(localize('debug.invalidMemoryData', 'The debug adapter returned invalid memory bytes.'));
		return { address: string(body.address, 'memory address'), data, unreadableBytes };
	}

	async writeMemory(memoryReference: string, offset: number, data: Uint8Array): Promise<number> {
		this.checkMemory(memoryReference, offset, data.length, true);
		const body = record((await this.request('writeMemory', { memoryReference, offset, data: encodeBase64(VSBuffer.wrap(new Uint8Array(data))), allowPartial: false })).body ?? {}, 'writeMemory body');
		const written = body.bytesWritten === undefined ? data.length : positiveInteger(body.bytesWritten, 'written memory bytes', true);
		if (written > data.length || body.offset !== undefined && body.offset !== 0) throw new RangeError(localize('debug.invalidMemoryData', 'The debug adapter returned invalid memory bytes.'));
		return written;
	}

	private checkMemory(reference: string, offset: number, count: number, write: boolean): void {
		if (typeof reference !== 'string' || !reference.length || reference.length > 4096 || reference.includes('\0') || !Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || count < 1 || count > 4096) throw new TypeError(localize('debug.invalidMemoryRange', 'A memory request requires a reference and between 1 and 4096 bytes.'));
		if (this.state !== 'stopped' || !(write ? this.capabilities.supportsWriteMemoryRequest : this.capabilities.supportsReadMemoryRequest)) throw new Error(localize('debug.memoryUnavailable', 'Pause a debug adapter that supports this memory operation first.'));
	}

	async exceptionInfo(threadId: number): Promise<IDebugExceptionInfo> {
		if (this.state !== 'stopped' || !this.capabilities.supportsExceptionInfoRequest) throw new Error(localize('debug.exceptionInfoUnsupported', 'Exception details require a paused adapter with exception-info support.'));
		const body = record((await this.request('exceptionInfo', { threadId: integer(threadId, 'exception thread') })).body, 'exceptionInfo body');
		return { exceptionId: string(body.exceptionId, 'exception id'), breakMode: string(body.breakMode, 'exception break mode'), ...(typeof body.description === 'string' ? { description: body.description } : {}), ...(body.details === undefined ? {} : { details: decodeExceptionDetails(body.details, 0) }) };
	}

	async cancelProgress(progressId: string): Promise<void> {
		if (!this.capabilities.supportsCancelRequest || !progressId || progressId.length > 256) return;
		await this.request('cancel', { progressId });
	}

	private _resolvedConfiguration: IDebugConfiguration;
	get resolvedConfiguration(): IDebugConfiguration { return this._resolvedConfiguration; }
	get parentSession(): IDebugSession | undefined { return this.sessionOptions.parentSession; }
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly customEventEmitter = this._register(new Emitter<{ readonly event: string; readonly body?: unknown; }>());
	private readonly exceptionsEmitter = this._register(new Emitter<readonly string[]>());
	private exceptions: DebugExceptionsSnapshot = { version: 0, appliedVersion: 0, appliedFilters: [], filters: [], error: null };
	readonly onDidChangeExceptionBreakpoints = this.exceptionsEmitter.event;
	get exceptionBreakpoints(): readonly string[] { return this.exceptions.appliedFilters; }
	private readonly outputEmitter = this._register(new Emitter<void>());
	private consoleSnapshot: DebugConsoleSnapshot = { revision: 0, entries: [] };
	private consoleId = "";
	private retainedConsoles: readonly string[] = [];
	private retentionRevision = 0;
	private processService!: IDebugAdapterProcessService;
	private transport: RawDebugSession | undefined;
	private adapterStarted = false;
	private readSequence = 0;
	private polling = false;
	private readonly adapterReads = new TaskQueue();
	private processClose: Promise<void> | undefined;
	private disconnecting: Promise<void> | undefined;
	private trackers: readonly IDebugAdapterTracker[] = [];
	private readonly trackerDisposables = new Map<IDebugAdapterTracker, IDisposable>();
	private readonly trackerLifetime = new AbortController();
	private readonly trackerMessages = new TaskQueue();
	private queuedTrackerMessages = 0;
	private trackerMessagesStopped = false;
	private adapterExitCode: number | undefined;
	private trackersEnded = false;
	private trackersStopping = false;
	private trackerErrorReported = false;
	private _state: DebugSessionState = "starting";
	private _reason: string | undefined;
	private _threadId: number | undefined;
	private readonly threadEmitter = this._register(new Emitter<number | undefined>());
	readonly onDidChangeThread = this.threadEmitter.event;
	private runtime: DebugSessionSnapshot | undefined;
	get inspectionRevision(): number { return this.runtime?.inspectionRevision ?? 0; }
	private readonly nameEmitter = this._register(new Emitter<string>());
	private sessionName: string;
	private breakpointVersion = 0;
	private breakpointSnapshot: DebugBreakpointsSnapshot | undefined;
	private _capabilities: IDebugSessionCapabilities = Object.freeze({ supportsRestart: false, supportsTerminate: false, supportsSetVariable: false, supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, supportsCompletionsRequest: false, supportsCancelRequest: false, completionTriggerCharacters: Object.freeze([]), exceptionBreakpointFilters: Object.freeze([]) });

	readonly onDidChangeState: Event<DebugSessionState> = this.stateEmitter.event;
	readonly onDidChangeReplElements: Event<void> = this.outputEmitter.event;
	readonly onDidCustomEvent = this.customEventEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;
	get name(): string { return this.sessionName; }
	setName(name: string): void {
		this.assertNotDisposed();
		if (typeof name !== 'string' || name.length > 32768 || name.includes('\0')) { throw new TypeError('Invalid debug session name'); }
		if (name === this.sessionName) { return; }
		this.sessionName = name;
		this.nameEmitter.fire(name);
	}

	getDebugProtocolBreakpoint(breakpointId: string): unknown {
		this.assertNotDisposed();
		const binding = this.breakpointSnapshot?.version === this.breakpointVersion ? this.breakpointSnapshot.bindings.find(point => point.intent.id === breakpointId) : undefined;
		return binding && !binding.pending && !binding.removed && binding.intent.enabled ? binding.protocol ?? undefined : undefined;
	}

	async customRequest(command: string, args?: unknown): Promise<unknown> {
		this.assertNotDisposed();
		if (this.processClose) throw new CancellationError();
		if (this.state === "terminated" || this.state === "error") throw new Error("Debug session has ended");
		if (!command || command.length > 256 || command.includes("\0")) throw new TypeError("Invalid Debug Adapter command");
		return (await this.request(command, args)).body;
	}
	get output(): string { return this.consoleSnapshot.entries.map(entry => entry.output).join(''); }
	getReplElements() { return this.consoleSnapshot.entries; }
	get consoleSessionId(): string { return this.consoleId; }
	get replElementsRevision(): number { return this.consoleSnapshot.revision; }
	get retainedConsoleSessionIds(): readonly string[] { return this.retainedConsoles; }
	get consoleCatalogRevision(): number { return this.retentionRevision; }
	async clearRepl(): Promise<void> { this.acceptConsole(await this.processService.readConsole(this.id, { clear: true })); }
	private acceptConsole(snapshot: DebugConsoleSnapshot): void {
		if (snapshot.revision <= this.consoleSnapshot.revision) return;
		this.consoleSnapshot = snapshot;
		this.outputEmitter.fire();
	}

	private constructor(
		readonly configuration: IDebugConfiguration,
		readonly id: string,
		private readonly breakpoints: () => readonly IDebugBreakpoint[],
		private readonly workspace: URI | undefined,
		private readonly runInTerminal: DebugSessionStartOptions["runInTerminal"],
		private readonly startDebugging: DebugSessionStartOptions['startDebugging'],
		private readonly updateBreakpoints: DebugSessionStartOptions["updateBreakpoints"],
		private readonly addBreakpoint: DebugSessionStartOptions['addBreakpoint'],
		private readonly removeBreakpoint: DebugSessionStartOptions['removeBreakpoint'],
		private readonly initialExceptionBreakpoints: DebugSessionStartOptions["exceptionBreakpoints"],
		private readonly additionalBreakpoints: DebugSessionStartOptions["additionalBreakpoints"],
		resolvedConfiguration: DebugSessionStartOptions["resolvedConfiguration"],
		readonly sessionOptions: IDebugSessionOptions,
	) {
		super();
		this._resolvedConfiguration = Object.freeze({ ...configuration, ...resolvedConfiguration });
		this.sessionName = this._resolvedConfiguration.name;
		this._register(toDisposable(() => {
			this.trackerLifetime.abort();
			void this.closeProcess();
			this.trackers = [];
			this.trackerDisposables.clear();
			this.adapterReads.clearPending();
			this.trackerMessages.clearPending();
		}));
	}

	static async start(options: DebugSessionStartOptions): Promise<DebugSession> {
		const session = new DebugSession(
			options.configuration, options.id ?? generateUuid(), options.breakpoints,
			options.workspace, options.runInTerminal, options.startDebugging, options.updateBreakpoints, options.addBreakpoint, options.removeBreakpoint,
			options.exceptionBreakpoints, options.additionalBreakpoints, options.resolvedConfiguration, Object.freeze({ ...options.sessionOptions }),
		);
		session.processService = options.processService;
		try {
			const relation = options.admitted ? await options.processService.manageSession(session.id, 'read') : await options.processService.reserveSession({
				id: session.id, workspaceId: options.workspace?.toString() ?? 'debug', parentId: options.sessionOptions?.parentSession?.id ?? null,
				lifecycleManagedByParent: options.sessionOptions?.lifecycleManagedByParent ?? false,
				mergeConsole: options.sessionOptions?.consoleMode === 1,
				noDebug: options.sessionOptions?.noDebug ?? (typeof options.resolvedConfiguration.arguments.noDebug === 'boolean' ? options.resolvedConfiguration.arguments.noDebug : null),
			});
			if (relation.ended) throw new CancellationError();
			const prepared = await options.processService.prepareSession(session.id, typeof options.resolvedConfiguration.arguments.noDebug === 'boolean' ? options.resolvedConfiguration.arguments.noDebug : undefined);
			session.consoleId = prepared.consoleId;
			session.retainedConsoles = prepared.consoleIds;
			session.retentionRevision = prepared.consoleCatalogRevision;
			options.onWillStart?.(session);
			let adapter = options.resolvedConfiguration.adapter;
			if (!adapter) {
				if (!options.createDebugAdapterDescriptor) throw new Error(localize('debug.adapterDescriptorUnavailable', 'The Debug Adapter factory did not provide an adapter.'));
				adapter = await options.createDebugAdapterDescriptor(session) ?? undefined;
				if (!adapter) throw new Error(localize('debug.adapterDescriptorUnavailable', 'The Debug Adapter factory did not provide an adapter.'));
				session._resolvedConfiguration = Object.freeze({ ...session.resolvedConfiguration, adapter });
			}
			session.transport = new RawDebugSession(options.processService, adapter.inline);
			if (session.isDisposed) { throw new CancellationError(); }
			const trackers = await options.createDebugAdapterTrackers?.(session) ?? [];
			if (session.isDisposed) {
				for (const tracker of trackers) { tracker.dispose(); }
				throw new CancellationError();
			}
			session.trackers = trackers;
			for (const tracker of trackers) session.trackerDisposables.set(tracker, session._register(toDisposable(() => tracker.dispose())));
			await session.callTrackers(tracker => tracker.onWillStartSession?.());
			if (session.isDisposed) { throw new CancellationError(); }
			await session.transport.start(adapter.inline
				? { arguments: [], connection: { type: 'client' }, ...(options.configuration.dirId ? { dirId: options.configuration.dirId } : {}) }
				: { ...adapter, ...(options.configuration.dirId ? { dirId: options.configuration.dirId } : {}) });
			if (session.isDisposed) { throw new CancellationError(); }
			session.adapterStarted = true;
			session.polling = true;
			void session.poll();
			await session.initialize(options.resolvedConfiguration.arguments);
			const completed = await options.processService.manageSession(session.id, 'read');
			session.retainedConsoles = completed.consoleIds;
			session.retentionRevision = completed.consoleCatalogRevision;
			return session;
		} catch (error) {
			const cancelled = session.isDisposed;
			if (!cancelled) { await session.reportTrackerError(error); }
			await session.closeProcess();
			await session.stopTrackers();
			await session.endTrackers();
			session.dispose();
			await options.processService.manageSession(session.id, 'end').catch(() => { });
			throw cancelled ? new CancellationError() : error;
		}
	}

	get state() { return this._state; }
	get reason() { return this._reason; }
	get threadId() { return this._threadId; }
	get capabilities() { return this._capabilities; }

	continue(): Promise<void> { return this.threadCommand("continue"); }
	pause(): Promise<void> { return this.threadCommand("pause"); }
	stepOver(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("next", granularity); }
	stepInto(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("stepIn", granularity); }
	stepOut(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("stepOut", granularity); }

	async restart(): Promise<void> {
		if (!this._capabilities.supportsRestart) throw new Error("The Debug Adapter does not support restart requests");
		await this.request("restart");
	}

	async inspectStack(threadId?: number): Promise<IDebugStackInspection> {
		const result = await this.transport!.inspect({ kind: 'stack', ...(threadId === undefined ? {} : { threadId: integer(threadId, 'threadId') }) }, this.runtime?.inspectionRevision ?? 0);
		if (result.kind !== 'stack') throw new TypeError('Invalid stack inspection result');
		const threads = result.threads.map(thread);
		const selectedThread = result.threadId ?? undefined;
		return { threads, frames: result.frames.map((value, index) => ({ ...stackFrame(value, index, this.workspace), ...(selectedThread === undefined ? {} : { threadId: selectedThread }) })), ...(selectedThread === undefined ? {} : { threadId: selectedThread }) };
	}

	async inspectFrame(frameId: number): Promise<readonly IDebugScopeInspection[]> {
		const result = await this.transport!.inspect({ kind: 'frame', frameId: integer(frameId, 'frameId') }, this.runtime?.inspectionRevision ?? 0);
		if (result.kind !== 'frame') throw new TypeError('Invalid frame inspection result');
		return result.scopes.map((entry, index) => ({ scope: scope(entry.scope, index), variables: entry.variables.map(variable), ...(entry.error === null ? {} : { error: entry.error }) }));
	}

	async evaluateWatchExpressions(expressions: readonly string[], frameId?: number): Promise<readonly IDebugWatchResult[]> {
		if (!expressions.length) return [];
		const result = await this.transport!.inspect({ kind: 'watch', expressions, ...(frameId === undefined ? {} : { frameId: integer(frameId, 'frameId') }) }, this.runtime?.inspectionRevision ?? 0);
		if (result.kind !== 'watch') throw new TypeError('Invalid Watch inspection result');
		return result.values.map(value => {
			if (value.error !== null) return { expression: value.expression, error: value.error };
			const body = record(value.result, 'Watch result');
			return { expression: value.expression, result: { result: string(body.result, 'evaluate result'), variablesReference: positiveInteger(body.variablesReference, 'evaluate variablesReference', true), ...(typeof body.type === 'string' ? { type: body.type } : {}) } };
		});
	}

	async threads(): Promise<readonly IDebugThread[]> {
		const body = record((await this.request("threads")).body, "threads body");
		return Object.freeze(array(body.threads, "threads").map((value, index) => thread(value, index)));
	}

	selectThread(threadId: number): void {
		this.setSelectedThread(integer(threadId, "threadId"));
	}

	private setSelectedThread(threadId: number | undefined): void {
		if (this._threadId === threadId) return;
		this._threadId = threadId;
		this.threadEmitter.fire(threadId);
	}

	async stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]> {
		const selectedThreadId = threadId === undefined ? await this.requireThreadId() : integer(threadId, "threadId");
		this.setSelectedThread(selectedThreadId);
		const body = record((await this.request("stackTrace", { threadId: selectedThreadId, startFrame: 0, levels: 100 })).body, "stackTrace body");
		return array(body.stackFrames, "stackFrames").map((value, index) => ({ ...stackFrame(value, index, this.workspace), threadId: selectedThreadId }));
	}

	async scopes(frameId: number): Promise<readonly IDebugScope[]> {
		const body = record((await this.request("scopes", { frameId: integer(frameId, 'frameId') })).body, "scopes body");
		return array(body.scopes, "scopes").map((value, index) => scope(value, index));
	}

	async variables(reference: number, inspectionRevision?: number): Promise<readonly IDebugVariable[]> {
		const result = await this.transport!.inspect({ kind: 'variables', variablesReference: positiveInteger(reference, 'variablesReference', true) }, inspectionRevision ?? this.runtime?.inspectionRevision ?? 0);
		if (result.kind !== 'variables') throw new TypeError('Invalid variable inspection result');
		return result.variables.map(variable);
	}

	async setVariable(variablesReference: number, name: string, value: string): Promise<IDebugVariable> {
		if (!this._capabilities.supportsSetVariable) {
			throw new Error(localize("debug.setVariableUnsupported", "The debug adapter does not support changing variables."));
		}
		if (this._state !== "stopped") {
			throw new Error(localize("debug.setVariableNotStopped", "Pause execution before changing a variable."));
		}
		if (value.length > 32_768 || value.includes("\0")) {
			throw new TypeError(localize("debug.invalidVariableValue", "The variable value must contain at most 32768 characters and no null characters."));
		}
		const body = record((await this.request("setVariable", { variablesReference: positiveInteger(variablesReference, "variablesReference"), name, value })).body, "setVariable body");
		// In a setVariable response an omitted child reference denotes a scalar.
		return variable({ ...body, name, variablesReference: body.variablesReference === undefined ? 0 : body.variablesReference }, 0);
	}

	async evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult> {
		const normalized = expression.trim();
		if (!normalized || normalized.length > 32_768 || normalized.includes("\0")) throw new TypeError("Debug expression must contain 1 to 32768 characters");
		const body = record((await this.request("evaluate", { expression: normalized, context, ...(frameId === undefined ? {} : { frameId: integer(frameId, "frameId") }) })).body, "evaluate body");
		if (context === 'repl') this.acceptConsole(await this.processService.readConsole(this.id));
		return Object.freeze({ result: string(body.result, "evaluate result"), variablesReference: positiveInteger(body.variablesReference, "evaluate variablesReference", true), ...(typeof body.type === "string" ? { type: body.type } : {}) });
	}

	async completions(frameId: number | undefined, threadId: number, text: string, position: Position, token: CancellationToken): Promise<IDebugCompletionsResponse | undefined> {
		if (!this._capabilities.supportsCompletionsRequest || token.isCancellationRequested || this.processClose) return undefined;
		if (text.length > 32_768 || text.includes('\0')) throw new TypeError(localize('debug.invalidCompletionText', 'Completion text must contain at most 32768 characters and no null characters.'));
		integer(threadId, 'threadId');
		const lines = text.split(/\r\n|\r|\n/);
		const line = positiveInteger(position.lineNumber, 'completion line');
		const column = positiveInteger(position.column, 'completion column');
		if (line > lines.length || column > lines[line - 1]!.length + 1) throw new TypeError(localize('debug.invalidCompletionPosition', 'The completion position is outside the input text.'));
		const epoch = this.runtime?.inspectionRevision;
		const selectedThread = this._threadId;
		let value: unknown;
		try {
			value = await raceCancellation(this.transport!.request('completions', {
				text, line, column, ...(frameId === undefined ? {} : { frameId: integer(frameId, 'frameId') }),
			}, token, this._capabilities.supportsCancelRequest), token);
		} catch (error) {
			// Rust can invalidate the request before the observation reader has
			// published that execution change to this facade.
			if (!this.processClose) await this.readAdapterPage(true);
			if (token.isCancellationRequested || this.processClose || epoch !== this.runtime?.inspectionRevision) return undefined;
			throw error;
		}
		if (!value || token.isCancellationRequested || this.processClose) return undefined;
		await this.readAdapterPage(true);
		if (token.isCancellationRequested || this.processClose || epoch !== this.runtime?.inspectionRevision || selectedThread !== this._threadId) return undefined;
		const reply = response(record(value, 'completions response'));
		if (!reply.success) throw new Error(reply.message || localize('debug.completionsFailed', 'The debug adapter could not provide completions.'));
		const targets = array(record(reply.body, 'completions body').targets, 'completion targets');
		if (targets.length > 4096) throw new TypeError(localize('debug.tooManyCompletions', 'The debug adapter returned too many completions.'));
		return { body: { targets: targets.map((target, index) => completionItem(target, index, lines[line - 1]!, column)) } };
	}

	async source(sourceValue: IDebugSource): Promise<IDebugSourceContent> {
		const sourceReference = positiveInteger(sourceValue.sourceReference, "sourceReference");
		const body = record((await this.request("source", { source: sourceValue, sourceReference })).body, "source body");
		return Object.freeze({ content: string(body.content, "source content"), ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}) });
	}

	async setExceptionBreakpoints(filters: readonly string[]): Promise<void> {
		this.acceptExceptions(await this.transport!.setExceptionBreakpoints(filters));
	}

	async dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse> {
		if (!this._capabilities.supportsDataBreakpoints) throw new Error(localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints"));
		if (this._state !== "stopped") throw new Error(localize("debug.dataRequiresPause", "Data breakpoints require the paused session that identified the variable."));
		const argumentsValue: Record<string, unknown> = { name: string(name, "data breakpoint name") };
		if (variablesReference !== undefined) argumentsValue.variablesReference = positiveInteger(variablesReference, "variablesReference");
		if (frameId !== undefined) argumentsValue.frameId = integer(frameId, "frameId");
		const response = await this.request("dataBreakpointInfo", argumentsValue);
		const body = record(response.body, "dataBreakpointInfo");
		const dataId = body.dataId === null ? null : string(body.dataId, "dataId");
		const accessTypes = body.accessTypes === undefined ? ["write"] : array(body.accessTypes, "accessTypes");
		if (!accessTypes.every(type => type === "read" || type === "write" || type === "readWrite")) throw new TypeError("Invalid data breakpoint access types");
		return { dataId, description: string(body.description, "description"), canPersist: body.canPersist === true, accessTypes: Object.freeze(accessTypes as DataBreakpointAccessType[]) };
	}

	async disassemble(memoryReference: string, offset: number, instructionOffset: number, instructionCount: number): Promise<readonly IDisassembledInstruction[]> {
		if (!this._capabilities.supportsDisassembleRequest) {
			throw new Error(localize("debug.disassemblyUnsupported", "The debug adapter does not support disassembly."));
		}
		if (this._state !== "stopped") {
			throw new Error(localize("debug.disassemblyRequiresPause", "Pause debugging to view disassembly."));
		}
		if (!memoryReference.trim() || memoryReference.includes("\0") || memoryReference.length > 32_768) {
			throw new TypeError("Invalid disassembly memory reference");
		}
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(instructionOffset) || !Number.isSafeInteger(instructionCount) || instructionCount <= 0 || instructionCount > 200) {
			throw new TypeError("Disassembly offsets must be integers and instruction count must be between 1 and 200");
		}
		const response = await this.request("disassemble", { memoryReference, offset, instructionOffset, instructionCount, resolveSymbols: true });
		const instructions = array(record(response.body, "disassemble").instructions, "instructions");
		if (instructions.length > instructionCount) { throw new TypeError("Disassembly returned more instructions than requested"); }
		let location: IDebugSource | undefined;
		return Object.freeze(instructions.map((value, index) => {
			const item = record(value, `instructions[${index}]`);
			const instruction: { -readonly [K in keyof IDisassembledInstruction]: IDisassembledInstruction[K] } = {
				address: string(item.address, "instruction address"),
				instruction: string(item.instruction, "instruction"),
			};
			if (!instruction.address) { throw new TypeError("Instruction address must not be empty"); }
			if (item.instructionBytes !== undefined) { instruction.instructionBytes = string(item.instructionBytes, "instructionBytes"); }
			if (item.symbol !== undefined) { instruction.symbol = string(item.symbol, "symbol"); }
			// DAP permits the source to be omitted when adjacent instructions share a file.
			if (item.location !== undefined) { location = source(item.location, "instruction location", this.workspace); }
			if (location) { instruction.location = location; }
			if (item.line !== undefined) { instruction.line = positiveInteger(item.line, "instruction line", true); }
			if (item.column !== undefined) { instruction.column = positiveInteger(item.column, "instruction column", true); }
			if (item.endLine !== undefined) { instruction.endLine = positiveInteger(item.endLine, "instruction end line", true); }
			if (item.endColumn !== undefined) { instruction.endColumn = positiveInteger(item.endColumn, "instruction end column", true); }
			if (item.presentationHint !== undefined) {
				if (item.presentationHint !== "normal" && item.presentationHint !== "invalid") { throw new TypeError("Invalid instruction presentation hint"); }
				instruction.presentationHint = item.presentationHint;
			}
			return Object.freeze(instruction);
		}));
	}

	async syncBreakpoints(): Promise<void> {
		const version = ++this.breakpointVersion;
		const points = [...this.breakpoints(), ...this.additionalBreakpoints?.() ?? []];
		const intents = points.flatMap(point => {
			const location = this.breakpointLocation(point);
			return location ? [{
				id: point.id, enabled: point.enabled, location,
				...(point.condition === undefined ? {} : { condition: point.condition }),
				...(point.hitCondition === undefined ? {} : { hitCondition: point.hitCondition }),
				...('resource' in point && point.logMessage !== undefined ? { logMessage: point.logMessage } : {})
			}] : [];
		});
		await this.transport!.setBreakpoints(version, intents);
		while (!this.isDisposed && !this.processClose) {
			const snapshot = await this.transport!.readBreakpoints();
			if (this.isDisposed || this.processClose) throw new CancellationError();
			this.acceptBreakpoints(snapshot);
			if (snapshot.appliedVersion >= version) {
				if (snapshot.error) throw new Error(snapshot.error);
				return;
			}
			await timeout(POLL_DELAY_MS);
		}
		throw new CancellationError();
	}

	private breakpointLocation(point: DebugBreakpoint): DebugBreakpointIntent['location'] | undefined {
		if ('resource' in point) {
			const resource = point.resource;
			if (resource.scheme === 'debug') {
				const query = new URLSearchParams(resource.query);
				const reference = query.get('ref');
				if (query.get('session') !== this.id || !reference || !/^[1-9]\d*$/.test(reference) || !Number.isSafeInteger(Number(reference))) return undefined;
				return { kind: 'source', source: { sourceReference: Number(reference) }, line: point.lineNumber, ...(point.columnNumber === undefined ? {} : { column: point.columnNumber }) };
			}
			if (resource.scheme !== 'file' && !isRemoteResource(resource)) return undefined;
			return { kind: 'source', source: { path: resource.scheme === 'file' ? resource.fsPath : getRemoteWorkspacePath(resource) }, line: point.lineNumber, ...(point.columnNumber === undefined ? {} : { column: point.columnNumber }) };
		}
		switch (point.kind) {
			case 'function': return { kind: 'function', name: point.name };
			case 'data': return { kind: 'data', dataId: point.dataId, accessType: point.accessType, adapterType: point.adapterType, canPersist: point.canPersist, ...(point.sessionId === undefined ? {} : { sessionId: point.sessionId }) };
			case 'instruction': return { kind: 'instruction', instructionReference: point.instructionReference, ...(point.offset === undefined ? {} : { offset: point.offset }), sessionId: point.sessionId };
		}
	}

	private acceptBreakpoints(snapshot: DebugBreakpointsSnapshot): void {
		if (snapshot.version < this.breakpointVersion || this.breakpointSnapshot && snapshot.revision <= this.breakpointSnapshot.revision) return;
		const previous = this.breakpointSnapshot;
		this.breakpointSnapshot = snapshot;
		const updates = [];
		for (const binding of snapshot.bindings) {
			if (!binding.applicable || binding.pending) continue;
			const before = previous?.version === snapshot.version ? previous.bindings.find(point => point.intent.id === binding.intent.id) : undefined;
			if (binding.removed) { if (!before?.removed) this.removeBreakpoint?.(binding.intent.id); continue; }
			if (binding.created && !before?.created && binding.intent.location.kind === 'source') {
				const location = binding.intent.location;
				const protocol = record(binding.protocol, 'Debug breakpoint');
				this.addBreakpoint?.(source(protocol.source ?? location.source, 'breakpoint source', this.workspace)!, location.line, location.column, binding.intent.id);
			}

			if (!before || before.pending || before.verified !== binding.verified || before.unsupported !== binding.unsupported || before.message !== binding.message || before.created !== binding.created) updates.push({ id: binding.intent.id, verified: binding.verified, ...(binding.unsupported ? { message: unsupportedBreakpoint(binding.unsupported) } : binding.message === null ? {} : { message: binding.message }) });
		}
		if (updates.length) this.updateBreakpoints?.(updates);
	}

	disconnect(): Promise<void> {
		return this.disconnecting ??= this.disconnectOnce();
	}

	private async disconnectOnce(): Promise<void> {
		if (!this.isDisposed && this._state !== "terminated" && this._state !== "error" && !(await this.processService.manageSession(this.id, 'read').catch(() => undefined))?.ended) {
			try { await this.request("disconnect", { restart: false, ...(this._capabilities.supportsTerminate ? { terminateDebuggee: this.configuration.request === 'launch' } : {}) }); } catch (error) { this.emitOutput(`Debug disconnect failed: ${getErrorMessage(error)}\n`); }
		}
		await this.closeProcess();
		this.setState("terminated");
		this.dispose();
	}

	private async initialize(launchArguments: Readonly<Record<string, unknown>>): Promise<void> {
		await this.transport!.initialize({
			publicId: this.id,
			adapterId: this.resolvedConfiguration.type, request: this.resolvedConfiguration.request,
			arguments: { ...launchArguments, type: this.resolvedConfiguration.type, request: this.resolvedConfiguration.request, name: this.name }, runInTerminal: Boolean(this.runInTerminal), startDebugging: Boolean(this.startDebugging)
		});
		await this.waitForInitialization('configuring');
		await this.syncBreakpoints();
		await this.transport!.configurationDone(this.initialExceptionBreakpoints?.());
		await this.waitForInitialization('active');
	}

	private async waitForInitialization(phase: DebugSessionSnapshot['phase']): Promise<void> {
		while (!this.isDisposed) {
			if (this.runtime?.phase === phase) return;
			if (this.runtime?.phase === 'ended') throw new Error(this.runtime.reason ?? localize('debug.initializationEnded', 'The debug session ended during initialization.'));
			if (this.processClose) throw new CancellationError();
			await timeout(POLL_DELAY_MS);
		}
		throw new CancellationError();
	}

	private async threadCommand(command: string, granularity?: DebugSteppingGranularity): Promise<void> {
		if (granularity && !this._capabilities.supportsSteppingGranularity) {
			throw new Error(localize("debug.instructionStepUnsupported", "The debug adapter does not support instruction stepping."));
		}
		await this.request(command, { threadId: await this.requireThreadId(), ...(granularity ? { granularity } : {}) });
	}

	private acceptExceptions(snapshot: DebugExceptionsSnapshot): void {
		if (snapshot.version < this.exceptions.version || snapshot.appliedVersion < this.exceptions.appliedVersion) return;
		const changed = snapshot.appliedVersion !== this.exceptions.appliedVersion;
		this.exceptions = snapshot;
		if (changed) this.exceptionsEmitter.fire(snapshot.appliedFilters);
	}

	private acceptRuntime(snapshot: DebugSessionSnapshot): void {
		if (this.runtime && snapshot.revision <= this.runtime.revision) return;
		const previous = this.runtime;
		this.runtime = snapshot;
		this._capabilities = Object.freeze(snapshot.capabilities);
		this._reason = snapshot.reason ?? undefined;
		if (snapshot.state === 'stopped' && previous?.executionRevision !== snapshot.executionRevision) this.setSelectedThread(snapshot.stoppedThreadId ?? undefined);
		// A fresh pause can have the same enum and thread as the last pause.
		// Publish its new inspection lifetime even when running was not observed.
		const unchangedState = this._state === snapshot.state;
		const modelChanged = previous?.executionRevision !== snapshot.executionRevision || previous?.inspectionRevision !== snapshot.inspectionRevision || JSON.stringify(previous?.capabilities) !== JSON.stringify(snapshot.capabilities);
		this.setState(snapshot.state);
		if (unchangedState && modelChanged) this.stateEmitter.fire(snapshot.state);
	}

	private async requireThreadId(): Promise<number> {
		if (this._threadId !== undefined) return this._threadId;
		const first = (await this.threads())[0];
		if (!first) throw new Error("The Debug Adapter did not report any threads");
		this.setSelectedThread(first.id);
		return first.id;
	}

	private async request(command: string, args?: unknown): Promise<DapResponse> {
		if (this.processClose) throw new CancellationError();
		if (!this.transport || !this.adapterStarted) throw new Error("Debug Adapter has not started");
		const value = response(record(await this.transport.request(command, args), 'DAP response'));
		// Publish the backend model before callers act on a successful control request.
		if (!this.processClose && ["continue", "next", "stepIn", "stepOut", "restart", "disconnect", "terminate"].includes(command)) await this.readAdapterPage(true);
		if (!value.success) throw new Error(value.message || `Debug Adapter '${value.command}' request failed`);
		return value;
	}

	private async callTrackers(invoke: (tracker: IDebugAdapterTracker) => void | PromiseLike<void>): Promise<void> {
		// A stalled observer must not hold its peers or session cleanup. The
		// session owns the deadline as callbacks can outlive a Host invocation.
		await Promise.all(this.trackers.map(async tracker => {
			const signal = this.trackerLifetime.signal;
			if (signal.aborted) return;
			let expired = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let cancel: (() => void) | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					cancel = resolve;
					signal.addEventListener('abort', cancel, { once: true });
					timer = setTimeout(() => { expired = true; resolve(); }, TRACKER_CALLBACK_TIMEOUT_MS);
					Promise.resolve().then(() => { if (!signal.aborted) return invoke(tracker); }).then(resolve, reject);
				});
				if (expired && !signal.aborted) {
					this.trackers = this.trackers.filter(value => value !== tracker);
					const disposable = this.trackerDisposables.get(tracker);
					this.trackerDisposables.delete(tracker);
					if (disposable) { this._store.delete(disposable); disposable.dispose(); }
					this.emitOutput(localize('debug.adapterTrackerTimedOut', 'Debug Adapter tracker timed out and was disabled.') + '\n');
				}
			} catch (error) {
				if (!signal.aborted) this.emitOutput(localize('debug.adapterTrackerFailed', 'Debug Adapter tracker failed: {0}', getErrorMessage(error)) + '\n');
			} finally {
				clearTimeout(timer);
				if (cancel) signal.removeEventListener('abort', cancel);
			}
		}));
	}

	private trackMessage(invoke: (tracker: IDebugAdapterTracker) => void | PromiseLike<void>): void {
		if (!this.trackers.length || this.trackerMessagesStopped) { return; }
		if (this.queuedTrackerMessages >= 2048) {
			this.trackerMessagesStopped = true;
			this.trackerMessages.clearPending();
			this.emitOutput(localize('debug.adapterTrackerQueueExceeded', 'Debug Adapter tracker message queue exceeded its limit; message observation stopped.') + '\n');
			return;
		}
		this.queuedTrackerMessages++;
		// Both directions share observer order, independently of transport IO.
		// A callback may await a DAP request whose observation is queued behind it.
		void this.trackerMessages.scheduleSkipIfCleared(() => this.callTrackers(invoke)).finally(() => { this.queuedTrackerMessages--; });
	}

	private async sendMessage(message: unknown): Promise<void> {
		this.assertNotDisposed();
		if (this.processClose) { throw new CancellationError(); }
		await this.transport!.send(message);
	}

	private async reportTrackerError(error: unknown): Promise<void> {
		if (this.trackerErrorReported) { return; }
		this.trackerErrorReported = true;
		await this.callTrackers(tracker => tracker.onError?.(error instanceof Error ? error : new Error(getErrorMessage(error))));
	}

	private async stopTrackers(): Promise<void> {
		if (this.trackersStopping) { return; }
		this.trackersStopping = true;
		this.trackerMessagesStopped = true;
		if (!this.isDisposed) {
			const deadline = timeout(TRACKER_CALLBACK_TIMEOUT_MS);
			try {
				const drained = await Promise.race([
					this.trackerMessages.scheduleSkipIfCleared(() => { }).then(() => true),
					deadline.then(() => false),
				]);
				if (!drained) {
					// A backlog of individually timely callbacks must not accumulate
					// into an unbounded stop. Keep only the current callback in order.
					this.trackerMessages.clearPending();
					await this.trackerMessages.scheduleSkipIfCleared(() => { });
					this.emitOutput(localize('debug.adapterTrackerShutdownBacklog', 'Pending Debug Adapter tracker observations were skipped to finish stopping the session.') + '\n');
				}
			} finally { deadline.cancel(); }
		}
		await this.callTrackers(tracker => tracker.onWillStopSession?.());
	}

	private async endTrackers(): Promise<void> {
		if (this.trackersEnded) { return; }
		this.trackersEnded = true;
		await this.callTrackers(tracker => tracker.onExit?.(this.adapterExitCode, undefined));
	}

	private async poll(): Promise<void> {
		while (this.polling && !this.isDisposed) {
			try {
				const read = await this.readAdapterPage(true);
				if (this.isDisposed || !this.polling) return;
				if (read.outputGap) throw new Error("Debug Adapter output exceeded the retained buffer");

				if (read.protocolError) throw new Error(read.protocolError);
				// Read every retained observation before publishing the backend's
				// terminal state, so output and tracker shutdown keep their order.
				if (read.session?.phase === 'ended' && read.messages.length === 128) continue;
				if (read.session) this.acceptRuntime(read.session);
				if (read.session?.phase === 'ended') {
					this.adapterExitCode = read.exitCode ?? undefined;
					break;
				}
			} catch (error) {
				this._reason = getErrorMessage(error);
				void this.reportTrackerError(error);
				this.setState("error");
				break;
			}
			await timeout(POLL_DELAY_MS);
		}
		this.polling = false;
	}

	private readAdapterPage(deliverEvents: boolean) {
		return this.adapterReads.schedule(async () => {
			const transport = this.transport;
			if (!transport || this.isDisposed) throw new CancellationError();
			const read = await transport.read(this.readSequence, 128);
			if (this.isDisposed) throw new CancellationError();
			if (read.outputGap) throw new Error('Debug Adapter output exceeded the retained buffer');
			this.readSequence = read.nextSequence;
			for (const entry of read.messages) {
				if (entry.direction === 'outgoing') this.trackMessage(tracker => tracker.onWillReceiveMessage?.(entry.message));
				else {
					this.trackMessage(tracker => tracker.onDidSendMessage?.(entry.message));
					if (deliverEvents && !this.processClose) this.acceptMessage(entry.message);
				}
			}
			if (read.exceptions) this.acceptExceptions(read.exceptions);
			if (read.consoleRevision !== undefined && read.consoleRevision !== this.consoleSnapshot.revision) this.acceptConsole(await this.processService.readConsole(this.id));
			if (deliverEvents && !this.processClose && read.breakpointRevision !== undefined && read.breakpointRevision !== this.breakpointSnapshot?.revision) this.acceptBreakpoints(await transport.readBreakpoints());
			if (deliverEvents && !this.processClose && read.session && (read.session.phase !== 'ended' || read.messages.length < 128)) {
				if (read.session.phase === 'ended') this.adapterExitCode = read.exitCode ?? undefined;
				this.acceptRuntime(read.session);
			}
			return read;
		});
	}

	private acceptMessage(value: unknown): void {
		const messageValue = record(value, "DAP message");
		const kind = string(messageValue.type, "DAP message type");
		if (kind === "response") return;
		if (kind === "event") { this.acceptEvent(event(messageValue)); return; }
		if (kind === "request") void this.answerReverseRequest(messageValue);
	}


	private acceptEvent(eventValue: DapEvent): void {
		const body = eventValue.body && typeof eventValue.body === "object" ? eventValue.body as Record<string, unknown> : {};
		if (eventValue.event === "output") return;
		if (eventValue.event === 'progressStart' || eventValue.event === 'progressUpdate' || eventValue.event === 'progressEnd') {
			const progressId = string(body.progressId, 'progress id');
			if (!progressId || progressId.length > 256) throw new TypeError(localize('debug.invalidProgressId', 'Invalid debug progress ID.'));
			if (eventValue.event === 'progressEnd') this.progressEnds.fire({ progressId });
			else {
				const percentage = body.percentage === undefined ? undefined : body.percentage;
				if (percentage !== undefined && (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100)) throw new TypeError(localize('debug.invalidProgressPercentage', 'Invalid debug progress percentage.'));
				const update = { progressId, ...(typeof body.message === 'string' ? { message: body.message.slice(0, 4096) } : {}), ...(percentage === undefined ? {} : { percentage }) };
				if (eventValue.event === 'progressStart') this.progressStarts.fire({ ...update, title: string(body.title, 'progress title').slice(0, 4096), cancellable: body.cancellable === true });
				else this.progressUpdates.fire(update);
			}
			return;
		}
		if (eventValue.event === 'memory') {
			this.memoryChanges.fire({ memoryReference: string(body.memoryReference, 'memory reference'), offset: integer(body.offset, 'memory offset'), count: positiveInteger(body.count, 'memory count', true) });
			return;
		}
		if (eventValue.event === 'loadedSource') {
			if (body.reason !== 'new' && body.reason !== 'changed' && body.reason !== 'removed') throw new TypeError(localize('debug.invalidLoadedSourceReason', 'Invalid loaded-source change reason.'));
			this.loadedSourceChanges.fire({ reason: body.reason, source: source(body.source, 'loaded source', this.workspace) ?? invalidLoadedSource() });
			return;
		}

		if (["initialized", "capabilities", "stopped", "continued", "terminated", "exited"].includes(eventValue.event)) return;
		if (eventValue.event === 'breakpoint') return;
		if (["thread", "process", "module", "invalidated"].includes(eventValue.event)) return;
		this.customEventEmitter.fire({ event: eventValue.event, ...(eventValue.body === undefined ? {} : { body: eventValue.body }) });
	}

	private async answerReverseRequest(request: Record<string, unknown>): Promise<void> {
		const sequence = positiveInteger(request.seq, "reverse request seq", true);
		const command = string(request.command, "reverse request command");
		try {
			let body: Readonly<Record<string, unknown>> | undefined;
			if (command === 'runInTerminal' && this.runInTerminal) body = await this.runInTerminal(request.arguments);
			else if (command === 'startDebugging' && this.startDebugging) await this.startDebugging(request.arguments);
			else throw new Error(`Ash does not support Debug Adapter reverse request '${command}'`);
			await this.sendMessage({ type: "response", request_seq: sequence, success: true, command, ...(body === undefined ? {} : { body }) });
		} catch (error) {
			await this.sendMessage({ type: "response", request_seq: sequence, success: false, command, message: getErrorMessage(error) }).catch(sendError => this.emitOutput(`Could not answer Debug Adapter request: ${getErrorMessage(sendError)}\n`));
		}
	}

	private emitOutput(value: string): void {
		if (!value) return;
		void this.processService.readConsole(this.id, { diagnostic: value }).then(snapshot => this.acceptConsole(snapshot), () => { });
	}

	private setState(state: DebugSessionState): void {
		if (state === this._state) return;
		this._state = state;
		this.stateEmitter.fire(state);
		if (state === "terminated" || state === "error") {
			void this.closeProcess();
		}
	}

	private closeProcess(): Promise<void> {
		// A start can return its process after cancellation. Do not memoize the
		// absent process: that late handle must still be released by start().
		const transport = this.transport;
		if (!transport) { return Promise.resolve(); }
		if (this.isDisposed || this.trackers.length === 0) {
			this.polling = false;
			return this.processClose ??= transport.close().catch(() => { }).finally(() => { this.transport = undefined; });
		}
		return this.processClose ??= (async () => {
			// Request completion can precede the view's next observation page.
			// Admit retained observations before the stop hook, without waiting
			// for tracker callbacks or delivering new reverse requests on shutdown.
			try {
				for (let page = 0; page < 4; page++) if ((await this.readAdapterPage(false)).messages.length < 128) break;
			} catch { /* Transport failure must not prevent close acknowledgement. */ }
			await this.stopTrackers();
			this.polling = false;
			await transport.close().catch(() => { /* Process may already be gone. */ });
			await this.endTrackers();
		})().finally(() => { this.transport = undefined; });
	}
}

function response(value: Record<string, unknown>): DapResponse {
	return { seq: positiveInteger(value.seq, "response seq", true), type: "response", request_seq: positiveInteger(value.request_seq, "response request_seq"), success: boolean(value.success, "response success"), command: string(value.command, "response command"), ...(typeof value.message === "string" ? { message: value.message } : {}), ...(value.body === undefined ? {} : { body: value.body }) };
}

function event(value: Record<string, unknown>): DapEvent {
	return { seq: positiveInteger(value.seq, "event seq", true), type: "event", event: string(value.event, "event name"), ...(value.body === undefined ? {} : { body: value.body }) };
}

function stackFrame(value: unknown, index: number, workspace: URI | undefined): IDebugStackFrame {
	const frame = record(value, `stackFrames[${index}]`);
	return { id: integer(frame.id, `stackFrames[${index}].id`), name: string(frame.name, `stackFrames[${index}].name`), lineNumber: positiveInteger(frame.line, `stackFrames[${index}].line`, true), columnNumber: positiveInteger(frame.column, `stackFrames[${index}].column`, true), ...(frame.source === undefined ? {} : { source: source(frame.source, `stackFrames[${index}].source`, workspace) }), ...(frame.instructionPointerReference === undefined ? {} : { instructionPointerReference: string(frame.instructionPointerReference, "instructionPointerReference") }) };
}

function thread(value: unknown, index: number): IDebugThread {
	const input = record(value, `threads[${index}]`);
	return Object.freeze({ id: integer(input.id, `threads[${index}].id`), name: string(input.name, `threads[${index}].name`) });
}

function source(value: unknown, path: string, workspace: URI | undefined): IDebugStackFrame["source"] {
	const input = record(value, path);
	const adapterPath = typeof input.path === "string" ? input.path : undefined;
	const resource = adapterPath ? sourceResource(workspace, adapterPath) : undefined;
	return { ...(typeof input.name === "string" ? { name: input.name } : {}), ...(adapterPath ? { path: adapterPath } : {}), ...(resource ? { resource } : {}), ...(Number.isSafeInteger(input.sourceReference) ? { sourceReference: input.sourceReference as number } : {}) };
}

function scope(value: unknown, index: number): IDebugScope {
	const input = record(value, `scopes[${index}]`);
	return { name: string(input.name, `scopes[${index}].name`), variablesReference: positiveInteger(input.variablesReference, `scopes[${index}].variablesReference`, true), expensive: typeof input.expensive === "boolean" ? input.expensive : false };
}

function variable(value: unknown, index: number): IDebugVariable {
	const input = record(value, `variables[${index}]`);
	const hint = input.presentationHint === undefined ? undefined : record(input.presentationHint, `variables[${index}].presentationHint`);
	return {
		name: string(input.name, `variables[${index}].name`),
		value: string(input.value, `variables[${index}].value`),
		variablesReference: positiveInteger(input.variablesReference, `variables[${index}].variablesReference`, true),
		...(typeof input.type === "string" ? { type: input.type } : {}),
		...(typeof input.memoryReference === 'string' ? { memoryReference: input.memoryReference } : {}),
		...(hint ? {
			presentationHint: {
				...(hint.attributes === undefined ? {} : { attributes: array(hint.attributes, "presentationHint.attributes").map(attribute => string(attribute, "presentationHint attribute")) }),
				...(hint.lazy === undefined ? {} : { lazy: boolean(hint.lazy, "presentationHint.lazy") }),
			}
		} : {}),
	};
}


function record(value: unknown, path: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`); return value; }
function string(value: unknown, path: string): string { if (typeof value !== "string") throw new TypeError(`${path} must be a string`); return value; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`); return value; }
function positiveInteger(value: unknown, path: string, allowZero = false): number { if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) throw new TypeError(`${path} must be ${allowZero ? "non-negative" : "positive"}`); return value as number; }
function integer(value: unknown, path: string): number { if (!Number.isSafeInteger(value)) throw new TypeError(localize('debug.invalidIdentifier', '{0} must be an integer.', path)); return value as number; }

function sourceResource(workspace: URI | undefined, adapterPath: string): URI | undefined {
	if (!workspace || workspace.scheme === "file") {
		try {
			return adapterPath.startsWith('/') && !adapterPath.startsWith('//')
				? URI.from({ scheme: Schemas.file, path: adapterPath })
				: URI.file(/^(?:[a-z]:[\\/]|\\\\)/i.test(adapterPath) ? adapterPath.replaceAll('\\', '/') : adapterPath);
		} catch { return undefined; }
	}
	if (!isRemoteResource(workspace)) return undefined;
	try {
		return withRemoteWorkspacePath(workspace, adapterPath);
	} catch { return undefined; }
}



function unsupportedBreakpoint(reason: DebugBreakpointUnsupported): string {
	switch (reason) {
		case 'conditional': return localize("debug.unsupportedConditionalBreakpoints", "Debug Adapter does not support conditional breakpoints");
		case 'hitConditional': return localize("debug.unsupportedHitConditions", "Debug Adapter does not support hit conditions");
		case 'logPoint': return localize("debug.unsupportedLogpoints", "Debug Adapter does not support logpoints");
		case 'function': return localize("debug.unsupportedFunctionBreakpoints", "Debug Adapter does not support function breakpoints");
		case 'data': return localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints");
		case 'instruction': return localize("debug.unsupportedInstructionBreakpoints", "Debug Adapter does not support instruction breakpoints");
	}
}

/** Adapter data is validated here before it can change the editor's text or selection. */
function completionItem(value: unknown, index: number, line: string, column: number): IDebugCompletionItem {
	const input = record(value, `completion targets[${index}]`);
	const label = string(input.label, 'completion label');
	const optionalText = (key: string): string | undefined => {
		if (input[key] === undefined) return undefined;
		const result = string(input[key], `completion ${key}`);
		if (result.length > 32_768 || result.includes('\0')) {
			throw new TypeError(localize('debug.invalidCompletionField', 'The debug adapter returned an invalid completion field: {0}.', key));
		}
		return result;
	};
	if (label.length > 32_768 || label.includes('\0')) throw new TypeError(localize('debug.invalidCompletionLabel', 'The debug adapter returned an invalid completion label.'));
	const text = optionalText('text');
	const sortText = optionalText('sortText');
	const detail = optionalText('detail');
	const type = optionalText('type');
	const start = input.start === undefined ? undefined : positiveInteger(input.start, 'completion start');
	const length = input.length === undefined ? undefined : positiveInteger(input.length, 'completion length', true);
	const selectionStart = input.selectionStart === undefined ? undefined : positiveInteger(input.selectionStart, 'completion selectionStart', true);
	const selectionLength = input.selectionLength === undefined ? undefined : positiveInteger(input.selectionLength, 'completion selectionLength', true);
	const insertion = text || label;
	if ((start ?? column) > line.length + 1 || (start ?? column) - 1 + (length ?? 0) > line.length
		|| (selectionStart ?? insertion.length) + (selectionLength ?? 0) > insertion.length) throw new TypeError(localize('debug.invalidCompletionRange', 'The debug adapter returned an invalid completion edit range.'));
	return Object.freeze({
		label,
		...(text === undefined ? {} : { text }),
		...(sortText === undefined ? {} : { sortText }),
		...(detail === undefined ? {} : { detail }),
		...(type === undefined ? {} : { type }),
		...(start === undefined ? {} : { start }),
		...(length === undefined ? {} : { length }),
		...(selectionStart === undefined ? {} : { selectionStart }),
		...(selectionLength === undefined ? {} : { selectionLength }),
	});
}

function decodeExceptionDetails(value: unknown, depth: number): IDebugExceptionDetails {
	if (depth > 8) throw new RangeError('Exception details exceed the nesting limit');
	const input = record(value, 'exception details');
	const children = input.innerException === undefined ? undefined : array(input.innerException, 'inner exceptions');
	if (children && children.length > 32) throw new RangeError('Too many inner exceptions');
	return {
		...(typeof input.message === 'string' ? { message: input.message.slice(0, 65536) } : {}),
		...(typeof input.typeName === 'string' ? { typeName: input.typeName.slice(0, 4096) } : {}),
		...(typeof input.stackTrace === 'string' ? { stackTrace: input.stackTrace.slice(0, 65536) } : {}),
		...(children ? { innerException: children.map(child => decodeExceptionDetails(child, depth + 1)) } : {}),
	};
}

function invalidLoadedSource(): never { throw new TypeError(localize('debug.invalidLoadedSource', 'The debug adapter returned an invalid loaded source.')); }
