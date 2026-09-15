import { Emitter, runWithBufferedEvents, type Event } from "../../../../base/common/event.js";
import { getErrorMessage } from "../../../../base/common/errors.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { CommandsRegistry, type CommandDefinition, type CommandRegistration, type CommandRegistry } from "../../../../platform/commands/common/commands.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostLanguageRegistration, type ExtensionHostRegistration, type ExtensionHostRuntime, type IExtensionHostApi, type JsonValue } from "../../../../platform/extensionHost/common/extensionHostApi.js";
import type { AppServerConnectionState } from "../../../../platform/app-server/common/appServerApi.js";
import type { LanguageProviderBatch, LanguageProviderBatchRegistration } from '../../../../editor/common/services/languageFeatures.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { ITaskService, TaskProvider, TaskProviderRegistration } from "../../tasks/common/taskService.js";
import type { ITestingService, TestProfileProvider, TestProfileProviderRegistration } from "../../testing/common/testingService.js";
import type { IOutputChannel, IOutputService, OutputEntrySeverity } from "../../output/common/outputService.js";
import { EmptyExtensionHostSnapshot, type ExtensionHostExtension, type ExtensionHostFailure, type ExtensionHostRegistration as WorkbenchExtensionHostRegistration, type ExtensionHostSnapshot, type ExtensionHostState, type IExtensionHostService } from "../common/extensionHostService.js";
import { createExtensionHostLanguageProviderBatch, extensionHostLanguageProviderId, unsupportedExtensionHostLanguageOperations, type ExtensionHostProviderInvoker } from "./extensionHostLanguageBridge.js";
import { createExtensionHostTaskProvider, createExtensionHostTestProfileProvider, extensionHostCanonicalTaskId, extensionHostWorkflowProviderId } from "./extensionHostWorkflowBridge.js";

export interface AppServerExtensionHostServiceOptions {
	readonly api: IExtensionHostApi;
	readonly languageFeatures: ILanguageFeaturesService;
	readonly tasks: ITaskService;
	readonly testing: ITestingService;
	readonly commands?: CommandRegistry;
	readonly output?: IOutputService;
	readonly invocationTimeoutMillis?: number;
}

type RefreshAction = "list" | "reconcile";

interface BridgeIssue {
	readonly extensionId: string;
	readonly registrationId: string;
	readonly message: string;
}

interface ContributionSet {
	readonly commands: readonly CommandDefinition[];
	readonly languages: Required<LanguageProviderBatch>;
	readonly tasks: readonly TaskProvider[];
	readonly tests: readonly TestProfileProvider[];
	readonly issues: readonly BridgeIssue[];
	readonly controller: AbortController;
}

interface ExtensionOutputCursor {
	readonly incarnation: number | undefined;
	readonly lifecycle: ExtensionHostRuntime["lifecycle"];
	readonly stderrLength: number;
	readonly failureKey: string;
}

interface ExtensionNamedOutputCursor {
	readonly activationGeneration: number;
	readonly sequence: number;
}

interface ExtensionNamedOutputChannel {
	readonly extensionId: string;
	readonly channelId: string;
	readonly label: string;
	readonly kind: "output" | "log";
	readonly channel: IOutputChannel;
}

/** Owns one coherent frontend projection of the App Server Extension Host fleet. */
export class AppServerExtensionHostService extends Disposable implements IExtensionHostService {
	private readonly stateEmitter = this._register(new Emitter<ExtensionHostState>());
	private readonly changeEmitter = this._register(new Emitter<ExtensionHostSnapshot>());
	private readonly failureEmitter = this._register(new Emitter<ExtensionHostFailure>());
	private readonly commandRegistration: CommandRegistration;
	private readonly languageRegistration: LanguageProviderBatchRegistration;
	private readonly taskRegistration: TaskProviderRegistration;
	private readonly testRegistration: TestProfileProviderRegistration;
	private readonly commands: CommandRegistry;
	private readonly invocationTimeoutMillis: number;
	private readonly fleetOutput: IOutputChannel | undefined;
	private readonly extensionOutputs = new Map<string, IOutputChannel>();
	private readonly outputCursors = new Map<string, ExtensionOutputCursor>();
	private readonly namedOutputChannels = new Map<string, ExtensionNamedOutputChannel>();
	private readonly namedOutputCursors = new Map<string, ExtensionNamedOutputCursor>();
	private _state: ExtensionHostState = "stopped";
	private snapshot: ExtensionHostSnapshot = EmptyExtensionHostSnapshot;
	private activeContributions: ContributionSet | undefined;
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

