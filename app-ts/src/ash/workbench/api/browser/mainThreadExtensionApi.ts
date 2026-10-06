import { localize } from '../../../nls.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { MenuId, MenusRegistry, type IMenuItem } from '../../../platform/actions/common/actions.js';
import type { CommandDefinition, CommandRegistration, CommandRegistry } from '../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostLanguageRegistration, type ExtensionHostRegistration, type ExtensionHostRuntime } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { ILanguageFeaturesService, type LanguageProviderBatch, type LanguageProviderBatchRegistration } from '../../../editor/common/services/languageFeatures.js';
import { ITaskService, type TaskProvider, type TaskProviderRegistration } from '../../services/tasks/common/taskService.js';
import { ITestingService, type TestProfileProvider, type TestProfileProviderRegistration } from '../../services/testing/common/testingService.js';
import { IOutputService, type IOutputChannel, type OutputEntrySeverity } from '../../services/output/common/output.js';
import { createExtensionHostLanguageProviderBatch, extensionHostLanguageProviderId, unsupportedExtensionHostLanguageOperations, type ExtensionHostProviderInvoker } from './extensionHostLanguageBridge.js';
import { createExtensionHostTaskProvider, createExtensionHostTestProfileProvider, extensionHostCanonicalTaskId, extensionHostWorkflowProviderId } from './extensionHostWorkflowBridge.js';
import { MainThreadCustomEditors } from './mainThreadCustomEditors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { parseContextKeyExpression } from '../../../platform/contextkey/common/contextKeyExpressionParser.js';
import { Icon } from '../../../base/common/icon.js';
import { IEditorPart } from '../../browser/parts/editor/editorPart.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService, ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { IFileTextModelService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { IBulkEditService, ResourceTextEdit } from '../../../editor/browser/services/bulkEditService.js';
import { INotificationService, NotificationSeverity } from '../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../base/common/uri.js';
import { Range } from '../../../editor/common/core/range.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import type { ITextModel } from '../../../editor/common/model.js';
import type { ExtensionClientOperation, ExtensionClientResult, ExtensionDocumentSnapshot } from '../../../platform/extensionHost/common/extensionHostApi.js';

export interface ExtensionApiIssue {
	readonly extensionId: string;
	readonly registrationId: string;
	readonly message: string;
}

interface ContributionSet {
	readonly menus: readonly { readonly id: MenuId; readonly item: IMenuItem; }[];
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
	private readonly commandMenus = this._register(new DisposableStore());
	private readonly languageRegistration: LanguageProviderBatchRegistration;
	private readonly taskRegistration: TaskProviderRegistration;
	private readonly testRegistration: TestProfileProviderRegistration;
	private activeContributions: ContributionSet | undefined;
	private activationController = new AbortController();
	private readonly extensionOutputs = this._register(new DisposableMap<string, IOutputChannel>());
	private readonly outputCursors = new Map<string, ExtensionOutputCursor>();
	private readonly namedOutputChannels = this._register(new DisposableMap<string, IOutputChannel>());
	private readonly namedOutputCursors = new Map<string, ExtensionNamedOutputCursor>();
	private readonly customEditors: MainThreadCustomEditors;

	constructor(
		commands: CommandRegistry,
		private readonly invocationTimeoutMillis: number,
		private readonly fleetOutput: IOutputChannel,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@ITaskService tasks: ITaskService,
		@ITestingService testing: ITestingService,
		@IOutputService private readonly outputService: IOutputService,
		@IInstantiationService instantiation: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@ITextModelService private readonly textModels: ITextModelService,
		@IBulkEditService private readonly bulkEdits: IBulkEditService,
		@INotificationService private readonly notifications: INotificationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		const clientHandler = this.api.registerClientHandler((operation, signal) => this.handleClientOperation(operation, signal));
		this._register(toDisposable(() => clientHandler.dispose()));
		this.customEditors = this._register(instantiation.createInstance(MainThreadCustomEditors, this.invocationTimeoutMillis));
		this.commandRegistration = this._register(commands.registerMany([]));
		this.languageRegistration = this._register(languageFeatures.registerProviderBatch({}));
		this.taskRegistration = this._register(tasks.registerTaskProviders([]));
		this.testRegistration = this._register(testing.registerTestProfileProviders([]));
		this._register(toDisposable(() => {
			this.activationController.abort('Extension API was disposed');
			this.activeContributions?.controller.abort('Extension API was disposed');
			this.activeContributions = undefined;
			this.outputCursors.clear();
			this.namedOutputCursors.clear();
		}));
	}

