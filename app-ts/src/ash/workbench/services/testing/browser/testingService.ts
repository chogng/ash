import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { type ITaskRun, ITaskService } from "../../tasks/common/taskService.js";
import { type ITestCase, type ITestCaseResult, type ITestProfile, type ITestRun, type ITestingService, type TestProfileContribution, type TestProfileProvider, type TestProfileProviderRegistration, type TestRunStatus } from "../common/testingService.js";
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ITestExecutionService, type TestDebugLaunch, type TestUpdate } from '../../../../platform/testing/common/testExecutionService.js';
import { IDebugService } from '../../debug/common/debugService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';

interface TestOperation {
	readonly id: string;
	readonly dirId: string;
	readonly kind: 'discovery' | 'run' | 'debug';
	readonly completion: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	sequence: number;
	start?: Promise<void>;
	accepted: boolean;
	abandoned: boolean;
	launch?: TestDebugLaunch;
}

interface OwnedTestProfileProvider {
	readonly owner: object;
	readonly provider: TestProfileProvider;
}

/** Owns workspace test catalogs and runs; script profiles retain their task lifecycle. */
export class TestingService extends Disposable implements ITestingService {
	private readonly testsEmitter = this._register(new Emitter<void>());
	private currentTests: readonly ITestCase[] = [];
	private readonly caseResults = new Map<string, ITestCaseResult>();
	private readonly operations = new Map<string, TestOperation>();
	private readonly catalogs = new Map<string, string>();
	private discovery: Promise<void> | undefined;
	private discoveryController: AbortController | undefined;
	private workspaceGeneration = 0;
	private runController: AbortController | undefined;
	private debugConfigurationId: string | undefined;
	private get debugSession() { return this.debug.sessions.find(session => session.configuration.id === this.debugConfigurationId && session.state !== 'terminated' && session.state !== 'error'); }
	readonly onDidChangeTests = this.testsEmitter.event;
	private readonly profilesEmitter = this._register(new Emitter<readonly ITestProfile[]>());
	private readonly startRunEmitter = this._register(new Emitter<ITestRun>());
	private readonly changeRunEmitter = this._register(new Emitter<ITestRun>());
	private readonly providers = new Map<string, OwnedTestProfileProvider>();
	private currentProfiles: readonly ITestProfile[] = Object.freeze([]);
	private providerProfiles: readonly ITestProfile[] = Object.freeze([]);
	private currentRuns: TestRun[] = [];
	private activeProviderRefresh: AbortController | undefined;
	private providerRefreshGeneration = 0;
	private refreshingTasks = 0;
	private loaded = false;

	readonly onDidChangeProfiles: Event<readonly ITestProfile[]> = this.profilesEmitter.event;
	readonly onDidStartRun: Event<ITestRun> = this.startRunEmitter.event;
	readonly onDidChangeRun: Event<ITestRun> = this.changeRunEmitter.event;

	constructor(@ITaskService private readonly taskService: ITaskService, @ITestExecutionService private readonly execution: ITestExecutionService, @IWorkspaceContextService private readonly workspace: IWorkspaceContextService, @IWorkingCopyService private readonly workingCopies: IWorkingCopyService, @ILogService private readonly logService: ILogService, @IDebugService private readonly debug: IDebugService) {
		super();
		this._register(debug.onDidChangeSession(() => this.testsEmitter.fire()));
		this._register(execution.onDidUpdate(update => this.acceptUpdate(update)));
		this._register(execution.onDidDisconnect(() => {
			const error = new Error(localize('testing.disconnected', 'The test connection closed. Refresh tests to reconnect.'));
			for (const operation of this.operations.values()) { operation.abandoned = true; operation.reject(error); }
			this.workspaceGeneration++;
			this.runController?.abort();
			this.debugConfigurationId = undefined;
			this.discovery = undefined;
			this.operations.clear();
			this.catalogs.clear();
			this.currentTests = [];
			for (const [key, result] of this.caseResults) {
				if (result.state === 'running') { this.caseResults.set(key, { ...result, state: 'errored', output: error.message }); }
			}
			this.testsEmitter.fire();
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			void this.releaseTestOperations().catch(error => this.reportError(error));
			this.debugConfigurationId = undefined;
			this.currentTests = [];
			this.caseResults.clear();
			this.testsEmitter.fire();
		}));
		this._register(toDisposable(() => {
			void this.releaseTestOperations().catch(error => this.reportError(error));
		}));
		this._register(taskService.onDidChangeTasks(() => {
			this.projectProfiles();
			if (this.loaded && this.refreshingTasks === 0 && !this.activeProviderRefresh) void this.refreshProviderProfiles().catch(error => this.reportError(error));
		}));
		this._register(toDisposable(() => {
			this.activeProviderRefresh?.abort();
			this.activeProviderRefresh = undefined;
			this.providers.clear();
			for (const run of this.currentRuns) run.dispose();
			this.currentRuns = [];
		}));
		this.projectProfiles();
	}