	constructor(private readonly options: AppServerExtensionHostServiceOptions) {
		super();
		this.commands = options.commands ?? CommandsRegistry;
		this.invocationTimeoutMillis = normalizeTimeout(options.invocationTimeoutMillis ?? 30_000);
		this.fleetOutput = options.output ? this._register(options.output.createChannel({ id: "extension-host", label: "Extension Host", kind: "log", source: "core" })) : undefined;
		this.commandRegistration = this._register(this.commands.registerMany([]));
		this.languageRegistration = this._register(options.languageFeatures.registerProviderBatch({}));
		this.taskRegistration = this._register(options.tasks.registerTaskProviders([]));
		this.testRegistration = this._register(options.testing.registerTestProfileProviders([]));
		const changed = options.api.onDidChange(generation => this.acceptChanged(generation));
		const connection = options.api.onConnectionState(state => { void this.acceptConnectionState(state).catch(error => this.failRefresh(error)); });
		this._register(toDisposable(() => changed.dispose()));
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => {
			this.started = false;
			this.connectionRevision += 1;
			this.authorityRevision += 1;
			this.pendingAction = undefined;
			this.revokeContributions();
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
			const state = await this.options.api.getConnectionState();
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
			this.revokeContributions();
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
			const available = await this.options.api.isAvailable();
			if (this.isDisposed || !this.started || revision !== this.connectionRevision) return;
			this.connectionReady = available;
			if (!available) {
				runWithBufferedEvents(() => {
					this.revokeContributions();
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
			this.revokeContributions();
			this.setSnapshot(EmptyExtensionHostSnapshot);
			this.setState(state === "crashed" ? "failed" : "starting");
		});
	}

	private requestRefresh(action: RefreshAction): Promise<void> {
		if (this.isDisposed || !this.started || !this.connectionReady) return Promise.resolve();
		this.pendingAction = mergeAction(this.pendingAction, action);
		if (!this.activeContributions) this.setState("starting");
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
					const snapshot = action === "reconcile" ? await this.options.api.reconcile("refresh") : await this.options.api.list();
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
		this.projectOutput(snapshot);
		const contributions = this.buildContributions(snapshot);
		const projected = projectSnapshot(snapshot);
		try {
			runWithBufferedEvents(() => {
				this.replaceContributions(contributions);
				this.setSnapshot(projected);
				this.publishSnapshotFailures(snapshot, contributions.issues);
				this.setState(projectState(snapshot, contributions.issues.length > 0));
			});
		} catch (error) {
			contributions.controller.abort(error);
			runWithBufferedEvents(() => {
				this.failureEmitter.fire({ extensionId: undefined, code: "registrationProjectionFailed", incarnation: undefined, message: errorMessage(error) });
				this.setState(this.activeContributions ? "degraded" : "failed");
			});
		}
	}

	private buildContributions(snapshot: ExtensionHostFleetSnapshot): ContributionSet {
		const controller = new AbortController();
		const commands: CommandDefinition[] = [];
		const languages = mutableLanguageBatch();
		const tasks: TaskProvider[] = [];
		const tests: TestProfileProvider[] = [];
		const issues: BridgeIssue[] = [];
		const taskProviders = new Map<string, Map<string, string>>();
		for (const runtime of snapshot.extensions) {
			const providers = new Map<string, string>();
			for (const registration of runtime.registrations) if (registration.kind === "taskProvider") providers.set(registration.registrationId, extensionHostWorkflowProviderId(runtime.id, registration.registrationId));
			taskProviders.set(runtime.id, providers);
		}
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== "ready" || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				const invoke = this.registrationInvoker(runtime, registration, controller.signal);
				if (registration.kind === "command") {
					commands.push(Object.freeze({ id: registration.command, handler: (_accessor: ServicesAccessor, ...args: readonly unknown[]) => invoke("execute", normalizeExtensionHostPayload({ arguments: args }), controller.signal) }));
					continue;
				}
				if (registration.kind === "languageProvider") {
					appendLanguageBatch(languages, createExtensionHostLanguageProviderBatch(registration, runtime.id, extensionHostLanguageProviderId(runtime.id, registration.registrationId), invoke));
					const unsupported = unsupportedExtensionHostLanguageOperations(registration);
					if (unsupported.length > 0) issues.push(unsupportedLanguageIssue(runtime, registration, unsupported));
					continue;
				}
				if (registration.kind === "taskProvider") {
					tasks.push(createExtensionHostTaskProvider(extensionHostWorkflowProviderId(runtime.id, registration.registrationId), invoke));
					continue;
				}
				if (registration.kind === "testProfileProvider") {
					const localTaskProviders = taskProviders.get(runtime.id)!;
					tests.push(createExtensionHostTestProfileProvider(extensionHostWorkflowProviderId(runtime.id, registration.registrationId), invoke, (taskProviderRegistrationId, taskId) => {
						const providerId = localTaskProviders.get(taskProviderRegistrationId);
						if (!providerId) throw new TypeError(`Test Profile references unknown Task provider registration '${taskProviderRegistrationId}' in extension '${runtime.id}'`);
						return extensionHostCanonicalTaskId(providerId, taskId);
					}));
					continue;
				}
				issues.push({ extensionId: runtime.id, registrationId: registration.registrationId, message: `Debug Adapter registration '${registration.debuggerType}' is active, but this Workbench has no asynchronous Host-broker DAP session seam` });
			}
		}
		return Object.freeze({ commands: Object.freeze(commands), languages: freezeLanguageBatch(languages), tasks: Object.freeze(tasks), tests: Object.freeze(tests), issues: Object.freeze(issues), controller });
	}