	public get hasContributions(): boolean {
		return this.activeContributions !== undefined;
	}

	private async handleClientOperation(operation: ExtensionClientOperation, signal: AbortSignal): Promise<ExtensionClientResult> {
		this.assertNotDisposed();
		throwIfCancelled(signal);
		switch (operation.operation) {
			case 'executeCommand': {
				const value = await this.commandService.executeCommand(operation.command, ...operation.arguments);
				return { result: 'command', value: value === undefined ? null : normalizeExtensionHostPayload(value) };
			}
			case 'listDocuments':
				return { result: 'documents', documents: this.models.getModels().map(extensionDocumentSnapshot) };
			case 'readDocument': {
				const reference = await this.textModels.createModelReference(URI.parse(operation.uri));
				try {
					throwIfCancelled(signal);
					return { result: 'document', document: extensionDocumentSnapshot(reference.object.textEditorModel) };
				} finally {
					reference.dispose();
				}
			}
			case 'applyEdit': {
				const edits = operation.documents.flatMap(document => document.edits.map(edit => {
					if (!Number.isSafeInteger(document.version) || document.version < 1 ||
						[edit.start.line, edit.start.character, edit.end.line, edit.end.character].some(value => !Number.isSafeInteger(value) || value < 0) ||
						edit.start.line > edit.end.line || edit.start.line === edit.end.line && edit.start.character > edit.end.character) {
						throw new TypeError('Extension edit requires a version and an ordered UTF-16 range');
					}
					return new ResourceTextEdit(URI.parse(document.uri), {
						range: new Range(edit.start.line + 1, edit.start.character + 1, edit.end.line + 1, edit.end.character + 1),
						text: edit.text,
					}, document.version);
				}));
				const result = await this.bulkEdits.apply(edits, { token: signal });
				return { result: 'applied', applied: result.isApplied };
			}
			case 'readConfiguration': {
				const value = this.configuration.getValue(operation.section, operation.resource === null ? {} : { resource: URI.parse(operation.resource) });
				return { result: 'configuration', value: value === undefined ? null : normalizeExtensionHostPayload(value) };
			}
			case 'updateConfiguration':
				await this.configuration.updateValue(operation.section, operation.value, operation.target === 'user' ? ConfigurationTarget.USER_LOCAL : ConfigurationTarget.WORKSPACE);
				return { result: 'done' };
			case 'showMessage':
				this.notifications.notify({ message: operation.message, severity: operation.severity === 'information' ? NotificationSeverity.Info : operation.severity === 'warning' ? NotificationSeverity.Warning : NotificationSeverity.Error });
				return { result: 'done' };
			case 'showQuickPick':
				return this.showQuickPick(operation.items, operation.placeholder, signal);
		}
	}

	private showQuickPick(items: readonly string[], placeholder: string, signal: AbortSignal): Promise<ExtensionClientResult> {
		const pick = this.quickInput.createQuickPick<{ label: string; index: number; }>();
		const listeners = new DisposableStore();
		return new Promise<ExtensionClientResult>((resolve, reject) => {
			const finish = (index: number | null): void => resolve({ result: 'selection', index });
			const cancel = (): void => { reject(new CancellationError()); pick.hide(); };
			listeners.add(pick.onDidAccept(item => { finish(item.index); pick.hide(); }));
			listeners.add(pick.onDidHide(() => finish(null)));
			signal.addEventListener('abort', cancel, { once: true });
			listeners.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
			pick.items = items.map((label, index) => ({ label, index }));
			pick.ariaLabel = placeholder;
			pick.placeholder = placeholder;
			pick.show();
		}).finally(() => { listeners.dispose(); pick.dispose(); });
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
		this.customEditors.update(snapshot);
		return contributions.issues;
	}

