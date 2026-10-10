import type { IDebugSession } from '../../services/debug/common/debugService.js';
import type { IDebugConfiguration } from '../../services/debug/common/debugService.js';
import { parseShellExecution, parseTaskEnvironment, parseTaskRunOptions, parseTaskPresentationOptions } from '../../services/tasks/common/workspaceTasks.js';
import { normalizeDebugAdapterDescriptor, type DebugAdapterFactory } from '../../services/debug/common/debugAdapterFactory.js';
import { encodeHex, VSBuffer } from "../../../base/common/buffer.js";
import type { JsonValue } from "../../../platform/extensionHost/common/extensionHostApi.js";
import type { IWorkspaceTask, TaskDefinition, TaskPseudoterminal, TaskProvider, TaskProviderTask, WorkspaceTaskGroup } from "../../services/tasks/common/taskService.js";
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise, TaskQueue } from '../../../base/common/async.js';
import { normalizeExtensionHostPayload } from '../../../platform/extensionHost/common/extensionHostApi.js';
import type { TestProfileContribution, TestProfileProvider } from "../../services/testing/common/testingService.js";
import type { ExtensionHostProviderInvoker } from "./extensionHostLanguageBridge.js";
import { DebugConfigurationProviderTriggerKind, type DebugConfiguration, type IDebugConfigurationProvider, type IDebugAdapterTracker, type IDebugAdapterTrackerFactory } from '../../services/debug/common/debugService.js';
import type { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';

/** Debug owns resolution order; this adapter owns only bounded Host callback data. */
export function createExtensionHostDebugConfigurationProvider(type: string, id: string, triggerKind: DebugConfigurationProviderTriggerKind, invoke: ExtensionHostProviderInvoker, workspace: IWorkspaceContextService): IDebugConfigurationProvider {
	const folderPayload = (resource: URI | undefined): JsonValue => {
		if (!resource) return null;
		const folder = workspace.getWorkspace().folders.find(candidate => candidate.uri.toString() === resource.toString());
		if (!folder) throw new Error('Debug configuration workspace folder is unavailable');
		return { uri: folder.uri.toString(), name: folder.name, index: folder.index };
	};
	const configuration = (value: JsonValue): DebugConfiguration => {
		const input = object(value, 'Extension Debug configuration');
		return Object.freeze({
			...input, name: boundedString(input.name, 'Debug configuration name', 256, false),
			type: boundedString(input.type, 'Debug configuration type', 128, false),
			request: textEnum(input.request, 'Debug configuration request', ['launch', 'attach'] as const),
		});
	};
	const resolve = async (operation: string, folder: URI | undefined, config: DebugConfiguration, signal: AbortSignal): Promise<DebugConfiguration | null | undefined> => {
		const result = object(await invoke(operation, normalizeExtensionHostPayload({ folder: folderPayload(folder), configuration: config }), signal), 'Extension Debug configuration resolution');
		if (result.cancelled === true) {
			assertAllowedKeys(result, 'Extension Debug configuration cancellation', ['cancelled'], ['cancelled']);
			return undefined;
		}
		assertAllowedKeys(result, 'Extension Debug configuration resolution', ['configuration'], ['configuration']);
		return result.configuration === null ? null : configuration(result.configuration);
	};
	return Object.freeze({
		id, type, triggerKind,
		provideDebugConfigurations: async (folder: URI | undefined, signal: AbortSignal) => {
			const result = exactObject(await invoke('provideDebugConfigurations', { folder: folderPayload(folder) }, signal), 'Extension Debug configuration templates', ['configurations']);
			return Object.freeze(boundedArray(result.configurations, 'Debug configuration templates', 64).map(configuration));
		},
		resolveDebugConfiguration: (folder: URI | undefined, config: DebugConfiguration, signal: AbortSignal) => resolve('resolveDebugConfiguration', folder, config, signal),
		resolveDebugConfigurationWithSubstitutedVariables: (folder: URI | undefined, config: DebugConfiguration, signal: AbortSignal) => resolve('resolveDebugConfigurationWithSubstitutedVariables', folder, config, signal),
	});
}

/** Both catalog queries and resolveTask expose the same current workspace metadata. */
export function extensionHostTaskSnapshot(task: IWorkspaceTask, workspace: IWorkspaceContextService): JsonValue {
	const folders = workspace.getWorkspace().folders;
	const folder = task.dirId ? folders.find(folder => folder.id === task.dirId)
		: URI.isUri(task.scope) ? folders.find(folder => folder.uri.toString() === task.scope!.toString())
			: task.scope === undefined && folders.length === 1 ? folders[0] : undefined;
	const unresolved = task.definition && task.unsupportedFeatures?.includes(`type:${task.definition.type}`);
	const execution = task.execution?.type === 'custom' ? { type: 'custom' }
		: task.execution ?? (!unresolved && task.command ? { type: 'shell', commandLine: task.command } : undefined);
	return normalizeExtensionHostPayload({
		id: task.id, clientTaskId: task.extensionTaskId ?? null, name: task.label,
		source: task.extensionSource ?? task.source,
		definition: task.definition ?? { type: task.execution?.type ?? 'shell', task: task.label },
		scope: typeof task.scope === 'number' ? task.scope : folder ? { uri: folder.uri.toString(), name: folder.name, index: folder.index } : 2,
		...(execution === undefined ? {} : { execution }),
		options: { ...(task.cwd === undefined ? {} : { cwd: task.cwd }), ...(task.environment === undefined ? {} : { env: task.environment }) },
		...(task.runOptions === undefined ? {} : { runOptions: task.runOptions.reevaluateOnRerun === undefined ? {} : { reevaluateOnRerun: task.runOptions.reevaluateOnRerun } }),
		...(task.presentation === undefined ? {} : { presentation: task.presentation }),
		group: task.group, ...(task.groupIsDefault === undefined ? {} : { groupIsDefault: task.groupIsDefault === true }), isBackground: task.isBackground ?? false,
		problemMatchers: task.problemMatchers ?? [], detail: task.detail ?? null,
	});
}

export function createExtensionHostTaskProvider(id: string, invoke: ExtensionHostProviderInvoker, workspace: IWorkspaceContextService, type?: string): TaskProvider {
	return Object.freeze({
		id, type,
		provideTasks: async (signal: AbortSignal): Promise<readonly TaskProviderTask[]> => normalizeTaskResult(await invoke("provideTasks", Object.freeze({}), signal), invoke),
		resolveTask: async (task: IWorkspaceTask, signal: AbortSignal): Promise<TaskProviderTask | undefined> => {
			const payload = { task: { ...object(extensionHostTaskSnapshot(task, workspace), 'Task snapshot'), label: task.label, command: task.command, ...(task.dirId ? { dirId: task.dirId } : {}) } };
			const value = await invoke('resolveTask', normalizeExtensionHostPayload(payload), signal);
			if (value === null) return undefined;
			const result = exactObject(value, 'Extension Task resolution', ['task']);
			return normalizeTaskResult({ tasks: [result.task!] }, invoke)[0];
		},
	});
}

/** A Host-broker callback supplies a descriptor; the existing Debug process owner starts it. */
export function createExtensionHostDebugAdapterFactory(type: string, sourceId: string, invoke: ExtensionHostProviderInvoker, workspace: IWorkspaceContextService): DebugAdapterFactory {
	return Object.freeze({
		type, label: type, sourceId,
		createDebugAdapterDescriptor: async (configuration: IDebugConfiguration, signal: AbortSignal, session: IDebugSession) => {
			const folder = workspace.getWorkspace().folders.find(value => value.id === configuration.dirId);
			const executable = configuration.adapter && !configuration.adapter.inline && !configuration.adapter.connection
				? configuration.adapter : undefined;
			const payload = {
				...(executable === undefined ? {} : { executable }),
				configuration: { ...configuration.arguments, name: configuration.name, type: configuration.type, request: configuration.request },
				session: { id: session.id, ...(session.parentSession ? { parentSessionId: session.parentSession.id } : {}), workspaceFolder: folder ? { uri: folder.uri.toString(), name: folder.name, index: folder.index } : null }, ...(configuration.dirId ? { dirId: configuration.dirId } : {}),
			};
			const returned = await invoke('createDebugAdapterDescriptor', normalizeExtensionHostPayload(payload), signal);
			if (returned === null) return undefined;
			const result = object(returned, 'Extension Debug Adapter descriptor');
			if (result.inlineAdapterId !== undefined) {
				assertAllowedKeys(result, 'Extension inline Debug Adapter', ['inlineAdapterId'], ['inlineAdapterId']);
				const inlineAdapterId = boundedString(result.inlineAdapterId, 'Inline Debug Adapter ID', 256, false);
				let closed = false;
				const lifetime = new AbortController();
				let closing: Promise<void> | undefined;
				const close = (): Promise<void> => closing ??= (async () => {
					closed = true;
					// Close remains admitted after descriptor retirement and gets its own deadline.
					await invoke('closeInlineDebugAdapter', { inlineAdapterId }, new AbortController().signal);
					// Canceling an admitted V8 call retires its entire isolate. A normal
					// close lets finite in-flight reads settle under their existing deadlines.
				})();
				return Object.freeze({
					inline: {
						async send(message: unknown): Promise<void> {
							if (closed) { throw new Error('Inline Debug Adapter is closed'); }
							await invoke('sendInlineDebugAdapter', normalizeExtensionHostPayload({ inlineAdapterId, message }), lifetime.signal);
						},
						async read(afterSequence: number, maxMessages: number) {
							if (closed) { throw new Error('Inline Debug Adapter is closed'); }
							const value = exactObject(await invoke('readInlineDebugAdapter', { inlineAdapterId, afterSequence, maxMessages }, lifetime.signal), 'Inline Debug Adapter messages', ['messages', 'nextSequence', 'exited', 'protocolError']);
							const messages = boundedArray(value.messages, 'Inline Debug Adapter messages', maxMessages).map(entry => {
								const message = exactObject(entry, 'Inline Debug Adapter message', ['sequence', 'message']);
								return Object.freeze({ sequence: nonNegativeInteger(message.sequence, 'Inline message sequence'), message: message.message });
							});
							const nextSequence = nonNegativeInteger(value.nextSequence, 'Inline read sequence');
							if (messages.some((message, index) => message.sequence !== afterSequence + index) || nextSequence !== afterSequence + messages.length || typeof value.exited !== 'boolean' || value.protocolError !== null && typeof value.protocolError !== 'string') { throw new TypeError('Invalid inline Debug Adapter read'); }
							return { messages, nextSequence, exited: value.exited, protocolError: value.protocolError as string | null, outputGap: false, stderr: '', exitCode: null };
						},
						close,
					}, arguments: Object.freeze([])
				});
			}
			if (result.connection !== undefined) {
				assertAllowedKeys(result, 'Extension Debug Adapter connection', ['connection'], ['connection']);
				return normalizeDebugAdapterDescriptor(result, 'Extension Debug Adapter');
			}
			assertAllowedKeys(result, 'Extension Debug Adapter descriptor', ['program', 'arguments', 'cwd', 'env'], ['program', 'arguments']);
			const env = result.env === undefined ? undefined : object(result.env, 'Extension Debug Adapter environment');
			if (env && (Object.keys(env).length > 128 || Object.entries(env).some(([key, value]) => !key || key.length > 256 || /[=\0]/.test(key) || value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))))) throw new TypeError('Invalid extension Debug Adapter environment');
			return Object.freeze({
				program: boundedString(result.program, 'Extension Debug Adapter program', 4096, false),
				arguments: Object.freeze(boundedArray(result.arguments, 'Extension Debug Adapter arguments', 256).map(value => boundedString(value, 'Extension Debug Adapter argument', 4096, true, false))),
				...(result.cwd === undefined ? {} : { cwd: boundedString(result.cwd, 'Extension Debug Adapter cwd', 32768, false, false) }),
				...(env === undefined ? {} : { env: Object.freeze(env as Record<string, string | null>) }),
			});
		},
	});
}

