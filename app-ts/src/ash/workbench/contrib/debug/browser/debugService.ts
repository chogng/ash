import { DebugConsoleService } from '../../../services/debug/browser/debugConsoleService.js';
import { IDebugConsoleService } from '../../../services/debug/common/debugConsoleService.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { localize } from '../../../../nls.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { type JsonValue } from "../../../../base/common/jsonValue.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import { IDebugAdapterProcessService } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileNotFoundError, IFileService } from "../../../../platform/files/common/files.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { Memento } from "../../../common/memento.js";
import { type ITaskRun, ITaskService, type TaskRunStatus } from "../../../services/tasks/common/taskService.js";
import { type ITerminalProfile, ITerminalService } from "../../terminal/browser/terminal.js";
import { DebugAdapterSession } from "../../../services/debug/browser/debugAdapterSession.js";
import { DebugAdapterFactoriesRegistry, IDebugAdapterFactorySource, type DebugAdapterFactorySource } from "../../../services/debug/common/debugAdapterFactory.js";
import { type IDebugStackFrame, type DebugBreakpoint, type IBaseBreakpoint, type IDebugBreakpoint, type IDebugBreakpointUpdate, type IDebugCompound, type IDebugConfiguration, type IDataBreakpoint, type IDataBreakpointOptions, type IFunctionBreakpoint, type IFunctionBreakpointOptions, type IInstructionBreakpoint, type IInstructionBreakpointOptions, IDebugService, type IDebugSession } from "../../../services/debug/common/debugService.js";
import { parseLaunchConfigurationDocument } from "../../../services/debug/common/launchConfiguration.js";

interface PersistedDebugState {
	readonly version: 2;
	readonly breakpoints: readonly PersistedBreakpoint[];
	readonly functionBreakpoints: readonly IFunctionBreakpoint[];
	readonly dataBreakpoints: readonly IDataBreakpoint[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: Readonly<Record<string, readonly string[]>>;
}

interface PersistedBreakpoint {
	readonly resource: string;
	readonly lineNumber: number;
	readonly enabled: boolean;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}

interface DebugSessionRecord {
	readonly session: DebugAdapterSession;
	readonly listener: IDisposable;
}

const EMPTY_STATE: PersistedDebugState = Object.freeze({ version: 2, breakpoints: Object.freeze([]), functionBreakpoints: Object.freeze([]), dataBreakpoints: Object.freeze([]), watchExpressions: Object.freeze([]), exceptionBreakpoints: Object.freeze({}) });

/** Workspace Debug composition over generic DAP processes. */
export class DebugService extends Disposable implements IDebugService {
	private readonly configurationsEmitter = this._register(new Emitter<readonly IDebugConfiguration[]>());
	private readonly breakpointsEmitter = this._register(new Emitter<readonly DebugBreakpoint[]>());
	private readonly watchExpressionsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionBreakpointsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	private readonly focusedFrameEmitter = this._register(new Emitter<IDebugStackFrame | undefined>());
	private currentFocusedStackFrame: IDebugStackFrame | undefined;
	private readonly stateMemento: Memento<PersistedDebugState>;
	private readonly sessionRecords = new Map<string, DebugSessionRecord>();
	private readonly completedPostTasks = new Set<string>();
	private currentConfigurations: readonly IDebugConfiguration[] = Object.freeze([]);
	private currentCompounds: readonly IDebugCompound[] = Object.freeze([]);
	private currentBreakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	private currentFunctionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	private currentDataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	private currentInstructionBreakpoints: readonly IInstructionBreakpoint[] = Object.freeze([]);
	private currentWatchExpressions: readonly string[] = Object.freeze([]);
	private exceptionBreakpointsByType: Readonly<Record<string, readonly string[]>> = Object.freeze({});
	private activeSessionId: string | undefined;
	private refreshGeneration = 0;

