import { Emitter, runWithBufferedEvents, type Event } from "../../../../base/common/event.js";
import { getErrorMessage } from "../../../../base/common/errors.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { CommandRegistry } from "../../../../platform/commands/common/commands.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from "../../../../platform/extensionHost/common/extensionHostApi.js";
import type { AppServerConnectionState } from "../../../../platform/app-server/common/appServerApi.js";
import { IOutputService, type IOutputChannel, type OutputEntrySeverity } from "../../output/common/outputService.js";
import { MainThreadExtensionApi, type ExtensionApiIssue } from "../../../api/browser/mainThreadExtensionApi.js";
import { EmptyExtensionHostSnapshot, type ExtensionHostExtension, type ExtensionHostFailure, type ExtensionHostRegistration as WorkbenchExtensionHostRegistration, type ExtensionHostSnapshot, type ExtensionHostState, type IExtensionHostService } from "../common/extensionHostService.js";

type RefreshAction = "list" | "reconcile";

/** Owns one coherent frontend projection of the App Server Extension Host fleet. */
export class AppServerExtensionHostService extends Disposable implements IExtensionHostService {
	private readonly stateEmitter = this._register(new Emitter<ExtensionHostState>());
	private readonly changeEmitter = this._register(new Emitter<ExtensionHostSnapshot>());
	private readonly failureEmitter = this._register(new Emitter<ExtensionHostFailure>());
	private readonly extensionApi: MainThreadExtensionApi;
	private readonly fleetOutput: IOutputChannel;
	private _state: ExtensionHostState = "stopped";
	private snapshot: ExtensionHostSnapshot = EmptyExtensionHostSnapshot;
	private connectionReady = false;
	private connectionRevision = 0;
	private authorityRevision = 0;
	private desiredGeneration = 0;
	private pendingAction: RefreshAction | undefined;
	private refreshRunner: Promise<void> | undefined;
	private started = false;

	readonly onDidChangeState: Event<ExtensionHostState> = this.stateEmitter.event;
	readonly onDidChange: Event<ExtensionHostSnapshot> = this.changeEmitter.event;
	readonly onDidFail: Event<ExtensionHostFailure> = this.failureEmitter.event;

