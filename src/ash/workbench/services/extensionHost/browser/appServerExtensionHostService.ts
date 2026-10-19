import { MainThreadClientEditors } from '../../../api/browser/mainThreadClientEditors.js';
import { loadExtensionEditorModule } from '../../extensions/browser/extensionEditorModules.js';
import { MainThreadLocalization } from '../../../api/browser/mainThreadLocalization.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { IExtensionService } from '../../extensions/common/extensionService.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/common/lifecycle.js';
import { Emitter, runWithBufferedEvents, type Event } from "../../../../base/common/event.js";
import { CancellationError, getErrorMessage } from "../../../../base/common/errors.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { CommandRegistry } from "../../../../platform/commands/common/commands.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { createExtensionHostInitialization } from '../../extensions/common/extensionHostProtocol.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type ExtensionHostActivationEvent } from '../../../../platform/agentHost/common/extensionHostApi.js';
import type { AppServerConnectionState } from "../../../../platform/agentHost/common/appServerApi.js";
import { IOutputService, type IOutputChannel, type OutputEntrySeverity } from "../../output/common/output.js";
import { MainThreadExtensionApi, type ExtensionApiIssue } from "../../../api/browser/mainThreadExtensionApi.js";
import { EmptyExtensionHostSnapshot, type ExtensionHostExtension, type ExtensionHostFailure, type ExtensionHostRegistration as WorkbenchExtensionHostRegistration, type ExtensionHostSnapshot, type ExtensionHostState, type IExtensionHostService } from "../common/extensionHostService.js";

type RefreshAction = "list" | "reconcile";

/** Owns one coherent frontend projection of the App Server Extension Host fleet. */
export class AppServerExtensionHostService extends Disposable implements IExtensionHostService {
	private readonly stateEmitter = this._register(new Emitter<ExtensionHostState>());
	private readonly changeEmitter = this._register(new Emitter<ExtensionHostSnapshot>());
	private readonly failureEmitter = this._register(new Emitter<ExtensionHostFailure>());
	private readonly extensionApi: MainThreadExtensionApi;
	private readonly clientEditors: MainThreadClientEditors;
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
	private readonly pendingActivations = new Map<string, Promise<void>>();

	readonly onDidChangeState: Event<ExtensionHostState> = this.stateEmitter.event;
	readonly onDidChange: Event<ExtensionHostSnapshot> = this.changeEmitter.event;
	readonly onDidFail: Event<ExtensionHostFailure> = this.failureEmitter.event;