/** The session owns callback handles; the Host never owns DAP sequencing or processes. */
export function createExtensionHostDebugAdapterTrackerFactory(type: string, id: string, invoke: ExtensionHostProviderInvoker, workspace: IWorkspaceContextService): IDebugAdapterTrackerFactory {
	return Object.freeze({
		id, type,
		createDebugAdapterTracker: async (session: IDebugSession, signal: AbortSignal): Promise<IDebugAdapterTracker | undefined> => {
			const configuration = session.resolvedConfiguration ?? session.configuration;
			const folder = workspace.getWorkspace().folders.find(candidate => candidate.id === configuration.dirId);
			const payload = normalizeExtensionHostPayload({
				session: {
					id: session.id, type: configuration.type, name: session.name,
					...(session.parentSession ? { parentSessionId: session.parentSession.id } : {}),
					configuration: { ...configuration.arguments, name: configuration.name, type: configuration.type, request: configuration.request },
					workspaceFolder: folder ? { uri: folder.uri.toString(), name: folder.name, index: folder.index } : null,
				}
			});
			const value = await invoke('createDebugAdapterTracker', payload, signal);
			if (value === null) { return undefined; }
			const result = exactObject(value, 'Debug Adapter tracker handle', ['trackerId', 'operations']);
			const trackerId = boundedString(result.trackerId, 'Debug Adapter tracker ID', 256, false);
			const operations = boundedArray(result.operations, 'Debug Adapter tracker operations', 6).map(operation => textEnum(operation, 'Debug Adapter tracker operation', ['onWillStartSession', 'onWillReceiveMessage', 'onDidSendMessage', 'onWillStopSession', 'onError', 'onExit'] as const));
			if (new Set(operations).size !== operations.length) { throw new TypeError('Duplicate Debug Adapter tracker operation'); }
			const lifetime = new AbortController();
			let disposed = false;
			const callback = async (event: string, data: Readonly<Record<string, unknown>> = {}): Promise<void> => {
				if (disposed) { return; }
				await invoke('debugAdapterTrackerEvent', normalizeExtensionHostPayload({ trackerId, event, ...data }), lifetime.signal);
			};
			const release = toDisposable(() => {
				if (disposed) { return; }
				// Release uses a separate deadline after pending hooks are canceled.
				void invoke('debugAdapterTrackerEvent', { trackerId, event: 'dispose' }, new AbortController().signal).catch(() => { });
				disposed = true;
				lifetime.abort();
			});
			return Object.freeze(Object.assign(release, {
				...(operations.includes('onWillStartSession') ? { onWillStartSession: () => callback('onWillStartSession') } : {}),
				...(operations.includes('onWillReceiveMessage') ? { onWillReceiveMessage: (message: unknown) => callback('onWillReceiveMessage', { message }) } : {}),
				...(operations.includes('onDidSendMessage') ? { onDidSendMessage: (message: unknown) => callback('onDidSendMessage', { message }) } : {}),
				...(operations.includes('onWillStopSession') ? { onWillStopSession: () => callback('onWillStopSession') } : {}),
				...(operations.includes('onError') ? { onError: (error: Error) => callback('onError', { message: error.message, name: error.name }) } : {}),
				onExit: (code: number | undefined, exitSignal: string | undefined) => callback('onExit', { code: code ?? null, signal: exitSignal ?? null }),
			}));
		},
	});
}