	constructor(
		commands: CommandRegistry,
		invocationTimeoutMillis: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOutputService output: IOutputService,
	) {
		super();
		const timeout = normalizeTimeout(invocationTimeoutMillis);
		this.fleetOutput = this._register(output.createChannel({ id: "extension-host", label: "Extension Host", kind: "log", source: "core" }));
		this.extensionApi = this._register(instantiationService.createInstance(MainThreadExtensionApi, commands, timeout, this.fleetOutput));
		const changed = api.onDidChange(generation => this.acceptChanged(generation));
		const connection = api.onConnectionState(state => { void this.acceptConnectionState(state).catch(error => this.failRefresh(error)); });
		this._register(toDisposable(() => changed.dispose()));
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => {
			this.started = false;
			this.connectionRevision += 1;
			this.authorityRevision += 1;
			this.pendingAction = undefined;
			this.extensionApi.clear();
		}));
	}

	get state(): ExtensionHostState { return this._state; }
	get currentSnapshot(): ExtensionHostSnapshot { return this.snapshot; }

	async start(): Promise<void> {
		this.assertNotDisposed();
		if (this.started) return this.refreshRunner ?? Promise.resolve();
		this.started = true;
		this.setState("starting");
		const revision = this.connectionRevision;
		try {
			const state = await this.api.getConnectionState();
			if (!this.isDisposed && this.started && revision === this.connectionRevision) await this.acceptConnectionState(state, false);
		} catch (error) {
			if (!this.isDisposed && this.started && revision === this.connectionRevision) this.failRefresh(error);
		}
		return this.refreshRunner ?? Promise.resolve();
	}

	reload(): Promise<void> {
		this.assertNotDisposed();
		if (!this.started) return this.start();
		if (!this.connectionReady) {
			this.setState("starting");
			return Promise.resolve();
		}
		return this.requestRefresh("reconcile");
	}

	stop(): Promise<void> {
		this.assertNotDisposed();
		if (!this.started) return Promise.resolve();
		this.started = false;
		this.authorityRevision += 1;
		this.pendingAction = undefined;
		this.desiredGeneration = 0;
		runWithBufferedEvents(() => {
			this.extensionApi.clear();
			this.setSnapshot(EmptyExtensionHostSnapshot);
			this.setState("stopped");
		});
		return Promise.resolve();
	}

	private acceptChanged(generation: number): void {
		if (this.isDisposed || !this.started) return;
		if (!Number.isSafeInteger(generation) || generation < 1) {
			this.failRefresh(new TypeError("Extension Host notification generation is invalid"));
			return;
		}
		this.desiredGeneration = Math.max(this.desiredGeneration, generation);
		if (this.connectionReady) void this.requestRefresh("list").catch(reportExtensionHostError);
	}

	private async acceptConnectionState(state: AppServerConnectionState, fromEvent = true): Promise<void> {
		if (this.isDisposed) return;
		if (fromEvent) this.connectionRevision += 1;
		if (!this.started) return;
		if (state === "ready") {
			const revision = this.connectionRevision;
			const available = await this.api.isAvailable();
			if (this.isDisposed || !this.started || revision !== this.connectionRevision) return;
			this.connectionReady = available;
			if (!available) {
				runWithBufferedEvents(() => {
					this.extensionApi.clear();
					this.setSnapshot(EmptyExtensionHostSnapshot);
					this.setState("stopped");
				});
				return;
			}
			await this.requestRefresh("reconcile");
			return;
		}
		this.connectionReady = false;
		this.authorityRevision += 1;
		this.pendingAction = undefined;
		runWithBufferedEvents(() => {
			this.extensionApi.clear();
			this.setSnapshot(EmptyExtensionHostSnapshot);
			this.setState(state === "crashed" ? "failed" : "starting");
		});
	}

	private requestRefresh(action: RefreshAction): Promise<void> {
		if (this.isDisposed || !this.started || !this.connectionReady) return Promise.resolve();
		this.pendingAction = mergeAction(this.pendingAction, action);
		if (!this.extensionApi.hasContributions) this.setState("starting");
		if (!this.refreshRunner) this.refreshRunner = this.drainRefreshes();
		return this.refreshRunner;
	}

	private async drainRefreshes(): Promise<void> {
		try {
			while (!this.isDisposed && this.started && this.connectionReady && this.pendingAction) {
				const action = this.pendingAction;
				this.pendingAction = undefined;
				const revision = this.authorityRevision;
				try {
					const snapshot = action === "reconcile" ? await this.api.reconcile("refresh") : await this.api.list();
					if (this.isDisposed || !this.started || !this.connectionReady || revision !== this.authorityRevision) continue;
					if (snapshot.generation < this.desiredGeneration) {
						this.pendingAction = mergeAction(this.pendingAction, "list");
						continue;
					}
					this.desiredGeneration = 0;
					this.acceptSnapshot(snapshot);
				} catch (error) {
					if (this.isDisposed || !this.started || !this.connectionReady || revision !== this.authorityRevision) continue;
					this.failRefresh(error);
				}
			}
		} finally {
			this.refreshRunner = undefined;
			if (!this.isDisposed && this.started && this.connectionReady && this.pendingAction) this.refreshRunner = this.drainRefreshes();
		}
	}

	private acceptSnapshot(snapshot: ExtensionHostFleetSnapshot): void {
		const projected = projectSnapshot(snapshot);
		try {
			runWithBufferedEvents(() => {
				const issues = this.extensionApi.update(snapshot);
				this.setSnapshot(projected);
				this.publishSnapshotFailures(snapshot, issues);
				this.setState(projectState(snapshot, issues.length > 0));
			});
		} catch (error) {
			runWithBufferedEvents(() => {
				this.failureEmitter.fire({ extensionId: undefined, code: "registrationProjectionFailed", incarnation: undefined, message: errorMessage(error) });
				this.setState(this.extensionApi.hasContributions ? "degraded" : "failed");
			});
		}
	}

	private publishSnapshotFailures(snapshot: ExtensionHostFleetSnapshot, issues: readonly ExtensionApiIssue[]): void {
		for (const runtime of snapshot.extensions) {
			if (!runtime.failure) continue;
			this.failureEmitter.fire({ extensionId: runtime.id, code: runtime.failure.code, incarnation: runtime.failure.incarnation, message: runtime.failure.message });
		}
		for (const issue of issues) this.failureEmitter.fire({ extensionId: issue.extensionId, code: "unsupportedRegistrationBridge", incarnation: undefined, message: issue.message });
	}

	private failRefresh(error: unknown): void {
		runWithBufferedEvents(() => {
			this.failureEmitter.fire({ extensionId: undefined, code: "extensionHostRefreshFailed", incarnation: undefined, message: errorMessage(error) });
			this.setState(this.extensionApi.hasContributions ? "degraded" : "failed");
		});
	}

	private setSnapshot(snapshot: ExtensionHostSnapshot): void {
		if (this.snapshot === snapshot) return;
		this.snapshot = snapshot;
		this.changeEmitter.fire(snapshot);
	}

	private setState(state: ExtensionHostState): void {
		if (this._state === state) return;
		this._state = state;
		this.fleetOutput?.appendLine({ severity: fleetStateSeverity(state), category: "lifecycle", text: `Extension Host fleet is ${state}.` });
		this.stateEmitter.fire(state);
	}

}

