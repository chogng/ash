import { Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import type { CommandDefinition, CommandRegistration, CommandRegistry } from '../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostLanguageRegistration, type ExtensionHostRegistration, type ExtensionHostRuntime } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { ILanguageFeaturesService, type LanguageProviderBatch, type LanguageProviderBatchRegistration } from '../../../editor/common/services/languageFeatures.js';
import { ITaskService, type TaskProvider, type TaskProviderRegistration } from '../../services/tasks/common/taskService.js';
import { ITestingService, type TestProfileProvider, type TestProfileProviderRegistration } from '../../services/testing/common/testingService.js';
import { IOutputService, type IOutputChannel, type OutputEntrySeverity } from '../../services/output/common/outputService.js';
import { createExtensionHostLanguageProviderBatch, extensionHostLanguageProviderId, unsupportedExtensionHostLanguageOperations, type ExtensionHostProviderInvoker } from './extensionHostLanguageBridge.js';
import { createExtensionHostTaskProvider, createExtensionHostTestProfileProvider, extensionHostCanonicalTaskId, extensionHostWorkflowProviderId } from './extensionHostWorkflowBridge.js';

export interface ExtensionApiIssue {
	readonly extensionId: string;
	readonly registrationId: string;
	readonly message: string;
}

interface ContributionSet {
	readonly commands: readonly CommandDefinition[];
	readonly languages: Required<LanguageProviderBatch>;
	readonly tasks: readonly TaskProvider[];
	readonly tests: readonly TestProfileProvider[];
	readonly issues: readonly ExtensionApiIssue[];
	readonly controller: AbortController;
}

interface ExtensionOutputCursor {
	readonly incarnation: number | undefined;
	readonly lifecycle: ExtensionHostRuntime["lifecycle"];
	readonly stderrLength: number;
	readonly failureKey: string;
}

interface ExtensionNamedOutputCursor {
	readonly incarnation: number | undefined;
	readonly activationGeneration: number;
	readonly sequence: number;
}

/** Applies executable-extension registrations to Workbench services for one host connection. */
export class MainThreadExtensionApi extends Disposable {
	private readonly commandRegistration: CommandRegistration;
	private readonly languageRegistration: LanguageProviderBatchRegistration;
	private readonly taskRegistration: TaskProviderRegistration;
	private readonly testRegistration: TestProfileProviderRegistration;
	private activeContributions: ContributionSet | undefined;
	private readonly extensionOutputs = this._register(new DisposableMap<string, IOutputChannel>());
	private readonly outputCursors = new Map<string, ExtensionOutputCursor>();
	private readonly namedOutputChannels = this._register(new DisposableMap<string, IOutputChannel>());
	private readonly namedOutputCursors = new Map<string, ExtensionNamedOutputCursor>();

	constructor(
		commands: CommandRegistry,
		private readonly invocationTimeoutMillis: number,
		private readonly fleetOutput: IOutputChannel,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@ITaskService tasks: ITaskService,
		@ITestingService testing: ITestingService,
		@IOutputService private readonly outputService: IOutputService,
	) {
		super();
		this.commandRegistration = this._register(commands.registerMany([]));
		this.languageRegistration = this._register(languageFeatures.registerProviderBatch({}));
		this.taskRegistration = this._register(tasks.registerTaskProviders([]));
		this.testRegistration = this._register(testing.registerTestProfileProviders([]));
		this._register(toDisposable(() => {
			this.activeContributions?.controller.abort('Extension API was disposed');
			this.activeContributions = undefined;
			this.outputCursors.clear();
			this.namedOutputCursors.clear();
		}));
	}

	public get hasContributions(): boolean {
		return this.activeContributions !== undefined;
	}

	public update(snapshot: ExtensionHostFleetSnapshot): readonly ExtensionApiIssue[] {
		this.assertNotDisposed();
		const contributions = this.buildContributions(snapshot);
		try {
			this.replaceContributions(contributions);
		} catch (error) {
			contributions.controller.abort(error);
			throw error;
		}
		this.projectOutput(snapshot);
		return contributions.issues;
	}

	public clear(): void {
		this.assertNotDisposed();
		this.revokeContributions();
		for (const key of this.namedOutputChannels.keys()) {
			this.namedOutputChannels.deleteAndDispose(key);
		}
		this.namedOutputCursors.clear();
	}

	private buildContributions(snapshot: ExtensionHostFleetSnapshot): ContributionSet {
		const controller = new AbortController();
		const commands: CommandDefinition[] = [];
		const languages = mutableLanguageBatch();
		const tasks: TaskProvider[] = [];
		const tests: TestProfileProvider[] = [];
		const issues: ExtensionApiIssue[] = [];
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
				combined.signal.throwIfAborted();
				const result = await this.api.invoke({
					extensionId: runtime.id,
					registrationId: registration.registrationId,
					activationGeneration: runtime.activationGeneration,
					incarnation: runtime.incarnation,
					operation,
					payload,
					deadlineUnixMillis: Date.now() + this.invocationTimeoutMillis,
				}, combined.signal);
				combined.signal.throwIfAborted();
				return result;
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

	private projectOutput(snapshot: ExtensionHostFleetSnapshot): void {
		const activeExtensions = new Set(snapshot.extensions.filter(runtime => runtime.lifecycle === 'ready').map(runtime => runtime.id));
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
			if (runtime.lifecycle === 'ready') this.projectNamedOutput(runtime);
		}
	}

	private projectNamedOutput(runtime: ExtensionHostRuntime): void {
		const previous = this.namedOutputCursors.get(runtime.id);
		const reset = previous !== undefined && (previous.activationGeneration !== runtime.activationGeneration || previous.incarnation !== runtime.incarnation);
		if (reset) this.disposeNamedOutputChannels(runtime.id);
		const initial = previous === undefined || reset;
		let sequence = reset ? 0 : previous?.sequence ?? 0;
		for (const event of runtime.outputEvents) {
			if (event.activationGeneration !== runtime.activationGeneration || event.incarnation !== runtime.incarnation || event.sequence <= sequence) continue;
			sequence = event.sequence;
			const operation = event.operation;
			const key = namedOutputKey(runtime.id, operation.channelId);
			if (operation.operation === "create") {
				const existing = this.namedOutputChannels.get(key);
				if (existing && existing.label === operation.label && existing.kind === operation.kind) continue;
				this.namedOutputChannels.deleteAndDispose(key);
				const channel = this.outputService.createChannel({ id: `extension.${encodeURIComponent(runtime.id)}.${encodeURIComponent(operation.channelId)}`, label: operation.label, kind: operation.kind, source: "extension", extensionId: runtime.id });
				this.namedOutputChannels.set(key, channel);
				continue;
			}
			const channel = this.namedOutputChannels.get(key);
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
				this.namedOutputChannels.deleteAndDispose(key);
			}
		}
		this.namedOutputCursors.set(runtime.id, { activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, sequence });
	}

	private disposeNamedOutputChannels(extensionId: string): void {
		for (const [key, value] of this.namedOutputChannels) {
			if (value.descriptor.extensionId !== extensionId) continue;
			this.namedOutputChannels.deleteAndDispose(key);
		}
		this.namedOutputCursors.delete(extensionId);
	}

	private extensionOutput(extensionId: string): IOutputChannel {
		const existing = this.extensionOutputs.get(extensionId);
		if (existing) return existing;
		const channel = this.outputService.createChannel({ id: `extension-host.${encodeURIComponent(extensionId)}`, label: `${extensionId} (Extension Host)`, kind: "log", source: "extension", extensionId });
		this.extensionOutputs.set(extensionId, channel);
		return channel;
	}

}

function namedOutputKey(extensionId: string, channelId: string): string {
	return `${extensionId}\0${channelId}`;
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

function unsupportedLanguageIssue(runtime: ExtensionHostRuntime, registration: ExtensionHostLanguageRegistration, operations: readonly string[]): ExtensionApiIssue {
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