	readonly onDidChangeConfigurations: Event<readonly IDebugConfiguration[]> = this.configurationsEmitter.event;
	readonly onDidChangeBreakpoints: Event<readonly DebugBreakpoint[]> = this.breakpointsEmitter.event;
	readonly onDidChangeWatchExpressions: Event<readonly string[]> = this.watchExpressionsEmitter.event;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]> = this.exceptionBreakpointsEmitter.event;
	readonly onDidChangeSession: Event<IDebugSession | undefined> = this.sessionEmitter.event;
	readonly onDidFocusStackFrame = this.focusedFrameEmitter.event;
	get focusedStackFrame() { return this.currentFocusedStackFrame; }

	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDebugAdapterProcessService private readonly processes: IDebugAdapterProcessService | undefined,
		@ITerminalService private readonly terminals: ITerminalService,
		@IStorageService storage: IStorageService,
		@ITaskService private readonly tasks: ITaskService,
		@IDebugAdapterFactorySource private readonly adapters: DebugAdapterFactorySource,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.stateMemento = this._register(new Memento(storage, { id: "debug.workspace", scope: StorageScope.WORKSPACE, target: StorageTarget.USER, defaultValue: () => EMPTY_STATE, parse: parsePersistedDebugState, serialize: serializePersistedDebugState }));
		this.restoreState(this.stateMemento.state);
		this._register(this.stateMemento.onDidChange(event => { if (event.external) this.restoreState(event.state); }));
		this._register(files.onDidChangeFiles(event => { if (event.resources === undefined || event.resources.some(resource => /\/\.vscode\/launch\.json$/i.test(resource.path))) void this.refresh().catch(error => this.reportError(error)); }));
		this._register(adapters.onDidChange(() => { this.setLaunchDocument(Object.freeze([]), Object.freeze([])); void this.refresh().catch(error => this.reportError(error)); }));
		this._register(workspace.onDidChangeWorkspace(() => { this.refreshGeneration += 1; this.setLaunchDocument(Object.freeze([]), Object.freeze([])); void this.stopAll(); }));
		this._register(toDisposable(() => { for (const record of this.sessionRecords.values()) record.listener.dispose(); this.sessionRecords.clear(); }));
	}

	get configurations() { return this.currentConfigurations; }
	get compounds() { return this.currentCompounds; }
	get breakpoints() { return this.currentBreakpoints; }
	get functionBreakpoints() { return this.currentFunctionBreakpoints; }
	get dataBreakpoints() { return this.currentDataBreakpoints; }
	get instructionBreakpoints() { return this.currentInstructionBreakpoints; }
	get watchExpressions() { return this.currentWatchExpressions; }
	get exceptionBreakpoints() { return this.exceptionBreakpointsForType(this.session?.configuration.type); }
	get sessions(): readonly IDebugSession[] { return Object.freeze([...this.sessionRecords.values()].map(record => record.session)); }
	get session(): IDebugSession | undefined { return this.activeSessionId ? this.sessionRecords.get(this.activeSessionId)?.session : undefined; }

	async refresh(): Promise<readonly IDebugConfiguration[]> {
		const generation = ++this.refreshGeneration;
		const folders = this.workspace.getWorkspace().folders;
		const multiRoot = folders.length > 1;
		const configurations: IDebugConfiguration[] = [];
		const compounds: IDebugCompound[] = [];
		await Promise.all(folders.map(async folder => {
			try {
				const document = parseLaunchConfigurationDocument((await this.files.readFile(childResource(folder.uri, ".vscode/launch.json"))).content, type => {
					return this.adapters.get(type)?.createDebugAdapter();
				});
				configurations.push(...document.configurations.map(configuration => Object.freeze({
					...configuration,
					id: multiRoot ? `${folder.id}:${configuration.id}` : configuration.id,
					dirId: folder.id,
					workspaceFolderName: folder.name,
				})));
				compounds.push(...document.compounds.map(compound => Object.freeze({
					...compound,
					id: multiRoot ? `${folder.id}:${compound.id}` : compound.id,
					dirId: folder.id,
					workspaceFolderName: folder.name,
				})));
			} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
		}));
		if (generation === this.refreshGeneration) this.setLaunchDocument(Object.freeze(configurations), Object.freeze(compounds));
		return this.currentConfigurations;
	}

	async start(configuration: IDebugConfiguration): Promise<IDebugSession> {
		if (!this.processes) throw new Error("This host does not provide the Code debug adapter capability");
		const current = this.currentConfigurations.find(candidate => candidate.id === configuration.id);
		if (!current) throw new Error("Debug configuration is no longer present in launch.json");
		return this.startDebugging(current);
	}

	async startDebugging(current: IDebugConfiguration): Promise<IDebugSession> {
		if (!this.processes) throw new Error("This host does not provide the Code debug adapter capability");
		const root = current.dirId
			? this.workspace.getWorkspace().folders.find(folder => folder.id === current.dirId)?.uri
			: this.workspace.getWorkspace().folders[0]?.uri;
		if (!root) throw new Error("Debugging requires an open workspace folder");
		await this.runTask(current.preLaunchTask, "preLaunchTask", current.dirId);
		const session = await DebugAdapterSession.start({ configuration: current, processService: this.processes, breakpoints: () => this.currentBreakpoints, additionalBreakpoints: () => [...this.currentFunctionBreakpoints, ...this.currentDataBreakpoints, ...this.currentInstructionBreakpoints], workspace: root, runInTerminal: value => runDebuggeeInTerminal(this.terminals, value, current.dirId), updateBreakpoints: updates => this.acceptBreakpointUpdates(updates), exceptionBreakpoints: () => this.exceptionBreakpointsForType(current.type) });
		const listener = session.onDidChangeState(state => {
			if (this.session === session && state !== "stopped") this.focusStackFrame(undefined);
			if (this.sessionRecords.has(session.id)) this.sessionEmitter.fire(this.session);
			if (state === "terminated" || state === "error") queueMicrotask(() => { void this.finishSession(session); });
		});
		this.sessionRecords.set(session.id, { session, listener });
		this.activeSessionId = session.id;
		this.focusStackFrame(undefined);
		this.sessionEmitter.fire(session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		return session;
	}

	async startCompound(compound: IDebugCompound): Promise<readonly IDebugSession[]> {
		const current = this.currentCompounds.find(candidate => candidate.id === compound.id);
		if (!current) throw new Error("Debug compound is no longer present in launch.json");
		await this.runTask(current.preLaunchTask, "compound preLaunchTask", current.dirId);
		const configurations = current.configurations.map(reference => resolveCompoundConfiguration(reference, this.currentConfigurations, current.dirId));
		const started: IDebugSession[] = [];
		try {
			for (const configuration of configurations) started.push(await this.start(configuration));
		} catch (error) {
			await Promise.allSettled(started.map(session => this.stop(session)));
			throw error;
		}
		if (current.stopAll) {
			let stopping = false;
			for (const session of started) this._register(session.onDidChangeState(state => {
				if (stopping || (state !== "terminated" && state !== "error")) return;
				stopping = true;
				void Promise.allSettled(started.filter(candidate => candidate !== session).map(candidate => this.stop(candidate)));
			}));
		}
		return Object.freeze(started);
	}

	setActiveSession(session: IDebugSession): void {
		if (!this.sessionRecords.has(session.id)) throw new Error("Debug session is no longer active");
		if (this.activeSessionId === session.id) return;
		this.activeSessionId = session.id;
		this.focusStackFrame(undefined);
		this.sessionEmitter.fire(session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
	}

	focusStackFrame(frame: IDebugStackFrame | undefined): void {
		if (frame && this.session?.state !== "stopped") { throw new Error("A stack frame requires the active paused session"); }
		if (this.currentFocusedStackFrame?.id === frame?.id && this.currentFocusedStackFrame?.instructionPointerReference === frame?.instructionPointerReference) { return; }
		this.currentFocusedStackFrame = frame;
		this.focusedFrameEmitter.fire(frame);
	}

	async restart(session: IDebugSession | undefined = this.session): Promise<IDebugSession> {
		if (!session) throw new Error("There is no active debug session to restart");
		if (!this.sessionRecords.has(session.id)) throw new Error("Debug session is no longer active");
		if (session.capabilities.supportsRestart) { await session.restart(); return session; }
		const configuration = session.configuration;
		await this.stop(session);
		return this.startDebugging(configuration);
	}

	async stop(session: IDebugSession | undefined = this.session): Promise<void> {
		if (!session) return;
		const record = this.sessionRecords.get(session.id);
		if (!record) return;
		await record.session.disconnect();
		await this.finishSession(record.session);
	}

	async stopAll(): Promise<void> {
		await Promise.allSettled(this.sessions.map(session => this.stop(session)));
	}

	toggleBreakpoint(resource: URI, lineNumber: number): void {
		if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) throw new RangeError("Breakpoint line number must be positive");
		const existing = this.currentBreakpoints.find(breakpoint => breakpoint.resource.toString() === resource.toString() && breakpoint.lineNumber === lineNumber);
		this.currentBreakpoints = existing ? Object.freeze(this.currentBreakpoints.filter(breakpoint => breakpoint !== existing)) : Object.freeze([...this.currentBreakpoints, createBreakpoint(resource, lineNumber, true)].sort(compareBreakpoints));
		this.breakpointStateChanged();
	}

	removeBreakpoint(id: string): void {
		this.currentBreakpoints = Object.freeze(this.currentBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentFunctionBreakpoints = Object.freeze(this.currentFunctionBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.breakpointStateChanged();
	}

	updateBreakpoint(id: string, update: IDebugBreakpointUpdate): void {
		const breakpoint = this.allBreakpoints().find(candidate => candidate.id === id);
		if (!breakpoint) throw new Error("Breakpoint is no longer present");
		const patch = { ...update };
		for (const field of ["condition", "hitCondition", "logMessage"] as const) {
			if (update[field] !== undefined) patch[field] = normalizeBreakpointExpression(update[field], field);
		}
		if (patch.name !== undefined) {
			if (!("kind" in breakpoint) || breakpoint.kind !== "function") throw new TypeError("Only function breakpoints have a name");
			patch.name = normalizePersistedString(patch.name, "name", 32_768);
		}
		if (patch.accessType !== undefined && (!("kind" in breakpoint) || breakpoint.kind !== "data" || !breakpoint.accessTypes.includes(patch.accessType))) throw new TypeError("Unsupported data breakpoint access type");
		if (patch.instructionReference !== undefined || patch.offset !== undefined) {
			if (!("kind" in breakpoint) || breakpoint.kind !== "instruction") throw new TypeError("Only instruction breakpoints have an instruction reference or offset");
			if (patch.instructionReference !== undefined) patch.instructionReference = normalizeBreakpointReference(patch.instructionReference, "instructionReference");
			if (patch.offset !== undefined && !Number.isSafeInteger(patch.offset)) throw new TypeError("Instruction offset must be an integer");
		}
		if (update.logMessage !== undefined && !("resource" in breakpoint)) throw new TypeError("Log messages require a source breakpoint");
		const change = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => point.id === id ? Object.freeze({ ...point, ...patch, verified: false, message: undefined }) : point));
		this.currentBreakpoints = change(this.currentBreakpoints);
		this.currentFunctionBreakpoints = change(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = change(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = change(this.currentInstructionBreakpoints);
		this.breakpointStateChanged();
	}

	setBreakpointsEnabled(enabled: boolean): void {
		const change = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => Object.freeze({ ...point, enabled, verified: false, message: undefined })));
		this.currentBreakpoints = change(this.currentBreakpoints);
		this.currentFunctionBreakpoints = change(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = change(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = change(this.currentInstructionBreakpoints);
		this.breakpointStateChanged();
	}

	removeAllBreakpoints(): void {
		this.currentBreakpoints = Object.freeze([]);
		this.currentFunctionBreakpoints = Object.freeze([]);
		this.currentDataBreakpoints = Object.freeze([]);
		this.currentInstructionBreakpoints = Object.freeze([]);
		this.breakpointStateChanged();
	}

	private breakpointStateChanged(): void {
		this.breakpointsEmitter.fire(this.allBreakpoints());
		this.persistState();
		for (const session of this.sessions) void (session as DebugAdapterSession).syncBreakpoints().catch(error => this.reportError(error));
	}

	addFunctionBreakpoint(options: IFunctionBreakpointOptions): void {
		const name = normalizePersistedString(options.name, "name", 32_768);
		this.currentFunctionBreakpoints = Object.freeze([...this.currentFunctionBreakpoints, Object.freeze({ kind: "function" as const, id: generateUuid(), name, enabled: true, verified: false, ...breakpointConditions(options) })]);
		this.breakpointStateChanged();
	}

	addDataBreakpoint(options: IDataBreakpointOptions): void {
		const session = this.session;
		if (!session || session.id !== options.sessionId || session.state !== "stopped") throw new Error(localize("debug.dataRequiresPause", "Data breakpoints require the paused session that identified the variable."));
		if (!session.capabilities.supportsDataBreakpoints) throw new Error(localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints"));
		if (!options.accessTypes.includes(options.accessType)) throw new TypeError("Unsupported data breakpoint access type");
		const dataId = normalizeBreakpointReference(options.dataId, "dataId");
		this.currentDataBreakpoints = Object.freeze([...this.currentDataBreakpoints, Object.freeze({
			...options,
			dataId,
			accessTypes: Object.freeze([...options.accessTypes]),
			id: generateUuid(),
			kind: "data" as const,
			enabled: true,
			verified: false,
			adapterType: session.configuration.type,
			...breakpointConditions(options),
		})]);
		this.breakpointStateChanged();
	}

	addInstructionBreakpoint(options: IInstructionBreakpointOptions): void {
		const session = this.session;
		if (!session || session.state !== "stopped") throw new Error(localize("debug.instructionRequiresPause", "Instruction breakpoints require a paused debug session."));
		if (!session.capabilities.supportsInstructionBreakpoints) throw new Error(localize("debug.unsupportedInstructionBreakpoints", "Debug Adapter does not support instruction breakpoints"));
		if (options.offset !== undefined && !Number.isSafeInteger(options.offset)) throw new TypeError("Instruction offset must be an integer");
		const instructionReference = normalizeBreakpointReference(options.instructionReference, "instructionReference");
		this.currentInstructionBreakpoints = Object.freeze([...this.currentInstructionBreakpoints, Object.freeze({ ...options, instructionReference, id: generateUuid(), kind: "instruction" as const, enabled: true, verified: false, sessionId: session.id, ...breakpointConditions(options) })]);
		this.breakpointStateChanged();
	}

	private allBreakpoints(): readonly DebugBreakpoint[] {
		return Object.freeze([...this.currentBreakpoints, ...this.currentFunctionBreakpoints, ...this.currentDataBreakpoints, ...this.currentInstructionBreakpoints]);
	}

	addWatchExpression(expression: string): void {
		const normalized = normalizeExpression(expression);
		if (this.currentWatchExpressions.includes(normalized)) return;
		this.currentWatchExpressions = Object.freeze([...this.currentWatchExpressions, normalized]);
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.persistState();
	}

	removeWatchExpression(expression: string): void {
		const next = this.currentWatchExpressions.filter(candidate => candidate !== expression);
		if (next.length === this.currentWatchExpressions.length) return;
		this.currentWatchExpressions = Object.freeze(next);
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.persistState();
	}

	async setExceptionBreakpoints(filters: readonly string[]): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("Exception breakpoints require an active debug session");
		await session.setExceptionBreakpoints(filters);
		this.exceptionBreakpointsByType = Object.freeze({ ...this.exceptionBreakpointsByType, [session.configuration.type]: Object.freeze([...new Set(filters)]) });
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		this.persistState();
	}

	private setLaunchDocument(configurations: readonly IDebugConfiguration[], compounds: readonly IDebugCompound[]): void {
		if (JSON.stringify(configurations) === JSON.stringify(this.currentConfigurations) && JSON.stringify(compounds) === JSON.stringify(this.currentCompounds)) return;
		this.currentConfigurations = configurations;
		this.currentCompounds = compounds;
		this.configurationsEmitter.fire(configurations);
	}

	private acceptBreakpointUpdates(updates: readonly { readonly id: string; readonly verified: boolean; readonly message?: string }[]): void {
		if (updates.length === 0) return;
		const byId = new Map(updates.map(update => [update.id, update]));
		this.currentBreakpoints = Object.freeze(this.currentBreakpoints.map(breakpoint => {
			const update = byId.get(breakpoint.id);
			return update ? Object.freeze({ ...breakpoint, verified: update.verified, message: update.message }) : breakpoint;
		}));
		const accept = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => {
			const update = byId.get(point.id);
			return update ? Object.freeze({ ...point, verified: update.verified, message: update.message }) : point;
		}));
		this.currentFunctionBreakpoints = accept(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = accept(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = accept(this.currentInstructionBreakpoints);
		this.breakpointsEmitter.fire(this.allBreakpoints());
	}

	private async finishSession(session: DebugAdapterSession): Promise<void> {
		const record = this.sessionRecords.get(session.id);
		if (!record) return;
		record.listener.dispose();
		this.sessionRecords.delete(session.id);
		this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(point => point.canPersist || point.sessionId !== session.id));
		this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(point => point.sessionId !== session.id));
		this.breakpointsEmitter.fire(this.allBreakpoints());
		session.dispose();
		if (this.activeSessionId === session.id) {
			this.activeSessionId = this.sessions.at(-1)?.id;
			this.focusStackFrame(undefined);
		}
		this.sessionEmitter.fire(this.session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		if (this.completedPostTasks.has(session.id)) return;
		this.completedPostTasks.add(session.id);
		try { await this.runTask(session.configuration.postDebugTask, "postDebugTask", session.configuration.dirId); }
		catch (error) { this.reportError(error); }
	}

	private async runTask(reference: string | undefined, role: string, dirId?: string): Promise<void> {
		if (!reference) return;
		await this.tasks.refresh();
		const matches = this.tasks.tasks.filter(task =>
			(task.id === reference || task.label === reference)
			&& (dirId === undefined || task.dirId === undefined || task.dirId === dirId),
		);
		if (matches.length === 0) throw new Error(`Debug ${role} '${reference}' was not found`);
		if (matches.length > 1) throw new Error(`Debug ${role} '${reference}' is ambiguous`);
		const run = await this.tasks.run(matches[0]!);
		const status = await waitForTask(run);
		if (status !== "succeeded") throw new Error(`Debug ${role} '${reference}' ${status}${run.exitCode === undefined ? "" : ` with exit code ${run.exitCode}`}`);
	}

	private exceptionBreakpointsForType(type: string | undefined): readonly string[] {
		return type ? this.exceptionBreakpointsByType[type] ?? Object.freeze([]) : Object.freeze([]);
	}

	private restoreState(state: Readonly<PersistedDebugState>): void {
		this.currentBreakpoints = Object.freeze(state.breakpoints.map(value => Object.freeze({ ...createBreakpoint(URI.parse(value.resource), value.lineNumber, value.enabled), ...breakpointExpressions(value) })).sort(compareBreakpoints));
		this.currentFunctionBreakpoints = Object.freeze(state.functionBreakpoints.map(point => Object.freeze({ ...point, verified: false })));
		this.currentDataBreakpoints = Object.freeze(state.dataBreakpoints.map(point => Object.freeze({ ...point, verified: false })));
		this.currentInstructionBreakpoints = Object.freeze([]);
		this.currentWatchExpressions = Object.freeze([...state.watchExpressions]);
		this.exceptionBreakpointsByType = Object.freeze(Object.fromEntries(Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, Object.freeze([...filters])])));
		this.breakpointsEmitter.fire(this.allBreakpoints());
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
	}

	private persistState(): void {
		this.stateMemento.update({ version: 2, breakpoints: Object.freeze(this.currentBreakpoints.map(breakpoint => Object.freeze({ resource: breakpoint.resource.toString(), lineNumber: breakpoint.lineNumber, enabled: breakpoint.enabled, ...breakpointExpressions(breakpoint) }))), functionBreakpoints: this.currentFunctionBreakpoints, dataBreakpoints: Object.freeze(this.currentDataBreakpoints.filter(point => point.canPersist)), watchExpressions: this.currentWatchExpressions, exceptionBreakpoints: this.exceptionBreakpointsByType });
	}

	private reportError(error: unknown): void {
		this.logService.error("debug.service", "Debug service operation failed", error);
	}
}