export function createExtensionHostTestProfileProvider(id: string, invoke: ExtensionHostProviderInvoker, resolveTaskId: (providerRegistrationId: string, taskId: string) => string): TestProfileProvider {
	return Object.freeze({
		id,
		provideTestProfiles: async (signal: AbortSignal): Promise<readonly TestProfileContribution[]> => normalizeTestProfileResult(await invoke("provideTestProfiles", Object.freeze({}), signal), resolveTaskId),
	});
}

export function extensionHostWorkflowProviderId(extensionId: string, registrationId: string): string {
	return `extensionHost.${hexIdentifier(extensionId)}.${hexIdentifier(registrationId)}`;
}

export function extensionHostCanonicalTaskId(providerId: string, taskId: string): string {
	return `extension:${encodeURIComponent(providerId)}:${encodeURIComponent(taskId)}`;
}

export function normalizeTaskResult(value: JsonValue, invoke: ExtensionHostProviderInvoker): readonly TaskProviderTask[] {
	const result = exactObject(value, "Extension Task provider result", ["tasks"]);
	const tasks = boundedArray(result.tasks, "Extension Tasks", 10_000).map((task, index) => {
		const input = object(task, `Extension Task ${index}`);
		assertAllowedKeys(input, `Extension Task ${index}`, ["command", "detail", "env", "group", "groupIsDefault", "runOptions", "presentation", "id", "label", 'execution', 'definition', 'cwd', 'isBackground', 'problemMatchers', 'scope', 'source'], ["group", "id", "label"]);
		if (input.isBackground !== undefined && typeof input.isBackground !== 'boolean') throw new TypeError('Extension Task isBackground must be a boolean');
		if (input.groupIsDefault !== undefined && typeof input.groupIsDefault !== 'boolean') throw new TypeError('Extension Task groupIsDefault must be a boolean');
		const runOptions = input.runOptions === undefined ? undefined : object(input.runOptions, 'Extension Task runOptions');
		if (runOptions) assertAllowedKeys(runOptions, 'Extension Task runOptions', ['reevaluateOnRerun'], []);
		const presentation = input.presentation === undefined ? undefined : object(input.presentation, 'Extension Task presentation');
		if (presentation) assertAllowedKeys(presentation, 'Extension Task presentation', ['echo', 'showReuseMessage', 'panel', 'clear', 'reveal', 'revealProblems', 'focus', 'close'], []);
		let execution: TaskProviderTask['execution'];
		if (input.execution !== undefined) {
			const descriptor = object(input.execution, 'Extension Task execution');
			if (descriptor.type === 'process') {
				assertAllowedKeys(descriptor, 'Extension Task execution', ['type', 'program', 'args'], ['type', 'program', 'args']);
				execution = Object.freeze({ type: 'process', program: boundedString(descriptor.program, 'Extension Task process', 32768, false, false), args: Object.freeze(boundedArray(descriptor.args, 'Extension Task arguments', 1024).map(value => boundedString(value, 'Extension Task argument', 32768, true, false))) });
			} else if (descriptor.type === 'shell') {
				assertAllowedKeys(descriptor, 'Extension Task execution', ['type', 'commandLine', 'command', 'args', 'options'], ['type']);
				execution = parseShellExecution(descriptor);
			} else if (descriptor.type === 'custom') {
				assertAllowedKeys(descriptor, 'Extension Task execution', ['type', 'id'], ['type', 'id']);
				const executionId = boundedString(descriptor.id, 'Extension CustomExecution ID', 256, false);
				execution = Object.freeze({ type: 'custom', callback: (definition: TaskDefinition) => ExtensionTaskTerminal.create(invoke, executionId, definition) });
			} else {
				throw new TypeError('Unsupported Extension Task execution');
			}
		}
		let scope: TaskProviderTask['scope'];
		if (input.scope === 1 || input.scope === 2) scope = input.scope;
		else if (input.scope !== undefined) {
			const folder = exactObject(input.scope, 'Extension Task scope', ['uri']);
			scope = URI.parse(boundedString(folder.uri, 'Extension Task scope URI', 8192, false));
		}
		const definition = input.definition === undefined ? undefined : object(input.definition, 'Extension Task definition');
		if (definition && typeof definition.type !== 'string') throw new TypeError('Extension Task definition requires a type');
		return Object.freeze({
			...(scope === undefined ? {} : { scope }),
			...(input.source === undefined ? {} : { source: boundedString(input.source, 'Extension Task source', 256, false) }),
			...(input.env === undefined ? {} : { environment: parseTaskEnvironment(input.env) }),
			id: boundedString(input.id, `Extension Task ${index} ID`, 256, false),
			label: boundedString(input.label, `Extension Task ${index} label`, 256, false),
			...(input.command === undefined ? {} : { command: boundedString(input.command, `Extension Task ${index} command`, 32_768, false, false) }),
			...(execution === undefined ? {} : { execution }),
			...(input.isBackground === undefined ? {} : { isBackground: input.isBackground }),
			...(input.problemMatchers === undefined ? {} : { problemMatchers: Object.freeze([...boundedArray(input.problemMatchers, 'Extension Task problemMatchers', 32)]) }),
			...(definition === undefined ? {} : { definition: Object.freeze({ ...definition, type: definition.type as string }) }),
			...(input.cwd === undefined ? {} : { cwd: boundedString(input.cwd, 'Extension Task cwd', 32768, false, false) }),
			group: textEnum(input.group, `Extension Task ${index} group`, ["build", "test", "clean", "rebuild", "run", "other"] as const) as WorkspaceTaskGroup,
			...(input.groupIsDefault === undefined ? {} : { groupIsDefault: input.groupIsDefault }),
			...(runOptions === undefined ? {} : { runOptions: parseTaskRunOptions(runOptions) }),
			...(presentation === undefined ? {} : { presentation: parseTaskPresentationOptions(presentation) }),
			...(input.detail === undefined ? {} : { detail: boundedString(input.detail, `Extension Task ${index} detail`, 4096, true) }),
		});
	});
	assertUnique(tasks.map(task => task.id), "Extension Task IDs");
	return Object.freeze(tasks);
}

