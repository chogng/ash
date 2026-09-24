import { Emitter, type Event } from "../../../../base/common/event.js";
import { type JsonValue } from "../../../../base/common/jsonValue.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { type IDebugAdapterProcessService } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileNotFoundError, type IFileService } from "../../../../platform/files/common/files.js";
import type { ILogService } from "../../../../platform/log/common/log.js";
import { type IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { Memento } from "../../../common/memento.js";
import { type ITaskRun, type ITaskService, type TaskRunStatus } from "../../tasks/common/taskService.js";
import { type ITerminalService } from "../../terminal/common/terminal.js";
import { DebugAdapterSession } from "./debugAdapterSession.js";
import { runDebuggeeInTerminal } from "./debugTerminalLauncher.js";
import { DebugAdapterFactoriesRegistry, type DebugAdapterFactorySource } from "../common/debugAdapterFactory.js";
import { type IDebugBreakpoint, type IDebugCompound, type IDebugConfiguration, type IDebugService, type IDebugSession } from "../common/debugService.js";
import { parseLaunchConfigurationDocument } from "../common/launchConfiguration.js";

interface PersistedDebugState {
	readonly version: 1;
	readonly breakpoints: readonly PersistedBreakpoint[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: Readonly<Record<string, readonly string[]>>;
}

interface PersistedBreakpoint {
	readonly resource: string;
	readonly lineNumber: number;
	readonly enabled: boolean;
}

interface DebugSessionRecord {
	readonly session: DebugAdapterSession;
	readonly listener: IDisposable;
}

const EMPTY_STATE: PersistedDebugState = Object.freeze({ version: 1, breakpoints: Object.freeze([]), watchExpressions: Object.freeze([]), exceptionBreakpoints: Object.freeze({}) });

/** Workspace Debug composition over generic DAP processes. */
export class DebugService extends Disposable implements IDebugService {
	private readonly configurationsEmitter = this._register(new Emitter<readonly IDebugConfiguration[]>());
	private readonly breakpointsEmitter = this._register(new Emitter<readonly IDebugBreakpoint[]>());
	private readonly watchExpressionsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionBreakpointsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	private readonly stateMemento: Memento<PersistedDebugState>;
	private readonly sessionRecords = new Map<string, DebugSessionRecord>();
	private readonly completedPostTasks = new Set<string>();
	private currentConfigurations: readonly IDebugConfiguration[] = Object.freeze([]);
	private currentCompounds: readonly IDebugCompound[] = Object.freeze([]);
	private currentBreakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	private currentWatchExpressions: readonly string[] = Object.freeze([]);
	private exceptionBreakpointsByType: Readonly<Record<string, readonly string[]>> = Object.freeze({});
	private activeSessionId: string | undefined;
	private refreshGeneration = 0;

	readonly onDidChangeConfigurations: Event<readonly IDebugConfiguration[]> = this.configurationsEmitter.event;
	readonly onDidChangeBreakpoints: Event<readonly IDebugBreakpoint[]> = this.breakpointsEmitter.event;
	readonly onDidChangeWatchExpressions: Event<readonly string[]> = this.watchExpressionsEmitter.event;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]> = this.exceptionBreakpointsEmitter.event;
	readonly onDidChangeSession: Event<IDebugSession | undefined> = this.sessionEmitter.event;

	constructor(private readonly files: IFileService, private readonly workspace: IWorkspaceContextService, private readonly processes: IDebugAdapterProcessService | undefined, private readonly terminals: ITerminalService, storage: IStorageService, private readonly tasks: ITaskService, private readonly adapters: DebugAdapterFactorySource = DebugAdapterFactoriesRegistry, private readonly logService?: ILogService) {
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
		const root = current.dirId
			? this.workspace.getWorkspace().folders.find(folder => folder.id === current.dirId)?.uri
			: this.workspace.getWorkspace().folders[0]?.uri;
		if (!root) throw new Error("Debugging requires an open workspace folder");
		await this.runTask(current.preLaunchTask, "preLaunchTask", current.dirId);
		const session = await DebugAdapterSession.start({ configuration: current, processService: this.processes, breakpoints: () => this.currentBreakpoints, workspace: root, runInTerminal: value => runDebuggeeInTerminal(this.terminals, value, current.dirId), updateBreakpoints: updates => this.acceptBreakpointUpdates(updates), exceptionBreakpoints: () => this.exceptionBreakpointsForType(current.type) });
		const listener = session.onDidChangeState(state => {
			if (this.sessionRecords.has(session.id)) this.sessionEmitter.fire(this.session);
			if (state === "terminated" || state === "error") queueMicrotask(() => { void this.finishSession(session); });
		});
		this.sessionRecords.set(session.id, { session, listener });
		this.activeSessionId = session.id;
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
		this.sessionEmitter.fire(session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
	}

	async restart(session: IDebugSession | undefined = this.session): Promise<IDebugSession> {
		if (!session) throw new Error("There is no active debug session to restart");
		if (!this.sessionRecords.has(session.id)) throw new Error("Debug session is no longer active");
		if (session.capabilities.supportsRestart) { await session.restart(); return session; }
		const configuration = session.configuration;
		await this.stop(session);
		return this.start(configuration);
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
		this.breakpointsEmitter.fire(this.currentBreakpoints);
		this.persistState();
		for (const session of this.sessions) void (session as DebugAdapterSession).syncBreakpoints().catch(error => this.reportError(error));
	}

	removeBreakpoint(id: string): void {
		const next = this.currentBreakpoints.filter(breakpoint => breakpoint.id !== id);
		if (next.length === this.currentBreakpoints.length) return;
		this.currentBreakpoints = Object.freeze(next);
		this.breakpointsEmitter.fire(this.currentBreakpoints);
		this.persistState();
		for (const session of this.sessions) void (session as DebugAdapterSession).syncBreakpoints().catch(error => this.reportError(error));
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
			return update ? Object.freeze({ ...breakpoint, verified: update.verified, ...(update.message === undefined ? {} : { message: update.message }) }) : breakpoint;
		}));
		this.breakpointsEmitter.fire(this.currentBreakpoints);
	}

	private async finishSession(session: DebugAdapterSession): Promise<void> {
		const record = this.sessionRecords.get(session.id);
		if (!record) return;
		record.listener.dispose();
		this.sessionRecords.delete(session.id);
		session.dispose();
		if (this.activeSessionId === session.id) this.activeSessionId = this.sessions.at(-1)?.id;
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
		this.currentBreakpoints = Object.freeze(state.breakpoints.map(value => createBreakpoint(URI.parse(value.resource), value.lineNumber, value.enabled)).sort(compareBreakpoints));
		this.currentWatchExpressions = Object.freeze([...state.watchExpressions]);
		this.exceptionBreakpointsByType = Object.freeze(Object.fromEntries(Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, Object.freeze([...filters])])));
		this.breakpointsEmitter.fire(this.currentBreakpoints);
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
	}

	private persistState(): void {
		this.stateMemento.update({ version: 1, breakpoints: Object.freeze(this.currentBreakpoints.map(breakpoint => Object.freeze({ resource: breakpoint.resource.toString(), lineNumber: breakpoint.lineNumber, enabled: breakpoint.enabled }))), watchExpressions: this.currentWatchExpressions, exceptionBreakpoints: this.exceptionBreakpointsByType });
	}

	private reportError(error: unknown): void {
		this.logService?.error("debug.service", "Debug service operation failed", error);
	}
}