function childResource(root: URI, relativePath: string): URI { return URI.joinPath(root, ...relativePath.split("/")); }
function createBreakpoint(resource: URI, lineNumber: number, enabled: boolean): IDebugBreakpoint { return Object.freeze({ id: `${resource.toString()}:${lineNumber}`, resource, lineNumber, enabled, verified: false }); }
function compareBreakpoints(left: IDebugBreakpoint, right: IDebugBreakpoint): number { return left.resource.toString().localeCompare(right.resource.toString()) || left.lineNumber - right.lineNumber; }
function normalizeBreakpointExpression(value: string, field: string): string | undefined {
	if (value.length > 32_768 || value.includes("\0")) throw new TypeError(`${field} must contain at most 32768 characters and no null characters`);
	return value.trim() ? value : undefined;
}
function breakpointExpressions(value: Pick<IDebugBreakpoint, "condition" | "hitCondition" | "logMessage">) {
	return {
		...(value.condition === undefined ? {} : { condition: value.condition }),
		...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
		...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
	};
}

function breakpointConditions(value: Pick<IBaseBreakpoint, "condition" | "hitCondition">): Pick<IBaseBreakpoint, "condition" | "hitCondition"> {
	return {
		condition: value.condition === undefined ? undefined : normalizeBreakpointExpression(value.condition, "condition"),
		hitCondition: value.hitCondition === undefined ? undefined : normalizeBreakpointExpression(value.hitCondition, "hitCondition"),
	};
}
function normalizeExpression(expression: string): string {
	const normalized = expression.trim();
	if (!normalized || normalized.length > 32_768 || normalized.includes("\0")) throw new TypeError("Watch expression must contain 1 to 32768 characters");
	return normalized;
}