	constructor(
		commands: CommandRegistry,
		invocationTimeoutMillis: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOutputService output: IOutputService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		const timeout = normalizeTimeout(invocationTimeoutMillis);
		this.fleetOutput = this._register(output.createChannel({ id: "extension-host", label: "Extension Host", kind: "log", source: "core" }));
		this.extensionApi = this._register(instantiationService.createInstance(MainThreadExtensionApi, commands, timeout, this.fleetOutput));
		this.clientEditors = this._register(instantiationService.createInstance(MainThreadClientEditors, timeout, loadExtensionEditorModule));
		this._register(extensions.registerActivationHandler((event, signal) => this.activateByEvent(event, signal)));
		this._register(models.onModelAdded(() => this.activateEditorEvents()));
		this._register(models.onModelLanguageChanged(() => this.activateEditorEvents()));
		void lifecycle.when(LifecyclePhase.Restored).then(() => this.activateEditorEvents());
		const changed = api.onDidChange(generation => this.acceptChanged(generation));
		const connection = api.onConnectionState(state => { void this.acceptConnectionState(state).catch(error => this.failRefresh(error)); });
		this._register(toDisposable(() => changed.dispose()));
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => {
			this.started = false;
			this.connectionRevision += 1;
			this.authorityRevision += 1;
			this.pendingAction = undefined;
			this.pendingActivations.clear();
			this.extensionApi.clear();
			this.clientEditors.clear();
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
			// Eager editor providers must publish their factories before tabs restore. Other
			// startup providers keep running concurrently with Workbench restoration.
			const editorOwners = new Set(this.extensions.getExtensionPointContributions<readonly unknown[]>('customEditors')
				.filter(user => user.value.length > 0).map(user => user.description.id));
			const editorActivations = this.snapshot.extensions.flatMap(extension => {
				const pending = this.pendingActivations.get(`${extension.id}:${extension.activationGeneration}`);
				return editorOwners.has(extension.id) && pending ? [pending] : [];
			});
			await Promise.all(editorActivations);
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
		this.pendingActivations.clear();
		this.pendingAction = undefined;
		this.desiredGeneration = 0;
		runWithBufferedEvents(() => {
			this.extensionApi.clear();
			this.clientEditors.clear();
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
			// Provider callbacks inspect registered configuration and package identities.
			// A service instance alone does not mean its declarative catalog has committed.
			// Await that owner explicitly instead of failing and retrying a partial fleet.
			if (available) await this.extensions.start();
			if (this.isDisposed || !this.started || revision !== this.connectionRevision) return;
			this.connectionReady = available;
			if (!available) {
				runWithBufferedEvents(() => {
					this.extensionApi.clear();
					this.clientEditors.clear();
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
		this.pendingActivations.clear();
		this.pendingAction = undefined;
		runWithBufferedEvents(() => {
			this.extensionApi.clear();
			this.clientEditors.clear();
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
					await this.acceptSnapshot(snapshot);
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

	private async acceptSnapshot(snapshot: ExtensionHostFleetSnapshot): Promise<void> {
		const revision = this.authorityRevision;
		// Dormant declarations must be discoverable before executing their provider.
		// Resolve only display titles through this window's existing package NLS owner.
		const extensions = await Promise.all(snapshot.extensions.map(async runtime => {
			const activation = runtime.activation;
			if (runtime.lifecycle !== 'dormant' || !activation?.commands.some(command => command.title.includes('%'))) return runtime;
			const titles: string[] = JSON.parse(await this.instantiationService.createInstance(MainThreadLocalization).localizeManifest(
				runtime.id, JSON.stringify(activation.commands.map(command => command.title)), this.extensions.currentCatalog.generation,
			));
			return { ...runtime, activation: { ...activation, commands: activation.commands.map((command, index) => ({ ...command, title: titles[index]! })) } };
		}));
		if (this.isDisposed || !this.started || !this.connectionReady || revision !== this.authorityRevision || snapshot.generation < this.snapshot.fleetGeneration) return;
		snapshot = { ...snapshot, extensions };
		const projected = projectSnapshot(snapshot);
		try {
			await this.clientEditors.update(snapshot);
			if (this.isDisposed || !this.started || !this.connectionReady || revision !== this.authorityRevision || snapshot.generation < this.snapshot.fleetGeneration) return;
			runWithBufferedEvents(() => {
				const issues = this.extensionApi.update(snapshot);
				this.setSnapshot(projected);
				this.publishSnapshotFailures(snapshot, issues);
				this.setState(projectState(snapshot, issues.length > 0));
			});
			this.activateEditorEvents(snapshot);
		} catch (error) {
			runWithBufferedEvents(() => {
				this.fleetOutput.appendLine({ severity: 'error', category: 'registration', text: errorMessage(error) });
				this.failureEmitter.fire({ extensionId: undefined, code: "registrationProjectionFailed", incarnation: undefined, message: errorMessage(error) });
				this.setState(this.extensionApi.hasContributions ? "degraded" : "failed");
			});
		}
	}

	private activateEditorEvents(snapshot?: ExtensionHostFleetSnapshot): void {
		if (this.isDisposed || !this.started || !this.connectionReady) { return; }
		if (!snapshot) { void this.requestRefresh('list').catch(reportExtensionHostError); return; }
		const languages = new Set(this.models.getModels().map(model => model.getLanguageId()));
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'dormant') { continue; }
			const language = [...languages].find(id => runtime.activation!.events.includes('onLanguage') || runtime.activation!.events.includes(`onLanguage:${id}`));
			if (language) { void this.activateRuntime(runtime, { type: 'language', languageId: language }).catch(reportExtensionHostError); }
			else if (runtime.activation!.events.includes('*') || this.lifecycle.phase >= LifecyclePhase.Restored && runtime.activation!.events.includes('onStartupFinished')) { void this.activateRuntime(runtime, { type: 'startupFinished' }).catch(reportExtensionHostError); }
		}
	}

	private async activateByEvent(event: string, signal?: AbortSignal): Promise<void> {
		this.assertNotDisposed();
		if (signal) throwIfCancelled(signal);
		const revision = this.authorityRevision;
		// A plugin mutation can precede its notification. Discover dormant owners
		// from current authority before selecting an activation fence.
		await this.reload();
		if (signal) throwIfCancelled(signal);
		if (!this.started || !this.connectionReady || this.isDisposed || revision !== this.authorityRevision) throw new CancellationError();
		const snapshot = await this.api.list();
		if (signal) throwIfCancelled(signal);
		if (!this.started || !this.connectionReady || this.isDisposed || revision !== this.authorityRevision) throw new CancellationError();
		if (snapshot.generation < this.snapshot.fleetGeneration) throw new CancellationError();
		await this.acceptSnapshot(snapshot);
		if (signal) throwIfCancelled(signal);
		if (!this.started || !this.connectionReady || this.isDisposed || revision !== this.authorityRevision) throw new CancellationError();
		const activations = snapshot.extensions.flatMap(runtime => {
			if (runtime.lifecycle !== 'dormant') return [];
			const activation = selectActivationEvent(runtime.activation!.events, event);
			return activation ? [this.activateRuntime(runtime, activation)] : [];
		});
		const operation = Promise.all(activations);
		await (signal ? raceCancellationError(operation, signal) : operation);
		if (signal) throwIfCancelled(signal);
		if (!this.started || !this.connectionReady || this.isDisposed || revision !== this.authorityRevision) throw new CancellationError();
	}

	private activateRuntime(runtime: ExtensionHostRuntime, event: ExtensionHostActivationEvent): Promise<void> {
		const key = `${runtime.id}:${runtime.activationGeneration}`;
		const existing = this.pendingActivations.get(key);
		if (existing) { return existing; }
		const revision = this.authorityRevision;
		const pending = this.instantiationService.createInstance(MainThreadLocalization).getLocalization(runtime.id).then(localization => {
			if (this.isDisposed || !this.started || !this.connectionReady || revision !== this.authorityRevision) throw new CancellationError();
			return this.api.activateByEvent({
				extensionId: runtime.id, activationGeneration: runtime.activationGeneration, event, initialization: { ...createExtensionHostInitialization(this.workspace, this.configuration), localization }
			});
		}).then(async snapshot => {
			if (!this.isDisposed && this.started && this.connectionReady && revision === this.authorityRevision && snapshot.generation >= this.snapshot.fleetGeneration) { await this.acceptSnapshot(snapshot); }
			const activated = snapshot.extensions.find(extension => extension.id === runtime.id && extension.activationGeneration === runtime.activationGeneration);
			if (activated?.lifecycle !== 'ready') throw new Error(localize('extensionHost.activationFailed', "Extension '{0}' failed to activate: {1}", runtime.id, activated?.failure?.message ?? activated?.lifecycle ?? 'unavailable'));
		}).catch(error => {
			if (!this.isDisposed && this.started && revision === this.authorityRevision) { this.failureEmitter.fire({ extensionId: runtime.id, code: 'activationFailed', incarnation: undefined, message: errorMessage(error) }); }
			throw error;
		}).finally(() => { if (this.pendingActivations.get(key) === pending) { this.pendingActivations.delete(key); } });
		this.pendingActivations.set(key, pending);
		return pending;
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

function selectActivationEvent(declarations: readonly string[], event: string): ExtensionHostActivationEvent | undefined {
	if (event === 'onTerminal' && declarations.includes('onDemand:terminalLinkProvider')) return { type: 'capability', capability: 'terminalLinkProvider' };
	if (event === 'onSpeech' && (declarations.includes('onSpeech') || declarations.includes('onDemand:speechProvider'))) return { type: 'speech' };
	if (event.startsWith('onTerminalProfile:')) {
		const profileId = event.slice('onTerminalProfile:'.length);
		if (declarations.includes(event) || declarations.includes('onDemand:terminalProfileProvider')) return { type: 'terminalProfile', profileId };
	}
	if (event === 'onTaskType' || event.startsWith('onTaskType:')) {
		const requested = event === 'onTaskType' ? undefined : event.slice('onTaskType:'.length);
		const declared = declarations.find(value => value.startsWith('onTaskType:'));
		const matches = declarations.includes('onTaskType') || declarations.includes('onDemand:taskProvider') || (requested ? declarations.includes(event) : declared !== undefined);
		if (matches) {
			return { type: 'taskType', taskType: requested ?? declared?.slice('onTaskType:'.length) ?? null };
		}
		return undefined;
	}
	const phases = { onDebug: 'start', onDebugInitialConfigurations: 'initialConfigurations', onDebugDynamicConfigurations: 'dynamicConfigurations', onDebugResolve: 'resolveConfiguration' } as const;
	const [name, debugType] = event.split(':', 2);
	if (!name || !Object.hasOwn(phases, name)) return undefined;
	const declaredType = !debugType && name === 'onDebugDynamicConfigurations' ? declarations.find(value => value.startsWith(`${name}:`))?.slice(name.length + 1) : undefined;
	if (!declarations.includes(event) && !declarations.includes(name) && !declarations.includes('onDemand:debugAdapter') && !(debugType && declarations.includes(`onDebugType:${debugType}`)) && !declaredType) return undefined;
	return { type: 'debug', phase: phases[name as keyof typeof phases], debugType: debugType ?? declaredType ?? null };
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
	const ready = snapshot.extensions.filter(extension => (extension.lifecycle === "ready" || extension.lifecycle === "dormant")).length;
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