function childResource(root: URI, relativePath: string): URI { const base = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path; return root.withPath(`${base}/${relativePath.split("/").map(encodeURIComponent).join("/")}`); }
function createBreakpoint(resource: URI, lineNumber: number, enabled: boolean): IDebugBreakpoint { return Object.freeze({ id: `${resource.toString()}:${lineNumber}`, resource, lineNumber, enabled, verified: false }); }
function compareBreakpoints(left: IDebugBreakpoint, right: IDebugBreakpoint): number { return left.resource.toString().localeCompare(right.resource.toString()) || left.lineNumber - right.lineNumber; }
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
	if (input.version !== 1) throw new TypeError("Debug workspace state version is unsupported");
	if (!Array.isArray(input.breakpoints) || !Array.isArray(input.watchExpressions) || !input.exceptionBreakpoints || typeof input.exceptionBreakpoints !== "object" || Array.isArray(input.exceptionBreakpoints)) throw new TypeError("Debug workspace state is malformed");
	const breakpoints = Object.freeze(input.breakpoints.map((candidate, index) => parsePersistedBreakpoint(candidate, index)));
	const watchExpressions = Object.freeze(input.watchExpressions.map((candidate, index) => normalizePersistedString(candidate, `watchExpressions[${index}]`, 32_768)));
	const exceptionBreakpoints = Object.freeze(Object.fromEntries(Object.entries(input.exceptionBreakpoints as Record<string, unknown>).map(([type, filters]) => {
		if (!type || type.length > 128 || !Array.isArray(filters)) throw new TypeError("Debug exception breakpoint state is malformed");
		return [type, Object.freeze(filters.map((filter, index) => normalizePersistedString(filter, `exceptionBreakpoints.${type}[${index}]`, 256)))];
	})));
	return Object.freeze({ version: 1, breakpoints, watchExpressions, exceptionBreakpoints });
}

function parsePersistedBreakpoint(value: unknown, index: number): PersistedBreakpoint {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`breakpoints[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const resource = normalizePersistedString(input.resource, `breakpoints[${index}].resource`, 16_384);
	URI.parse(resource);
	if (!Number.isSafeInteger(input.lineNumber) || (input.lineNumber as number) <= 0 || typeof input.enabled !== "boolean") throw new TypeError(`breakpoints[${index}] is malformed`);
	return Object.freeze({ resource, lineNumber: input.lineNumber as number, enabled: input.enabled });
}

function normalizePersistedString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new TypeError(`${path} must contain 1 to ${maximum} characters`);
	return value.trim();
}

function serializePersistedDebugState(state: PersistedDebugState): JsonValue {
	return { version: state.version, breakpoints: state.breakpoints.map(breakpoint => ({ resource: breakpoint.resource, lineNumber: breakpoint.lineNumber, enabled: breakpoint.enabled })), watchExpressions: state.watchExpressions, exceptionBreakpoints: Object.fromEntries(Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, filters])) };
}