function resolveCompoundConfiguration(reference: string, configurations: readonly IDebugConfiguration[], dirId?: string): IDebugConfiguration {
	const matches = configurations.filter(configuration =>
		(configuration.id === reference || configuration.name === reference)
		&& (dirId === undefined || configuration.dirId === dirId),
	);
	if (matches.length === 0) throw new Error(`Debug compound configuration '${reference}' was not found`);
	if (matches.length > 1) throw new Error(`Debug compound configuration '${reference}' is ambiguous`);
	return matches[0]!;
}

function waitForTask(run: ITaskRun): Promise<TaskRunStatus> {
	if (run.status !== "running") return Promise.resolve(run.status);
	return new Promise(resolve => {
		const listener = run.onDidChangeStatus(status => {
			if (status === "running") return;
			listener.dispose();
			resolve(status);
		});
	});
}

function parsePersistedDebugState(value: unknown): PersistedDebugState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Debug workspace state must be an object");
	const input = value as Record<string, unknown>;
	if (input.version !== 1 && input.version !== 2) throw new TypeError("Debug workspace state version is unsupported");
	if (!Array.isArray(input.breakpoints) || !Array.isArray(input.watchExpressions) || !input.exceptionBreakpoints || typeof input.exceptionBreakpoints !== "object" || Array.isArray(input.exceptionBreakpoints)) throw new TypeError("Debug workspace state is malformed");
	const breakpoints = Object.freeze(input.breakpoints.map((candidate, index) => parsePersistedBreakpoint(candidate, index)));
	const watchExpressions = Object.freeze(input.watchExpressions.map((candidate, index) => normalizePersistedString(candidate, `watchExpressions[${index}]`, 32_768)));
	const exceptionBreakpoints = Object.freeze(Object.fromEntries(Object.entries(input.exceptionBreakpoints as Record<string, unknown>).map(([type, filters]) => {
		if (!type || type.length > 128 || !Array.isArray(filters)) throw new TypeError("Debug exception breakpoint state is malformed");
		return [type, Object.freeze(filters.map((filter, index) => normalizePersistedString(filter, `exceptionBreakpoints.${type}[${index}]`, 256)))];
	})));
	// Version 1 only stored source breakpoints. Write all subsequent saves as
	// version 2; session-bound instruction and data identifiers never enter storage.
	let functionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	let dataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	if (input.version === 2) {
		if (!Array.isArray(input.functionBreakpoints) || !Array.isArray(input.dataBreakpoints)) throw new TypeError("Debug breakpoint state is malformed");
		functionBreakpoints = Object.freeze(input.functionBreakpoints.map(parsePersistedFunctionBreakpoint));
		dataBreakpoints = Object.freeze(input.dataBreakpoints.map(parsePersistedDataBreakpoint));
	}
	return Object.freeze({ version: 2, breakpoints, functionBreakpoints, dataBreakpoints, watchExpressions, exceptionBreakpoints });
}