	get profiles(): readonly ITestProfile[] { return this.currentProfiles; }
	get runs(): readonly ITestRun[] { return this.currentRuns; }
	get tests(): readonly ITestCase[] { return this.currentTests; }
	get testResults(): readonly ITestCaseResult[] { return [...this.caseResults.values()]; }
	get isDiscovering(): boolean { return this.discovery !== undefined; }
	get isRunningTests(): boolean { return this.runController !== undefined || this.debugSession !== undefined; }
	get isDebuggingTest(): boolean { return this.debugSession !== undefined; }

	refreshTests(): Promise<void> {
		if (this.isRunningTests) { return Promise.reject(new Error(localize('testing.alreadyRunning', 'A test run is already active.'))); }
		return this.loadTests();
	}

	private loadTests(): Promise<void> {
		if (this.discovery) { return this.discovery; }
		this.assertNotDisposed();
		const controller = new AbortController();
		this.discoveryController = controller;
		const discovery = this.discoverTests(controller.signal).finally(() => {
			if (this.discovery === discovery) { this.discovery = undefined; this.discoveryController = undefined; }
			if (!this.isDisposed) { this.testsEmitter.fire(); }
		});
		this.discovery = discovery;
		this.testsEmitter.fire();
		return discovery;
	}

	async runTests(keys: readonly string[]): Promise<void> {
		this.assertNotDisposed();
		if (this.isRunningTests) { throw new Error(localize('testing.alreadyRunning', 'A test run is already active.')); }
		if (keys.length === 0) { return; }
		const selected = this.currentTests.filter(test => keys.includes(test.key));
		if (selected.length !== new Set(keys).size) { throw staleSelection(); }
		const controller = new AbortController();
		this.runController = controller;
		this.testsEmitter.fire();
		try {
			const directories = new Set(selected.map(test => test.dirId));
			const roots = this.workspace.getWorkspace().folders.filter(folder => directories.has(folder.id)).map(folder => folder.uri);
			for (const copy of this.workingCopies.getAll()) {
				if (controller.signal.aborted) { return; }
				if (copy.isDirty && roots.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, root))) {
					await copy.save(controller.signal);
				}
			}
			if (controller.signal.aborted) { return; }
			await this.loadTests();
			if (controller.signal.aborted) { return; }
			// Validate every folder before starting any process: a stale selection must
			// not leave a partially launched multi-folder run behind.
			const groups = [...directories].map(dirId => {
				const tests = this.currentTests.filter(test => test.dirId === dirId && keys.includes(test.key));
				const catalogId = this.catalogs.get(dirId);
				if (!catalogId || tests.length !== selected.filter(test => test.dirId === dirId).length) { throw staleSelection(); }
				return { dirId, tests, catalogId };
			});
			await settle(groups.map(async ({ dirId, tests, catalogId }) => {
				for (const test of tests) { this.caseResults.delete(test.key); }
				const operation = this.createOperation(dirId, 'run');
				try { await this.startOperation(operation, () => this.execution.run(operation.id, dirId, catalogId, tests.map(test => test.id))); }
				finally { await this.releaseOperation(operation); }
			}));
		} finally {
			if (this.runController === controller) { this.runController = undefined; }
			if (!this.isDisposed) { this.testsEmitter.fire(); }
		}
	}

	rerunFailedTests(): Promise<void> {
		return this.runTests(this.testResults.filter(result => result.state === 'failed' || result.state === 'errored').map(result => result.key));
	}

	async debugTest(key: string): Promise<void> {
		this.assertNotDisposed();
		if (this.isRunningTests) { throw new Error(localize('testing.alreadyRunning', 'A test run is already active.')); }
		const selected = this.currentTests.find(test => test.key === key && test.debuggable);
		if (!selected) { throw staleSelection(); }
		const controller = new AbortController();
		this.runController = controller;
		this.testsEmitter.fire();
		try {
			const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === selected.dirId)!;
			for (const copy of this.workingCopies.getAll()) {
				if (controller.signal.aborted) { return; }
				if (copy.isDirty && extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, folder.uri)) { await copy.save(controller.signal); }
			}
			if (controller.signal.aborted) { return; }
			await this.loadTests();
			if (controller.signal.aborted) { return; }
			const test = this.currentTests.find(test => test.key === key && test.debuggable);
			const catalogId = this.catalogs.get(selected.dirId);
			if (!test || !catalogId) { throw staleSelection(); }
			const operation = this.createOperation(test.dirId, 'debug');
			try {
				await this.startOperation(operation, () => this.execution.prepareDebug(operation.id, test.dirId, catalogId, test.id));
				if (controller.signal.aborted) { return; }
				if (!operation.launch) { throw new Error(localize('testing.missingLaunch', 'The backend did not prepare a test debugger launch.')); }
				const launch = operation.launch;
				// Keep the configuration identity across DAP restarts, which may replace the session.
				this.debugConfigurationId = operation.id;
				const session = await this.debug.startDebugging({
					id: operation.id, dirId: test.dirId, workspaceFolderName: folder.name,
					name: localize('testing.debugName', 'Debug {0}', test.name), type: 'lldb-dap', request: 'launch',
					adapter: { program: launch.adapterProgram, arguments: [] },
					arguments: { program: launch.program, args: [...launch.arguments], cwd: launch.directory, stopOnEntry: false },
				});
				if (controller.signal.aborted) { await this.debug.stop(session); return; }
			} finally { await this.releaseOperation(operation); }
		} finally {
			if (this.runController === controller) { this.runController = undefined; }
			if (!this.isDisposed) { this.testsEmitter.fire(); }
		}
	}

	async cancelTests(): Promise<void> {
		this.discoveryController?.abort();
		this.runController?.abort();
		if (this.debugSession) { await this.debug.stop(this.debugSession); }
		await settle([...this.operations.values()].map(async operation => {
			await operation.start?.catch(() => undefined);
			if (this.operations.get(operation.id) === operation && operation.accepted && !operation.abandoned) { await this.execution.cancel(operation.id); }
		}));
	}

	private async discoverTests(signal: AbortSignal): Promise<void> {
		const generation = this.workspaceGeneration;
		const oldCatalogs = [...this.catalogs.values()];
		this.catalogs.clear();
		await settle(oldCatalogs.map(id => this.execution.release(id)));
		if (signal.aborted || generation !== this.workspaceGeneration || this.isDisposed) { return; }
		await settle(this.workspace.getWorkspace().folders.map(async folder => {
			const operation = this.createOperation(folder.id, 'discovery');
			try {
				await this.startOperation(operation, () => this.execution.discover(operation.id, folder.id));
				// Workspace changes remove the operation before late responses arrive.
				if (this.operations.get(operation.id) !== operation) { return; }
				this.catalogs.set(folder.id, operation.id);
				this.operations.delete(operation.id);
			} catch (error) {
				await this.releaseOperation(operation);
				throw error;
			}
		}));
		const keys = new Set(this.currentTests.map(test => test.key));
		for (const key of this.caseResults.keys()) { if (!keys.has(key)) { this.caseResults.delete(key); } }
	}

	private createOperation(dirId: string, kind: TestOperation['kind']): TestOperation {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
		const operation: TestOperation = { id: generateUuid(), dirId, kind, completion, resolve, reject, sequence: 0, accepted: false, abandoned: false };
		this.operations.set(operation.id, operation);
		return operation;
	}

	private async startOperation(operation: TestOperation, start: () => Promise<void>): Promise<void> {
		// Observe completion before start: a final notification can precede its response.
		operation.start = Promise.resolve().then(start).then(() => { operation.accepted = true; });
		try { await Promise.all([operation.start, operation.completion]); }
		catch (error) { operation.resolve(); throw error; }
	}

	private async releaseOperation(operation: TestOperation): Promise<void> {
		this.operations.delete(operation.id);
		await operation.start?.catch(() => undefined);
		if (operation.accepted && !operation.abandoned) { await this.execution.release(operation.id); }
	}

	private acceptUpdate(update: TestUpdate): void {
		const operation = this.operations.get(update.operationId);
		if (!operation || update.sequence <= operation.sequence) { return; }
		operation.sequence = update.sequence;
		if (update.tests) {
			const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === operation.dirId);
			if (folder) {
				this.currentTests = [...this.currentTests.filter(test => test.dirId !== folder.id), ...update.tests.map(test => ({
					...test, key: folder.id + ':' + test.id, dirId: folder.id,
					resource: test.source ? URI.joinPath(folder.uri, test.source.path) : undefined,
				}))];
			}
		}
		if (update.result) {
			const key = operation.dirId + ':' + update.result.testId;
			this.caseResults.set(key, { ...update.result, key });
		}
		if (update.launch) { operation.launch = update.launch; }
		if (update.status === 'completed' || update.status === 'cancelled' && operation.kind === 'run') { operation.resolve(); }
		if (update.status === 'cancelled' && operation.kind !== 'run') { operation.reject(new Error(localize('testing.cancelled', 'Test operation cancelled.'))); }
		if (update.status === 'failed') { operation.reject(new Error(update.error ?? localize('testing.operationFailed', 'Test operation failed.'))); }
		this.testsEmitter.fire();
	}

	private async releaseTestOperations(): Promise<void> {
		this.workspaceGeneration++;
		this.discoveryController?.abort();
		this.runController?.abort();
		this.discovery = undefined;
		const ids = [...this.catalogs.values()];
		this.catalogs.clear();
		for (const operation of this.operations.values()) { operation.reject(new Error(localize('testing.cancelled', 'Test operation cancelled.'))); }
		this.operations.clear();
		// Each pending operation releases itself after its start response. Catalogs
		// have completed start responses and are released by this workspace owner.
		await settle(ids.map(id => this.execution.release(id)));
	}

	registerTestProfileProvider(provider: TestProfileProvider): IDisposable {
		return this.registerTestProfileProviders([provider]);
	}

	registerTestProfileProviders(providers: readonly TestProfileProvider[]): TestProfileProviderRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replaceProviders(owner, providers);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			const removed = this.deleteProviderOwner(owner);
			if (removed.length > 0) this.providersChanged(removed);
		}) as TestProfileProviderRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Test Profile provider registration is already disposed");
			this.assertNotDisposed();
			this.replaceProviders(owner, replacement);
		};
		return registration;
	}

	async refresh(): Promise<readonly ITestProfile[]> {
		await settle([this.refreshScriptProfiles(), this.refreshTests()]);
		return this.currentProfiles;
	}

	private async refreshScriptProfiles(): Promise<readonly ITestProfile[]> {
		this.assertNotDisposed();
		this.refreshingTasks += 1;
		try { await this.taskService.refresh(); }
		finally { this.refreshingTasks -= 1; }
		return this.refreshProviderProfiles();
	}

	async run(profile: ITestProfile): Promise<ITestRun> {
		const currentProfile = this.currentProfiles.find(candidate => candidate.id === profile.id);
		const task = currentProfile ? this.taskService.tasks.find(candidate => candidate.id === currentProfile.taskId && candidate.group === "test") : undefined;
		if (!task) throw new Error("Test profile is no longer present in the current workspace");
		const taskRun = await this.taskService.run(task);
		const run = this._register(new TestRun(currentProfile!, taskRun, current => this.changeRunEmitter.fire(current)));
		this.currentRuns = [...this.currentRuns, run].slice(-50);
		this.startRunEmitter.fire(run);
		return run;
	}

	async runAllScripts(): Promise<readonly ITestRun[]> {
		const profiles = await this.refreshScriptProfiles();
		const runs: ITestRun[] = [];
		for (const profile of profiles) runs.push(await this.run(profile));
		return runs;
	}

	rerun(run: ITestRun): Promise<ITestRun> {
		return this.run(run.profile);
	}

	cancel(run: ITestRun): Promise<void> {
		return this.taskService.terminate(run.taskRun);
	}

	private projectProfiles(): void {
		const tasks = new Map(this.taskService.tasks.filter(task => task.group === "test").map(task => [task.id, task]));
		const taskProfiles = [...tasks.values()].map(task => Object.freeze({ id: task.id, label: task.label, source: task.source, taskId: task.id, detail: task.detail ?? task.command }));
		const profiles = Object.freeze([...taskProfiles, ...this.providerProfiles.filter(profile => tasks.has(profile.taskId))]);
		if (JSON.stringify(profiles) === JSON.stringify(this.currentProfiles)) return;
		this.currentProfiles = profiles;
		this.profilesEmitter.fire(profiles);
	}

	private replaceProviders(owner: object, providers: readonly TestProfileProvider[]): void {
		if (!Array.isArray(providers)) throw new TypeError("Test Profile providers must be an array");
		const normalized = providers.map(normalizeTestProfileProvider);
		const ids = new Set<string>();
		for (const provider of normalized) {
			const existing = this.providers.get(provider.id);
			if (ids.has(provider.id) || existing && existing.owner !== owner) throw new Error(`Test Profile provider '${provider.id}' is already registered`);
			ids.add(provider.id);
		}
		const changed = new Set(this.deleteProviderOwner(owner));
		for (const provider of normalized) this.providers.set(provider.id, { owner, provider });
		for (const provider of normalized) changed.add(provider.id);
		if (changed.size > 0) this.providersChanged(changed);
	}

	private deleteProviderOwner(owner: object): readonly string[] {
		const removed: string[] = [];
		for (const [id, entry] of this.providers) {
			if (entry.owner !== owner) continue;
			this.providers.delete(id);
			removed.push(id);
		}
		return removed;
	}

	private providersChanged(providerIds: ReadonlySet<string> | readonly string[]): void {
		if (this.isDisposed) return;
		const changedProviders = new Set(providerIds);
		const refresh = this.loaded || this.activeProviderRefresh !== undefined;
		this.providerProfiles = Object.freeze(this.providerProfiles.filter(profile => !changedProviders.has(profile.source)));
		this.projectProfiles();
		this.activeProviderRefresh?.abort();
		this.providerRefreshGeneration += 1;
		if (refresh) void this.refreshProviderProfiles().catch(error => this.reportError(error));
	}

	private async refreshProviderProfiles(): Promise<readonly ITestProfile[]> {
		this.assertNotDisposed();
		this.activeProviderRefresh?.abort();
		const controller = new AbortController();
		this.activeProviderRefresh = controller;
		const generation = ++this.providerRefreshGeneration;
		const providers = [...this.providers.values()].map(entry => entry.provider);
		try {
			const providerProfiles = (await Promise.all(providers.map(provider => this.provideProfiles(provider, controller.signal)))).flat();
			if (controller.signal.aborted || generation !== this.providerRefreshGeneration || this.isDisposed) return this.currentProfiles;
			const ids = new Set(this.taskService.tasks.filter(task => task.group === "test").map(task => task.id));
			for (const profile of providerProfiles) {
				if (ids.has(profile.id)) throw new Error(`Test Profile '${profile.id}' is already registered`);
				ids.add(profile.id);
			}
			this.providerProfiles = Object.freeze(providerProfiles);
			this.loaded = true;
			this.projectProfiles();
			return this.currentProfiles;
		} catch (error) {
			if (controller.signal.aborted || generation !== this.providerRefreshGeneration || this.isDisposed) return this.currentProfiles;
			throw error;
		} finally {
			if (this.activeProviderRefresh === controller) this.activeProviderRefresh = undefined;
		}
	}

	private async provideProfiles(provider: TestProfileProvider, signal: AbortSignal): Promise<readonly ITestProfile[]> {
		const contributions = await provider.provideTestProfiles(signal);
		if (signal.aborted) return Object.freeze([]);
		if (!Array.isArray(contributions)) throw new TypeError(`Test Profile provider '${provider.id}' must return an array`);
		const ids = new Set<string>();
		return Object.freeze(contributions.map(contribution => {
			const profile = projectProviderProfile(provider.id, contribution, this.taskService);
			if (ids.has(profile.id)) throw new Error(`Test Profile provider '${provider.id}' returned duplicate profile '${contribution.id}'`);
			ids.add(profile.id);
			return profile;
		}));
	}


	private reportError(error: unknown): void {
		this.logService.error("testing", "Test operation failed", error);
	}
}