	private registrationInvoker(runtime: ExtensionHostRuntime, registration: ExtensionHostRegistration, generationSignal: AbortSignal): ExtensionHostProviderInvoker {
		return async (operation, payload, callerSignal) => {
			if (runtime.incarnation === undefined) throw new Error(`Extension '${runtime.id}' has no active runtime incarnation`);
			const combined = combineSignals(generationSignal, callerSignal);
			try {
				return await this.options.api.invoke({
					extensionId: runtime.id,
					registrationId: registration.registrationId,
					activationGeneration: runtime.activationGeneration,
					incarnation: runtime.incarnation,
					operation,
					payload,
					deadlineUnixMillis: Date.now() + this.invocationTimeoutMillis,
				}, combined.signal);
			} finally {
				combined.dispose();
			}
		};
	}

	private replaceContributions(next: ContributionSet): void {
		const previous = this.activeContributions;
		try {
			this.commandRegistration.replace(next.commands);
			this.languageRegistration.replace(next.languages);
			this.taskRegistration.replace(next.tasks);
			this.testRegistration.replace(next.tests);
		} catch (error) {
			try {
				this.commandRegistration.replace(previous?.commands ?? []);
				this.languageRegistration.replace(previous?.languages ?? {});
				this.taskRegistration.replace(previous?.tasks ?? []);
				this.testRegistration.replace(previous?.tests ?? []);
				this.activeContributions = previous;
			} catch (rollbackError) {
				this.commandRegistration.replace([]);
				this.languageRegistration.replace({});
				this.taskRegistration.replace([]);
				this.testRegistration.replace([]);
				this.activeContributions = undefined;
				previous?.controller.abort(rollbackError);
				throw new AggregateError([error, rollbackError], "Extension Host contribution commit and rollback both failed");
			}
			throw error;
		}
		this.activeContributions = next;
		previous?.controller.abort("Extension Host fleet generation was replaced");
	}

	private revokeContributions(): void {
		const active = this.activeContributions;
		this.activeContributions = undefined;
		this.commandRegistration.replace([]);
		this.languageRegistration.replace({});
		this.taskRegistration.replace([]);
		this.testRegistration.replace([]);
		active?.controller.abort("Extension Host authority was revoked");
	}

	private publishSnapshotFailures(snapshot: ExtensionHostFleetSnapshot, issues: readonly BridgeIssue[]): void {
		for (const runtime of snapshot.extensions) {
			if (!runtime.failure) continue;
			this.failureEmitter.fire({ extensionId: runtime.id, code: runtime.failure.code, incarnation: runtime.failure.incarnation, message: runtime.failure.message });
		}
		for (const issue of issues) this.failureEmitter.fire({ extensionId: issue.extensionId, code: "unsupportedRegistrationBridge", incarnation: undefined, message: issue.message });
	}