	public clear(): void {
		this.assertNotDisposed();
		this.activationController.abort();
		this.activationController = new AbortController();
		this.revokeContributions();
		this.customEditors.clear();
		for (const key of this.namedOutputChannels.keys()) {
			this.namedOutputChannels.deleteAndDispose(key);
		}
		this.namedOutputCursors.clear();
	}

	private buildContributions(snapshot: ExtensionHostFleetSnapshot): ContributionSet {
		const controller = new AbortController();
		const commands: CommandDefinition[] = [];
		const menus: { id: MenuId; item: IMenuItem; }[] = [];
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
			if (runtime.lifecycle === 'dormant') {
				const signal = this.activationController.signal;
				for (const command of runtime.activation!.commands) {
					commands.push({
						id: command.command, metadata: { description: command.title }, handler: async (_accessor, ...args) => {
							signal.throwIfAborted();
							const activated = await this.api.activateByEvent({ extensionId: runtime.id, activationGeneration: runtime.activationGeneration, event: { type: 'command', command: command.command } });
							signal.throwIfAborted();
							const current = activated.extensions.find(candidate => candidate.id === runtime.id && candidate.activationGeneration === runtime.activationGeneration && candidate.lifecycle === 'ready');
							const registration = current?.registrations.find(candidate => candidate.kind === 'command' && candidate.command === command.command);
							if (!current || !registration) { throw new Error(localize({ bundle: 'ash.workbench', key: 'missingCommandAfterActivation' }, "Extension command '{0}' was not registered after activation.", command.command)); }
							// Activating replaces process registrations. This command retains the connection
							// lifetime signal and uses the new process fence, rather than the retired batch.
							return this.registrationInvoker(current, registration, signal)('execute', normalizeExtensionHostPayload({ arguments: args }), signal);
						}
					});
				}
			}
			if (runtime.lifecycle !== "ready" || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind === 'customTextEditor' || registration.kind === 'dataChannel' || registration.kind === 'linkPresentationProvider' || registration.kind === 'externalUriOpener') {
					continue;
				}
				const invoke = this.registrationInvoker(runtime, registration, controller.signal);
				if (registration.kind === "command") {
					commands.push(Object.freeze({
						id: registration.command, metadata: { description: registration.title }, handler: (accessor: ServicesAccessor, ...args: readonly unknown[]) => {
							if (!registration.menus?.some(placement => placement.menu.startsWith('editor/'))) {
								return invoke('execute', normalizeExtensionHostPayload({ arguments: args }), controller.signal);
							}
							const part = accessor.get(IEditorPart);
							const context = args[0] as { groupId?: string; editorIndex?: number; } | undefined;
							const group = typeof context?.groupId === 'string' ? part.groups.find(group => group.id === context.groupId) : part.activeGroup;
							const input = typeof context?.editorIndex === 'number' ? group?.inputs[context.editorIndex] : group?.activeInput;
							return invoke('execute', normalizeExtensionHostPayload({ arguments: args, activeEditor: input ? { resource: input.resource.toJSON(), groupId: group!.id, editorIndex: group!.inputs.indexOf(input) } : null }), controller.signal);
						}
					}));
					for (const placement of registration.menus ?? []) {
						const [group, orderText] = (placement.group ?? '').split('@');
						const order = orderText === undefined ? undefined : Number(orderText);
						if (order !== undefined && !Number.isFinite(order)) {
							throw new TypeError(`Invalid menu order for extension command '${registration.command}'`);
						}
						const alternate = runtime.registrations.find(candidate => candidate.kind === 'command' && candidate.command === placement.alt);
						let id = MenuId.for(placement.menu);
						if (placement.menu === 'editor/title') {
							id = MenuId.EditorTitle;
						} else if (placement.menu === 'editor/title/context') {
							id = MenuId.EditorTitleContext;
						}
						menus.push({
							id, item: {
								command: { id: registration.command, title: registration.title, icon: registration.icon ? Icon.fromId(registration.icon) : undefined },
								alt: alternate?.kind === 'command' ? { id: alternate.command, title: alternate.title, icon: alternate.icon ? Icon.fromId(alternate.icon) : undefined } : undefined,
								when: placement.when ? parseContextKeyExpression(placement.when) : undefined,
								group,
								order,
							}
						});
					}
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
		return Object.freeze({ menus: Object.freeze(menus), commands: Object.freeze(commands), languages: freezeLanguageBatch(languages), tasks: Object.freeze(tasks), tests: Object.freeze(tests), issues: Object.freeze(issues), controller });
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
				this.commandMenus.clear();
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
		this.commandMenus.clear();
		for (const command of next.commands) {
			this.commandMenus.add(MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: command.id, title: command.metadata!.description } }));
		}
		// Menu declarations belong to the activated package, and disappear with its command authority.
		this.commandMenus.add(MenusRegistry.appendMenuItems(next.menus));
		previous?.controller.abort("Extension Host fleet generation was replaced");
	}

	private revokeContributions(): void {
		const active = this.activeContributions;
		this.activeContributions = undefined;
		this.commandRegistration.replace([]);
		this.commandMenus.clear();
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

type MutableLanguageBatch = { -readonly [K in keyof Required<LanguageProviderBatch>]: NonNullable<LanguageProviderBatch[K]>[number][]; };

function mutableLanguageBatch(): MutableLanguageBatch {
	return {
		documentHighlights: [],
		completions: [],
		hovers: [],
		formatting: [],
		inlayHints: [],
		linkedEditing: [],
		parameterHints: [],
		syntax: [],
		workspaceSymbols: [],
		definitions: [],
		references: [],
		renames: [],
		documentSymbols: [],
		foldingRanges: [],
		documentLinks: [],
		codeActions: [],
		selectionRanges: [],
	};
}

function appendLanguageBatch(target: MutableLanguageBatch, source: LanguageProviderBatch): void {
	target.completions.push(...(source.completions ?? []));
	target.hovers.push(...(source.hovers ?? []));
	target.formatting.push(...(source.formatting ?? []));
	target.inlayHints.push(...(source.inlayHints ?? []));
	target.linkedEditing.push(...(source.linkedEditing ?? []));
	target.parameterHints.push(...(source.parameterHints ?? []));
	target.documentHighlights.push(...(source.documentHighlights ?? []));
	target.syntax.push(...(source.syntax ?? []));
	target.workspaceSymbols.push(...(source.workspaceSymbols ?? []));
	target.definitions.push(...(source.definitions ?? []));
	target.references.push(...(source.references ?? []));
	target.renames.push(...(source.renames ?? []));
	target.documentSymbols.push(...(source.documentSymbols ?? []));
	target.foldingRanges.push(...(source.foldingRanges ?? []));
	target.documentLinks.push(...(source.documentLinks ?? []));
	target.codeActions.push(...(source.codeActions ?? []));
	target.selectionRanges.push(...(source.selectionRanges ?? []));
}

function freezeLanguageBatch(value: MutableLanguageBatch): Required<LanguageProviderBatch> {
	return Object.freeze({
		documentHighlights: Object.freeze(value.documentHighlights),
		syntax: Object.freeze(value.syntax),
		workspaceSymbols: Object.freeze(value.workspaceSymbols),
		completions: Object.freeze(value.completions),
		hovers: Object.freeze(value.hovers),
		formatting: Object.freeze(value.formatting),
		inlayHints: Object.freeze(value.inlayHints),
		linkedEditing: Object.freeze(value.linkedEditing),
		parameterHints: Object.freeze(value.parameterHints),
		definitions: Object.freeze(value.definitions),
		references: Object.freeze(value.references),
		renames: Object.freeze(value.renames),
		documentSymbols: Object.freeze(value.documentSymbols),
		foldingRanges: Object.freeze(value.foldingRanges),
		documentLinks: Object.freeze(value.documentLinks),
		codeActions: Object.freeze(value.codeActions),
		selectionRanges: Object.freeze(value.selectionRanges),
	});
}

function combineSignals(first: AbortSignal, second: AbortSignal): { readonly signal: AbortSignal; dispose(): void; } {
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

function extensionDocumentSnapshot(model: ITextModel): ExtensionDocumentSnapshot {
	return { uri: model.uri.toString(), version: model.getVersionId(), languageId: model.getLanguageId(), text: model.getValue() };
}