/** Owns a provider's opaque PTY handle and serializes its events without creating a backend shell. */
class ExtensionTaskTerminal extends Disposable implements TaskPseudoterminal {
	private readonly writeEmitter = this._register(new Emitter<string>());
	private readonly closeEmitter = this._register(new Emitter<number | void>());
	private readonly nameEmitter = this._register(new Emitter<string>());
	private readonly queue = new TaskQueue();
	private readonly released = new DeferredPromise<void>();
	readonly releaseCompletion = this.released.p;
	private readonly signal = new AbortController().signal;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private opened = false;
	private closed = false;
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;
	readonly handleInput: ((data: string) => void) | undefined;

	private constructor(private readonly invoke: ExtensionHostProviderInvoker, private readonly ptyId: string, acceptsInput: boolean) {
		super();
		void this.releaseCompletion.catch(() => undefined);
		this.handleInput = acceptsInput ? data => this.dispatch('inputTaskTerminal', { data }) : undefined;
	}

	static async create(invoke: ExtensionHostProviderInvoker, executionId: string, definition: TaskDefinition): Promise<ExtensionTaskTerminal> {
		const result = exactObject(await invoke('createTaskTerminal', normalizeExtensionHostPayload({ executionId, definition }), new AbortController().signal), 'Extension custom terminal', ['ptyId', 'acceptsInput']);
		if (typeof result.acceptsInput !== 'boolean') throw new TypeError('Invalid custom terminal input capability');
		return new ExtensionTaskTerminal(invoke, boundedString(result.ptyId, 'Extension terminal ID', 256, false), result.acceptsInput);
	}