function projectSnapshot(snapshot: ExtensionHostFleetSnapshot): ExtensionHostSnapshot {
	return Object.freeze({
		fleetGeneration: snapshot.generation,
		extensions: Object.freeze(snapshot.extensions.map((runtime): ExtensionHostExtension => Object.freeze({
			id: runtime.id,
			version: runtime.version,
			packageDigest: runtime.packageDigest,
			runtimeApiVersion: runtime.runtimeApiVersion,
			activationGeneration: runtime.activationGeneration,
			incarnation: runtime.incarnation,
			state: runtime.lifecycle,
			failure: runtime.failure,
			stderr: runtime.stderr,
			registrations: Object.freeze(runtime.registrations.map((registration): WorkbenchExtensionHostRegistration => Object.freeze({ id: registration.registrationId, kind: registration.kind === "testProfileProvider" ? "testProfileProvider" : registration.kind }))),
		}))),
	});
}

function fleetStateSeverity(state: ExtensionHostState): OutputEntrySeverity {
	if (state === "failed") return "error";
	if (state === "degraded") return "warning";
	return state === "ready" ? "information" : "log";
}

function projectState(snapshot: ExtensionHostFleetSnapshot, bridgeIssues: boolean): ExtensionHostState {
	if (snapshot.extensions.length === 0) return bridgeIssues ? "degraded" : "ready";
	const ready = snapshot.extensions.filter(extension => extension.lifecycle === "ready").length;
	if (ready === snapshot.extensions.length) return bridgeIssues ? "degraded" : "ready";
	if (ready > 0) return "degraded";
	if (snapshot.extensions.every(extension => extension.lifecycle === "stopped")) return "stopped";
	if (snapshot.extensions.some(extension => extension.lifecycle === "starting" || extension.lifecycle === "handshaking" || extension.lifecycle === "recovering")) return "starting";
	return "failed";
}

function mergeAction(current: RefreshAction | undefined, next: RefreshAction): RefreshAction {
	return current === "reconcile" || next === "reconcile" ? "reconcile" : "list";
}

function normalizeTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new TypeError("Extension Host invocation timeout is invalid");
	return value;
}

function errorMessage(error: unknown): string {
	return getErrorMessage(error).slice(0, 4096);
}

function reportExtensionHostError(error: unknown): void {
	console.error("Extension Host refresh failed", error);
}