function parsePersistedFunctionBreakpoint(value: unknown): IFunctionBreakpoint {
	const point = parsePersistedBreakpointState(value);
	return Object.freeze({ ...point.state, kind: "function", name: normalizePersistedString(point.input.name, "function breakpoint name", 32_768) });
}

function parsePersistedDataBreakpoint(value: unknown): IDataBreakpoint {
	const point = parsePersistedBreakpointState(value);
	const input = point.input;
	if (typeof input.description !== "string") throw new TypeError("Data breakpoint description must be a string");
	if (input.canPersist !== true || !Array.isArray(input.accessTypes) || !input.accessTypes.every(type => type === "read" || type === "write" || type === "readWrite") || !input.accessTypes.includes(input.accessType)) throw new TypeError("Persistent data breakpoint is malformed");
	return Object.freeze({
		...point.state,
		kind: "data",
		dataId: normalizeBreakpointReference(input.dataId, "dataId"),
		description: input.description,
		adapterType: normalizePersistedString(input.adapterType, "adapterType", 256),
		canPersist: true,
		accessTypes: Object.freeze(input.accessTypes as IDataBreakpoint["accessTypes"]),
		accessType: input.accessType as IDataBreakpoint["accessType"],
	});
}

function parsePersistedBreakpointState(value: unknown): { input: Record<string, unknown>; state: IBaseBreakpoint } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Breakpoint state must be an object");
	const input = value as Record<string, unknown>;
	if (typeof input.enabled !== "boolean") throw new TypeError("Breakpoint enabled state must be a boolean");
	const expressions: { condition?: string; hitCondition?: string } = {};
	for (const field of ["condition", "hitCondition"] as const) {
		if (input[field] === undefined) continue;
		if (typeof input[field] !== "string") throw new TypeError(`${field} must be a string`);
		expressions[field] = normalizeBreakpointExpression(input[field], field);
	}
	return { input, state: { id: normalizePersistedString(input.id, "id", 256), enabled: input.enabled, verified: false, ...expressions } };
}