	open(dimensions: { readonly columns: number; readonly rows: number; } | undefined): void {
		if (this.opened || this.closed) return;
		this.opened = true;
		this.dispatch('openTaskTerminal', { dimensions: dimensions ?? null });
		this.poll();
	}

	setDimensions(dimensions: { readonly columns: number; readonly rows: number; }): void { this.dispatch('resizeTaskTerminal', { dimensions }); }
	close(): void { this.dispose(); }

	private dispatch(operation: string, payload: JsonValue): void {
		if (this.closed) return;
		void this.queue.schedule(async () => {
			if (this.closed) return;
			const result = exactObject(await this.invoke(operation, { ...object(payload, 'Terminal request'), ptyId: this.ptyId }, this.signal), 'Extension terminal events', ['events']);
			for (const value of boundedArray(result.events, 'Extension terminal events', 1024)) {
				if (this.closed) break;
				const event = object(value, 'Extension terminal event');
				if (event.type === 'data') this.writeEmitter.fire(boundedString(event.data, 'Extension terminal data', 262144, true, false));
				else if (event.type === 'name') this.nameEmitter.fire(boundedString(event.name, 'Extension terminal name', 4096, false));
				else if (event.type === 'close') {
					if (event.code !== null && (!Number.isSafeInteger(event.code) || (event.code as number) < 0 || (event.code as number) > 2147483647)) throw new TypeError('Invalid extension terminal exit code');
					try { this.closeEmitter.fire(event.code === null ? undefined : event.code as number); } finally { this.dispose(); }
				} else throw new TypeError('Invalid extension terminal event');
			}
		}).catch(() => {
			if (!this.closed) { try { this.closeEmitter.fire(1); } finally { this.dispose(); } }
		});
	}

