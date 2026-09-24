import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type { ILogService } from "../../../../platform/log/common/log.js";
import { type ITaskRun, type ITaskService } from "../../tasks/common/taskService.js";
import { type ITestProfile, type ITestRun, type ITestingService, type TestProfileContribution, type TestProfileProvider, type TestProfileProviderRegistration, type TestRunStatus } from "../common/testingService.js";

interface OwnedTestProfileProvider {
	readonly owner: object;
	readonly provider: TestProfileProvider;
}

/** Projects test-group workspace tasks into a dedicated testing workflow. */
export class TestingService extends Disposable implements ITestingService {
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

	constructor(private readonly taskService: ITaskService, private readonly logService?: ILogService) {
		super();
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

	async runAll(): Promise<readonly ITestRun[]> {
		const profiles = await this.refresh();
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
		this.logService?.error("testing.profiles", "Could not refresh Test Profiles", error);
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