	private failRefresh(error: unknown): void {
		runWithBufferedEvents(() => {
			this.failureEmitter.fire({ extensionId: undefined, code: "extensionHostRefreshFailed", incarnation: undefined, message: errorMessage(error) });
			this.setState(this.activeContributions ? "degraded" : "failed");
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

	private projectOutput(snapshot: ExtensionHostFleetSnapshot): void {
		if (!this.options.output) return;
		const activeExtensions = new Set(snapshot.extensions.map(runtime => runtime.id));
		for (const extensionId of this.namedOutputCursors.keys()) {
			if (!activeExtensions.has(extensionId)) this.disposeNamedOutputChannels(extensionId);
		}
		for (const runtime of snapshot.extensions) {
			const channel = this.extensionOutput(runtime.id);
			const previous = this.outputCursors.get(runtime.id);
			if (!previous || previous.incarnation !== runtime.incarnation || previous.lifecycle !== runtime.lifecycle) {
				channel.appendLine({ severity: runtimeLifecycleSeverity(runtime.lifecycle), category: "lifecycle", text: runtimeLifecycleMessage(runtime) });
			}
			const stderrStart = previous && previous.incarnation === runtime.incarnation && runtime.stderr.length >= previous.stderrLength ? previous.stderrLength : 0;
			const stderrDelta = runtime.stderr.slice(stderrStart);
			if (stderrDelta) channel.append({ severity: "log", category: "stderr", text: stderrDelta });
			const failureKey = runtime.failure ? `${runtime.failure.code}\0${runtime.failure.incarnation ?? ""}\0${runtime.failure.message}` : "";
			if (runtime.failure && failureKey !== previous?.failureKey) channel.appendLine({ severity: "error", category: "lifecycle", text: `${runtime.failure.code}: ${runtime.failure.message}` });
			this.outputCursors.set(runtime.id, { incarnation: runtime.incarnation, lifecycle: runtime.lifecycle, stderrLength: runtime.stderr.length, failureKey });
			this.projectNamedOutput(runtime);
		}
	}

	private projectNamedOutput(runtime: ExtensionHostRuntime): void {
		const previous = this.namedOutputCursors.get(runtime.id);
		const reset = previous !== undefined && previous.activationGeneration !== runtime.activationGeneration;
		if (reset) this.disposeNamedOutputChannels(runtime.id);
		const initial = previous === undefined || reset;
		let sequence = reset ? 0 : previous?.sequence ?? 0;
		for (const event of runtime.outputEvents) {
			if (event.activationGeneration !== runtime.activationGeneration || event.sequence <= sequence) continue;
			sequence = event.sequence;
			const operation = event.operation;
			const key = namedOutputKey(runtime.id, operation.channelId);
			if (operation.operation === "create") {
				const existing = this.namedOutputChannels.get(key);
				if (existing && existing.label === operation.label && existing.kind === operation.kind) continue;
				existing?.channel.dispose();
				const channel = this._register(this.options.output!.createChannel({ id: `extension.${encodeURIComponent(runtime.id)}.${encodeURIComponent(operation.channelId)}`, label: operation.label, kind: operation.kind, source: "extension", extensionId: runtime.id }));
				this.namedOutputChannels.set(key, { extensionId: runtime.id, channelId: operation.channelId, label: operation.label, kind: operation.kind, channel });
				continue;
			}
			const channel = this.namedOutputChannels.get(key)?.channel;
			if (!channel) {
				this.fleetOutput?.appendLine({ severity: "warning", category: "output", text: `${runtime.id} emitted '${operation.operation}' for unknown Output channel '${operation.channelId}'.` });
				continue;
			}
			if (operation.operation === "append") channel.append({ text: operation.text, severity: operation.severity, category: operation.category });
			else if (operation.operation === "replace") channel.replace({ text: operation.text, severity: operation.severity, category: operation.category });
			else if (operation.operation === "clear") channel.clear();
			else if (operation.operation === "show") {
				if (!initial) channel.show({ focus: operation.preserveFocus ? "preserve" : "take" });
			} else {
				channel.dispose();
				this.namedOutputChannels.delete(key);
			}
		}
		this.namedOutputCursors.set(runtime.id, { activationGeneration: runtime.activationGeneration, sequence });
	}

	private disposeNamedOutputChannels(extensionId: string): void {
		for (const [key, value] of this.namedOutputChannels) {
			if (value.extensionId !== extensionId) continue;
			value.channel.dispose();
			this.namedOutputChannels.delete(key);
		}
		this.namedOutputCursors.delete(extensionId);
	}

	private extensionOutput(extensionId: string): IOutputChannel {
		const existing = this.extensionOutputs.get(extensionId);
		if (existing) return existing;
		if (!this.options.output) throw new Error("Extension Host Output service is unavailable");
		const channel = this._register(this.options.output.createChannel({ id: `extension-host.${encodeURIComponent(extensionId)}`, label: `${extensionId} (Extension Host)`, kind: "log", source: "extension", extensionId }));
		this.extensionOutputs.set(extensionId, channel);
		return channel;
	}

}

function namedOutputKey(extensionId: string, channelId: string): string {
	return `${extensionId}\0${channelId}`;
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

function runtimeLifecycleSeverity(state: ExtensionHostRuntime["lifecycle"]): OutputEntrySeverity {
	if (state === "failed" || state === "crashLoop") return "error";
	if (state === "recovering") return "warning";
	return state === "ready" ? "information" : "log";
}

function runtimeLifecycleMessage(runtime: ExtensionHostRuntime): string {
	const incarnation = runtime.incarnation === undefined ? "" : ` (incarnation ${runtime.incarnation})`;
	return `Extension Host ${runtime.lifecycle}${incarnation}.`;
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

function unsupportedLanguageIssue(runtime: ExtensionHostRuntime, registration: ExtensionHostLanguageRegistration, operations: readonly string[]): BridgeIssue {
	return { extensionId: runtime.id, registrationId: registration.registrationId, message: `Language registration '${registration.registrationId}' operation(s) ${operations.join(", ")} were not projected because they do not yet have strict Workbench codecs; supported operations remain active` };
}

function mutableLanguageBatch(): { completions: NonNullable<LanguageProviderBatch["completions"]>[number][]; hovers: NonNullable<LanguageProviderBatch["hovers"]>[number][]; formatting: NonNullable<LanguageProviderBatch["formatting"]>[number][]; inlayHints: NonNullable<LanguageProviderBatch["inlayHints"]>[number][]; linkedEditing: NonNullable<LanguageProviderBatch["linkedEditing"]>[number][]; parameterHints: NonNullable<LanguageProviderBatch["parameterHints"]>[number][] } {
	return { completions: [], hovers: [], formatting: [], inlayHints: [], linkedEditing: [], parameterHints: [] };
}

function appendLanguageBatch(target: ReturnType<typeof mutableLanguageBatch>, source: LanguageProviderBatch): void {
	target.completions.push(...(source.completions ?? []));
	target.hovers.push(...(source.hovers ?? []));
	target.formatting.push(...(source.formatting ?? []));
	target.inlayHints.push(...(source.inlayHints ?? []));
	target.linkedEditing.push(...(source.linkedEditing ?? []));
	target.parameterHints.push(...(source.parameterHints ?? []));
}

function freezeLanguageBatch(value: ReturnType<typeof mutableLanguageBatch>): Required<LanguageProviderBatch> {
	return Object.freeze({ completions: Object.freeze(value.completions), hovers: Object.freeze(value.hovers), formatting: Object.freeze(value.formatting), inlayHints: Object.freeze(value.inlayHints), linkedEditing: Object.freeze(value.linkedEditing), parameterHints: Object.freeze(value.parameterHints) });
}

function mergeAction(current: RefreshAction | undefined, next: RefreshAction): RefreshAction {
	return current === "reconcile" || next === "reconcile" ? "reconcile" : "list";
}

function normalizeTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new TypeError("Extension Host invocation timeout is invalid");
	return value;
}

function combineSignals(first: AbortSignal, second: AbortSignal): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const abortFirst = (): void => controller.abort(first.reason);
	const abortSecond = (): void => controller.abort(second.reason);
	if (first.aborted) abortFirst();
	else first.addEventListener("abort", abortFirst, { once: true });
	if (second.aborted) abortSecond();
	else second.addEventListener("abort", abortSecond, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			first.removeEventListener("abort", abortFirst);
			second.removeEventListener("abort", abortSecond);
		},
	};
}

function errorMessage(error: unknown): string {
	return getErrorMessage(error).slice(0, 4096);
}

function reportExtensionHostError(error: unknown): void {
	console.error("Extension Host refresh failed", error);
}