	private poll(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed) return;
			this.dispatch('readTaskTerminal', {});
			// Wait for this read to retire; a slow extension cannot grow the polling queue.
			void this.queue.schedule(() => { if (!this.closed) this.poll(); }).catch(() => { /* Closing the terminal clears queued polls. */ });
		}, 40);
	}

	protected override disposeCore(): void {
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.queue.clearPending();
		// Do not cancel a short in-flight read: cancellation retires the entire extension isolate.
		void this.queue.schedule(() => this.invoke('closeTaskTerminal', { ptyId: this.ptyId }, this.signal)).then(
			() => this.released.complete(undefined),
			error => this.released.error(error),
		);
		super.disposeCore();
	}
}

function normalizeTestProfileResult(value: JsonValue, resolveTaskId: (providerRegistrationId: string, taskId: string) => string): readonly TestProfileContribution[] {
	const result = exactObject(value, "Extension Test Profile provider result", ["profiles"]);
	const profiles = boundedArray(result.profiles, "Extension Test Profiles", 10_000).map((profile, index) => {
		const input = object(profile, `Extension Test Profile ${index}`);
		assertAllowedKeys(input, `Extension Test Profile ${index}`, ["detail", "id", "label", "taskId", "taskProviderRegistrationId"], ["id", "label", "taskId", "taskProviderRegistrationId"]);
		const taskReference = boundedString(input.taskId, `Extension Test Profile ${index} task ID`, 1024, false);
		const taskProviderRegistrationId = boundedString(input.taskProviderRegistrationId, `Extension Test Profile ${index} Task provider registration ID`, 256, false);
		return Object.freeze({
			id: boundedString(input.id, `Extension Test Profile ${index} ID`, 256, false),
			label: boundedString(input.label, `Extension Test Profile ${index} label`, 256, false),
			taskId: resolveTaskId(taskProviderRegistrationId, taskReference),
			...(input.detail === undefined ? {} : { detail: boundedString(input.detail, `Extension Test Profile ${index} detail`, 4096, true) }),
		});
	});
	assertUnique(profiles.map(profile => profile.id), "Extension Test Profile IDs");
	return Object.freeze(profiles);
}

function exactObject(value: JsonValue, owner: string, keys: readonly string[]): Record<string, JsonValue> {
	const result = object(value, owner);
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${owner} has an invalid shape`);
	return result;
}

function object(value: JsonValue, owner: string): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, JsonValue>;
}

function assertAllowedKeys(value: Record<string, JsonValue>, owner: string, allowed: readonly string[], required: readonly string[]): void {
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${owner} has an invalid shape`);
}

function boundedArray(value: JsonValue | undefined, owner: string, maximum: number): readonly JsonValue[] {
	if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedString(value: JsonValue | undefined, owner: string, maximum: number, allowEmpty: boolean, trim = true): string {
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} is invalid`);
	return trim ? value.trim() : value;
}

function textEnum<const T extends readonly string[]>(value: JsonValue | undefined, owner: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function assertUnique(values: readonly string[], owner: string): void {
	if (new Set(values).size !== values.length) throw new TypeError(`${owner} must be unique`);
}

function hexIdentifier(value: string): string {
	return encodeHex(VSBuffer.fromString(value));
}

function nonNegativeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) { throw new TypeError(`${owner} must be a nonnegative safe integer`); }
	return value as number;
}