function parsePersistedBreakpoint(value: unknown, index: number): PersistedBreakpoint {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`breakpoints[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const resource = normalizePersistedString(input.resource, `breakpoints[${index}].resource`, 16_384);
	URI.parse(resource);
	if (!Number.isSafeInteger(input.lineNumber) || (input.lineNumber as number) <= 0 || typeof input.enabled !== "boolean") throw new TypeError(`breakpoints[${index}] is malformed`);
	const expressions: { condition?: string; hitCondition?: string; logMessage?: string } = {};
	for (const field of ["condition", "hitCondition", "logMessage"] as const) {
		if (input[field] === undefined) continue;
		if (typeof input[field] !== "string") throw new TypeError(`breakpoints[${index}].${field} must be a string`);
		expressions[field] = normalizeBreakpointExpression(input[field], field);
	}
	return Object.freeze({ resource, lineNumber: input.lineNumber as number, enabled: input.enabled, ...breakpointExpressions(expressions) });
}

function normalizePersistedString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new TypeError(`${path} must contain 1 to ${maximum} characters`);
	return value.trim();
}

function serializePersistedDebugState(state: PersistedDebugState): JsonValue {
	const conditions = (point: IBaseBreakpoint): Record<string, JsonValue> => ({
		id: point.id,
		enabled: point.enabled,
		...(point.condition === undefined ? {} : { condition: point.condition }),
		...(point.hitCondition === undefined ? {} : { hitCondition: point.hitCondition }),
	});
	return {
		version: state.version,
		breakpoints: state.breakpoints.map(breakpoint => ({ resource: breakpoint.resource, lineNumber: breakpoint.lineNumber, enabled: breakpoint.enabled, ...breakpointExpressions(breakpoint) })),
		functionBreakpoints: state.functionBreakpoints.map(point => ({ ...conditions(point), name: point.name })),
		dataBreakpoints: state.dataBreakpoints.map(point => ({ ...conditions(point), dataId: point.dataId, description: point.description, adapterType: point.adapterType, canPersist: true, accessType: point.accessType, accessTypes: [...point.accessTypes] })),
		watchExpressions: state.watchExpressions,
		exceptionBreakpoints: Object.fromEntries(Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, filters])),
	};
}

function normalizeBreakpointReference(value: unknown, field: string): string {
	// DAP references are opaque adapter identifiers; whitespace is part of their identity.
	if (typeof value !== "string" || !value.trim() || value.length > 32_768 || value.includes("\0")) throw new TypeError(`${field} must contain 1 to 32768 characters`);
	return value;
}


interface RunInTerminalArguments {
	readonly kind: "integrated" | "external";
	readonly title: string | undefined;
	readonly cwd: string | undefined;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string | null>>;
	readonly argsCanBeInterpretedByShell: boolean;
}

/** Launches a DAP-requested debuggee through the existing integrated terminal boundary. */
async function runDebuggeeInTerminal(terminalService: ITerminalService, value: unknown, dirId?: string): Promise<Readonly<{ shellProcessId: number }>> {
	const request = parseRunInTerminalArguments(value);
	if (request.kind === "external") throw new Error("External debug terminals are not supported; use an integrated terminal");
	const profiles = await terminalService.getProfiles();
	const profile = preferredProfile(profiles);
	const terminal = await terminalService.createTerminal({ dirId, dimensions: { rows: 30, cols: 120 }, profile: { type: "profile", profileId: profile.profileId }, title: request.title ?? "Debug" });
	if (terminal.state !== 'running') {
		await terminalService.closeTerminal(terminal);
		throw new Error(localize('debug.terminalUnavailable', 'The terminal is unavailable. The debug command was not sent. Restart debugging.'));
	}
	terminal.write(`${terminalCommand(request, profile)}\r`);
	return Object.freeze({ shellProcessId: terminal.processId });
}

function parseRunInTerminalArguments(value: unknown): RunInTerminalArguments {
	const input = record(value, "runInTerminal arguments");
	const kind = input.kind === undefined ? "integrated" : input.kind;
	if (kind !== "integrated" && kind !== "external") throw new TypeError("runInTerminal kind must be 'integrated' or 'external'");
	const args = stringArray(input.args, "runInTerminal args", 256, 4096);
	if (args.length === 0) throw new TypeError("runInTerminal args must contain the executable");
	const env = input.env === undefined ? {} : environment(input.env);
	return Object.freeze({ kind, title: optionalString(input.title, "runInTerminal title", 256), cwd: optionalString(input.cwd, "runInTerminal cwd", 4096), args, env, argsCanBeInterpretedByShell: input.argsCanBeInterpretedByShell === true });
}

function terminalCommand(request: RunInTerminalArguments, profile: ITerminalProfile): string {
	const shell = shellKind(profile.profileId);
	const command = request.argsCanBeInterpretedByShell ? request.args.join(" ") : request.args.map(argument => quote(argument, shell)).join(" ");
	const prefix = shell === "powershell" ? powershellPrefix(request) : shell === "cmd" ? cmdPrefix(request) : posixPrefix(request);
	return prefix ? `${prefix}${command}` : command;
}

function powershellPrefix(request: RunInTerminalArguments): string {
	const parts = Object.entries(request.env).map(([key, value]) => value === null ? `Remove-Item -LiteralPath ${quote(`Env:${key}`, "powershell")} -ErrorAction SilentlyContinue` : `$env:${key}=${quote(value, "powershell")}`);
	if (request.cwd) parts.push(`Set-Location -LiteralPath ${quote(request.cwd, "powershell")}`);
	return parts.length > 0 ? `${parts.join("; ")}; & ` : "& ";
}

function cmdPrefix(request: RunInTerminalArguments): string {
	const parts = Object.entries(request.env).map(([key, value]) => `set "${key}=${value === null ? "" : escapeCmdEnvironmentValue(value)}"`);
	if (request.cwd) parts.push(`cd /d ${quote(request.cwd, "cmd")}`);
	return parts.length > 0 ? `${parts.join(" && ")} && ` : "";
}

function posixPrefix(request: RunInTerminalArguments): string {
	const environmentArguments = Object.entries(request.env).flatMap(([key, value]) => value === null ? ["-u", key] : [`${key}=${value}`]);
	const environmentPrefix = environmentArguments.length > 0 ? `env ${environmentArguments.map(value => quote(value, "posix")).join(" ")} ` : "";
	const directoryPrefix = request.cwd ? `cd -- ${quote(request.cwd, "posix")} && ` : "";
	return `${directoryPrefix}${environmentPrefix}`;
}

function quote(value: string, shell: "powershell" | "cmd" | "posix"): string {
	if (shell === "powershell") return `'${value.replaceAll("'", "''")}'`;
	if (shell === "cmd") {
		if (/[\r\n]/.test(value)) throw new TypeError("cmd debug terminal arguments cannot contain line breaks");
		return `"${value.replaceAll("%", "%%").replaceAll("\"", "\\\"")}"`;
	}
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function preferredProfile(profiles: readonly ITerminalProfile[]): ITerminalProfile {
	const profile = profiles.find(candidate => /^(?:powershell|pwsh)$/i.test(candidate.profileId)) ?? profiles.find(candidate => candidate.isDefault) ?? profiles[0];
	if (!profile) throw new Error("No terminal profile is available for the debuggee");
	return profile;
}

function shellKind(profileId: string): "powershell" | "cmd" | "posix" {
	if (/^(?:powershell|pwsh)$/i.test(profileId)) return "powershell";
	if (/^(?:cmd|command-prompt)$/i.test(profileId)) return "cmd";
	return "posix";
}

function environment(value: unknown): Readonly<Record<string, string | null>> {
	const input = record(value, "runInTerminal env");
	if (Object.keys(input).length > 256) throw new RangeError("runInTerminal env cannot contain more than 256 entries");
	return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, item]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new TypeError(`runInTerminal env key '${key}' is invalid`);
		if (item !== null && (typeof item !== "string" || item.length > 32_768 || item.includes("\0"))) throw new TypeError(`runInTerminal env '${key}' must be a bounded string or null`);
		return [key, item as string | null];
	})));
}