class TestRun extends Disposable implements ITestRun {
	private readonly statusEmitter = this._register(new Emitter<TestRunStatus>());
	private _status: TestRunStatus;
	readonly onDidChangeStatus: Event<TestRunStatus> = this.statusEmitter.event;

	constructor(readonly profile: ITestProfile, readonly taskRun: ITaskRun, private readonly onChange: (run: TestRun) => void) {
		super();
		this._status = projectTestStatus(taskRun.status);
		this._register(taskRun.onDidChangeStatus(() => {
			const status = projectTestStatus(taskRun.status);
			if (status === this._status) return;
			this._status = status;
			this.statusEmitter.fire(status);
			this.onChange(this);
		}));
	}

	get status(): TestRunStatus { return this._status; }
}

function projectTestStatus(status: ITaskRun["status"]): TestRunStatus {
	if (status === "succeeded") return "passed";
	return status;
}

function normalizeTestProfileProvider(provider: TestProfileProvider): TestProfileProvider {
	if (!provider || typeof provider !== "object") throw new TypeError("Test Profile provider must be an object");
	const id = normalizeText(provider.id, "Test Profile provider ID", 256);
	if (typeof provider.provideTestProfiles !== "function") throw new TypeError(`Test Profile provider '${id}' must implement provideTestProfiles`);
	return Object.freeze({ id, provideTestProfiles: (signal: AbortSignal) => provider.provideTestProfiles.call(provider, signal) });
}