function stringArray(value: unknown, path: string, maximumItems: number, maximumLength: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${path} must be an array with at most ${maximumItems} items`);
	return Object.freeze(value.map((item, index) => {
		if (typeof item !== "string" || item.length > maximumLength || item.includes("\0")) throw new TypeError(`${path}[${index}] must be a bounded string`);
		return item;
	}));
}

function optionalString(value: unknown, path: string, maximumLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) throw new TypeError(`${path} must be a bounded string`);
	return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function escapeCmdEnvironmentValue(value: string): string { if (/[\r\n]/.test(value)) throw new TypeError("cmd debug terminal environment values cannot contain line breaks"); return value.replaceAll("%", "%%").replaceAll("\"", "\"\""); }

registerWorkbenchServiceContribution({
	service: IDebugAdapterFactorySource,
	dependencies: [],
	install: () => DebugAdapterFactoriesRegistry,
});

registerWorkbenchServiceContribution({
	service: IDebugService,
	dependencies: [IFileService, IWorkspaceContextService, IDebugAdapterProcessService, ITerminalService, IStorageService, ITaskService, IDebugAdapterFactorySource, ILogService],
	install: context => {
		const service = context.register(context.container.createInstance(DebugService));
		context.container.registerInstance(IDebugConsoleService, context.register(new DebugConsoleService(service)));
		return service;
	},
});