function projectProviderProfile(providerId: string, contribution: TestProfileContribution, taskService: ITaskService): ITestProfile {
	if (!contribution || typeof contribution !== "object") throw new TypeError(`Test Profile provider '${providerId}' returned an invalid profile`);
	const id = normalizeText(contribution.id, `Test Profile provider '${providerId}' profile ID`, 256);
	const label = normalizeText(contribution.label, `Test Profile provider '${providerId}' profile label`, 256);
	const taskId = normalizeText(contribution.taskId, `Test Profile provider '${providerId}' task ID`, 1024);
	if (!taskService.tasks.some(task => task.id === taskId && task.group === "test")) throw new Error(`Test Profile provider '${providerId}' references unavailable test task '${taskId}'`);
	const detail = contribution.detail === undefined ? undefined : normalizeText(contribution.detail, `Test Profile provider '${providerId}' profile detail`, 4096, false);
	return Object.freeze({ id: `extension-profile:${encodeURIComponent(providerId)}:${encodeURIComponent(id)}`, label, source: providerId, taskId, ...(detail === undefined ? {} : { detail }) });
}

function normalizeText(value: string, owner: string, maximum: number, trim = true): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return trim ? value.trim() : value;
}

function staleSelection(): Error {
	return new Error(localize('testing.staleSelection', 'The selected tests have changed. Refresh tests and select them again.'));
}

async function settle(promises: readonly Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(promises);
	const failed = results.find(result => result.status === 'rejected');
	if (failed?.status === 'rejected') { throw failed.reason; }
}
