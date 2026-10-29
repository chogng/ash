import { TaskQuickPick } from './taskQuickPick.js';
import { getTemplates, type ITaskEntry } from '../common/taskTemplates.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import {
	IInstantiationService,
	type ServicesAccessor,
} from '../../../../platform/instantiation/common/instantiation.js';
import type { TerminalTaskSystem } from './terminalTaskSystem.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { Action2, registerAction2, MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CancellationError, getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { DeferredPromise, raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import {
	FileKind,
	FileNotFoundError,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
	IFileService,
} from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ITaskService } from '../common/taskService.js';
import {
	readTaskOutput,
	type ITaskRun,
	type ITaskDescription,
	type TaskRunStatus,
	type IWorkspaceTask,
	type TaskProvider,
	type TaskProviderRegistration,
	type TaskProviderTask,
	waitForTask,
	RERUN_LAST_TASK_COMMAND_ID,
	RUN_BUILD_TASK_COMMAND_ID,
	RUN_TEST_TASK_COMMAND_ID,
	RUN_TASK_COMMAND_ID,
	TERMINATE_TASK_COMMAND_ID,
} from '../common/tasks.js';
import {
	IOutputService,
	type IOutputChannel,
	type OutputEntrySeverity,
} from '../../../services/output/common/output.js';
import {
	cargoWorkspaceTasks,
	parseShellExecution,
	parseTaskEnvironment,
	parseTaskRunOptions,
	parseTaskPresentationOptions,
	parsePackageTasks,
	parseWorkspaceTasks,
} from '../common/taskConfiguration.js';
import { match } from '../../../../base/common/glob.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';

interface OwnedTaskProvider {
	readonly owner: object;
	readonly provider: TaskProvider;
}

interface TaskReservation {
	readonly operation: Promise<ITaskRun>;
	readonly completion: Promise<void>;
	readonly order: number;
	readonly cancel: () => void;
	run?: ITaskRun;
}

interface TaskInstance {
	readonly run?: ITaskRun;
	readonly reservation?: TaskReservation;
	readonly order: number;
}

/** Owns workspace task discovery and delegates execution to the selected task system. */
export abstract class AbstractTaskService extends Disposable implements ITaskService {
	private readonly changeTasksEmitter = this._register(new Emitter<readonly IWorkspaceTask[]>());
	private taskSystem: TerminalTaskSystem | undefined;
	private readonly retainedRuns = new Map<
		string,
		{
			run: ITaskRun;
			completedAt?: number;
			dispatch?: { controller: AbortController; operation: Promise<ITaskRun> };
		}
	>();
	private latestRun: ITaskRun | undefined;
	private readonly startEmitter = this._register(new Emitter<ITaskRun>());
	private readonly stateEmitter = this._register(new Emitter<ITaskRun>());
	private readonly providers = new Map<string, OwnedTaskProvider>();
	private currentTasks: readonly IWorkspaceTask[] = Object.freeze([]);
	private activeRefresh: AbortController | undefined;
	private activatingProviders: AbortController | undefined;
	private refreshGeneration = 0;
	private catalogGeneration = 0;
	private workspaceGeneration = 0;
	private latestRefresh: Promise<readonly IWorkspaceTask[]> | undefined;
	private loaded = false;
	private readonly output: IOutputChannel;
	private readonly dispatches = new Set<AbortController>();
	private readonly pendingRuns = new Map<string, Set<TaskReservation>>();
	// Admission is serialized per task, including asynchronous user choices and release.
	private readonly capacityDecisions = new Map<string, Promise<void>>();
	private readonly runOrder = new WeakMap<ITaskRun, number>();
	private nextInstanceOrder = 0;
	private readonly dependencyRuns = new WeakMap<ITaskRun, readonly ITaskRun[]>();
	private readonly providedRuns = new WeakMap<ITaskRun, AbortSignal>();
	private readonly buildVariablePickers = new Set<DisposableStore>();

	readonly onDidChangeTasks: Event<readonly IWorkspaceTask[]> = this.changeTasksEmitter.event;
	readonly onDidStartTask = this.startEmitter.event;
	readonly onDidChangeTaskRun = this.stateEmitter.event;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IOutputService outputService: IOutputService,
		@IPathService private readonly paths: IPathService,
		@IConfigurationResolverService private readonly resolver: IConfigurationResolverService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.output = this._register(
			outputService.createChannel({ id: 'tasks', label: 'Tasks', kind: 'log', source: 'core' }),
		);
		resolver.contributeVariable('defaultBuildTask', () => this.resolveDefaultBuildTask());
		this._register(
			fileService.onDidChangeFiles(event => {
				if ((this.loaded || this.activeRefresh !== undefined) && affectsTaskConfiguration(event.resources))
					void this.refresh().catch(error => this.reportError(error));
			}),
		);
		this._register(
			workspace.onDidChangeWorkspace(() => {
				this.workspaceGeneration++;
				for (const picker of this.buildVariablePickers) picker.dispose();
				this.pendingRuns.clear();
				for (const dispatch of this.dispatches) dispatch.abort();
				this.taskSystem?.cancelAll();
				this.retainedRuns.clear();
				this.latestRun = undefined;
				this.activeRefresh?.abort();
				this.refreshGeneration += 1;
				this.loaded = false;
				this.setTasks(Object.freeze([]));
			}),
		);
		this._register(
			toDisposable(() => {
				for (const picker of this.buildVariablePickers) picker.dispose();
				for (const dispatch of this.dispatches) dispatch.abort();
				this.dispatches.clear();
				this.activeRefresh?.abort();
				this.activeRefresh = undefined;
				this.providers.clear();
				this.retainedRuns.clear();
				this.latestRun = undefined;
			}),
		);
	}

	get tasks(): readonly IWorkspaceTask[] {
		return this.currentTasks;
	}
	get activeRuns(): readonly ITaskRun[] {
		return this.runs.filter(run => run.status === 'running');
	}
	get lastRun(): ITaskRun | undefined {
		if (this.latestRun && !this.getRun(this.latestRun.runId)) this.latestRun = undefined;
		return this.latestRun;
	}
	get runs(): readonly ITaskRun[] {
		this.pruneRuns();
		return [...this.retainedRuns.values()].map(entry => entry.run);
	}
	private pruneRuns(): void {
		const completed = [...this.retainedRuns]
			.filter(([, entry]) => entry.completedAt !== undefined)
			.sort(([, a], [, b]) => a.completedAt! - b.completedAt!);
		let count = completed.length;
		for (const [id, entry] of completed) {
			if (Date.now() - entry.completedAt! > 3_600_000 || count > 100) {
				this.retainedRuns.delete(id);
				count--;
			}
		}
	}
	getRun(runId: string): ITaskRun | undefined {
		return this.runs.find(run => run.runId === runId);
	}

	start(task: IWorkspaceTask, signal: AbortSignal, expectedRevision: string): ITaskRun {
		this.assertNotDisposed();
		if (signal.aborted) throw new CancellationError();
		const existing = this.activeRuns.filter(run => run.task.id === task.id);
		if (
			existing.length >= (task.runOptions?.instanceLimit ?? 1) &&
			['silent', 'warn'].includes(task.runOptions?.instancePolicy ?? 'prompt')
		) {
			if (task.runOptions?.instancePolicy === 'warn')
				this.notifications.warn(
					localize(
						'tasks.instanceLimitReached',
						"Task '{0}' has reached its limit of {1} running instance(s).",
						task.label,
						task.runOptions?.instanceLimit ?? 1,
					),
				);
			return existing[0]!;
		}
		if (this.activeRuns.length >= 32)
			throw new Error(
				localize(
					'tasks.agentRunLimit',
					'This window already has 32 running tasks. Wait for a task to finish before starting another.',
				),
			);
		const controller = new AbortController();
		const emitter = new Emitter<TaskRunStatus>();
		const readyEmitter = new Emitter<void>();
		let statusListener: IDisposable | undefined;
		let readyListener: IDisposable | undefined;
		const completion = new DeferredPromise<number | undefined>();
		void completion.p.catch(() => undefined);
		let current: ITaskRun | undefined;
		let preparationError = '';
		let status: TaskRunStatus = 'running';
		const run: ITaskRun = {
			runId: generateUuid(),
			task,
			get terminalId() {
				return current?.terminalId ?? '';
			},
			get processId() {
				return current?.processId;
			},
			get processCompletion() {
				return current?.processCompletion;
			},
			get hasBackgroundMatcher() {
				return current?.hasBackgroundMatcher;
			},
			onDidBecomeReady: readyEmitter.event,
			get status() {
				return current?.status ?? status;
			},
			get exitCode() {
				return current?.exitCode;
			},
			get isReady() {
				return current?.isReady;
			},
			get hasErrors() {
				return current?.hasErrors;
			},
			onDidChangeStatus: emitter.event,
			completion: completion.p,
			readOutput: (cursor, limit) =>
				current ? current.readOutput(cursor, limit) : readTaskOutput(preparationError, 0, cursor, limit),
		};
		const bindRun = (value: ITaskRun): void => {
			if (current === value) return;
			current = value;
			// Start observers can finish the producer before dispatch returns. Subscribe
			// when it is published, and replay final state for already completed runs.
			if (value.status === 'running') {
				statusListener = value.onDidChangeStatus(status => emitter.fire(status));
				readyListener = value.onDidBecomeReady?.(() => readyEmitter.fire());
			} else {
				emitter.fire(value.status);
			}
			if (value.isReady) readyEmitter.fire();
		};
		const abort = (): void => controller.abort();
		signal.addEventListener('abort', abort, { once: true });
		const operation = this.dispatch(
			task,
			controller.signal,
			false,
			undefined,
			expectedRevision,
			run.runId,
			bindRun,
		);
		this.retainedRuns.set(run.runId, { run, dispatch: { controller, operation } });
		this.latestRun = run;
		this.stateEmitter.fire(run);
		void operation
			.then(
				async value => {
					// Joining a reserved instance returns its producer without publishing a start.
					bindRun(value);
					await completion.complete(await value.completion);
				},
				error => {
					const retained = this.retainedRuns.get(run.runId);
					if (retained) {
						retained.completedAt = Date.now();
						this.latestRun = run;
					}
					this.pruneRuns();
					const message = new TextDecoder().decode(new TextEncoder().encode(getErrorMessage(error)));
					preparationError = readTaskOutput(message, 0, 0, 65_536).text;
					status = controller.signal.aborted ? 'canceled' : 'failed';
					emitter.fire(status);
					this.stateEmitter.fire(run);
					void completion.error(error);
				},
			)
			.catch(error => {
				void completion.error(error);
			})
			.finally(() => {
				signal.removeEventListener('abort', abort);
				statusListener?.dispose();
				readyListener?.dispose();
				readyEmitter.dispose();
				emitter.dispose();
			});
		return run;
	}

	async describe(task: IWorkspaceTask): Promise<ITaskDescription> {
		this.assertNotDisposed();
		const current = resolveKnownTask(task, this.currentTasks);
		const rootFolder = this.workspace.getWorkspace().folders.find(folder => folder.id === current.dirId);
		const rules = rootFolder ? await this.paths.getPath(rootFolder.uri) : undefined;
		if (!rules)
			throw new Error(
				localize(
					'tasks.agentLocalTaskRequired',
					'Agent task execution requires a task in a local workspace folder.',
				),
			);
		const [rootPath, folderBasename] = await Promise.all([
			this.resolver.resolveWithEnvironment({}, rootFolder!, '${workspaceFolder}'),
			this.resolver.resolveWithEnvironment({}, rootFolder!, '${workspaceFolderBasename}'),
		]);
		const recipe: IWorkspaceTask[] = [];
		const commands: { command: string; cwd: string }[] = [];
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (candidate: IWorkspaceTask): void => {
			if (visiting.has(candidate.id))
				throw new Error(
					localize('tasks.dependencyCycle', "Task '{0}' has a circular dependency.", candidate.label),
				);
			if (visited.has(candidate.id)) return;
			const folder = this.workspace.getWorkspace().folders.find(folder => candidate.dirId === folder.id);
			if (!folder || folder.uri.scheme !== 'file')
				throw new Error(
					localize(
						'tasks.agentLocalTaskRequired',
						'Agent task execution requires a task in a local workspace folder.',
					),
				);
			const configuration = JSON.stringify({
				command: candidate.command,
				execution: candidate.execution,
				cwd: candidate.cwd,
				env: candidate.environment,
				matchers: candidate.problemMatchers,
			});
			if (
				candidate.providerId ||
				candidate.execution?.type === 'custom' ||
				candidate.unsupportedFeatures?.length ||
				[...configuration.matchAll(/\$\{([^}]+)\}/g)].some(
					match => !['workspaceFolder', 'workspaceFolderBasename'].includes(match[1]!),
				)
			) {
				throw new Error(
					localize(
						'tasks.agentStaticTaskRequired',
						"Task '{0}' needs an extension or interactive variables. Use the Run Task command to run it.",
						candidate.label,
					),
				);
			}
			const resolve = (value: string): string =>
				value
					.replaceAll('${workspaceFolder}', rootPath)
					.replaceAll('${workspaceFolderBasename}', folderBasename);
			visiting.add(candidate.id);
			for (const dependency of taskDependencies(candidate, this.currentTasks)) visit(dependency);
			visiting.delete(candidate.id);
			visited.add(candidate.id);
			recipe.push(candidate);
			if (candidate.command) {
				const cwd = resolve(candidate.cwd ?? rootPath);
				commands.push({
					command: resolve(candidate.command),
					cwd: rules.normalize(rules.isAbsolute(cwd) ? cwd : rootPath + rules.sep + cwd),
				});
			}
		};
		visit(current);
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === current.dirId)!;
		const bytes = new TextEncoder().encode(
			JSON.stringify({
				directory: folder.uri.toString(),
				recipe,
				terminal: this.configuration.getValue('terminal'),
			}),
		);
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
		return { taskId: current.id, label: current.label, directory: rootPath, revision, commands };
	}

	private async resolveDefaultBuildTask(): Promise<string | undefined> {
		if (this.isDisposed) return undefined;
		const generation = this.workspaceGeneration;
		await this.refresh();
		if (this.isDisposed || generation !== this.workspaceGeneration) return undefined;
		const candidates = (catalog: readonly IWorkspaceTask[]): readonly IWorkspaceTask[] => {
			const builds = catalog.filter(task => task.group === 'build');
			const defaults = builds.filter(task => task.groupIsDefault === true);
			return defaults.length ? defaults : builds;
		};
		const tasks = candidates(this.currentTasks);
		if (tasks.length === 1 && tasks[0]!.groupIsDefault === true) return tasks[0]!.label;
		if (!tasks.length) return undefined;
		return new Promise((resolve, reject) => {
			const resources = new DisposableStore();
			this.buildVariablePickers.add(resources);
			let settled = false;
			const finish = (label?: string): void => {
				if (settled) return;
				settled = true;
				this.buildVariablePickers.delete(resources);
				resources.dispose();
				resolve(label);
			};
			// A resolver callback has no cancellation token. Its picker still belongs
			// to this Task owner and must settle on workspace retirement or disposal.
			resources.add(toDisposable(() => finish()));
			try {
				const picker = resources.add(
					this.quickInput.createQuickPick<IQuickPickItem & { task: IWorkspaceTask }>(),
				);
				picker.placeholder = picker.ariaLabel = localize('tasks.selectBuildTaskLabel', 'Select a build task');
				const update = (catalog: readonly IWorkspaceTask[]): void => {
					picker.items = candidates(catalog).map(task => ({
						task,
						label: task.label,
						description: task.source,
					}));
				};
				resources.add(this.onDidChangeTasks(update));
				resources.add(
					picker.onDidAccept(() => {
						const item = picker.selectedItems[0];
						if (!item) return;
						return finish(item.task.label);
					}),
				);
				resources.add(picker.onDidHide(() => finish()));
				update(this.currentTasks);
				picker.show();
			} catch (error) {
				settled = true;
				this.buildVariablePickers.delete(resources);
				resources.dispose();
				reject(error);
			}
		});
	}

	protected abstract createTerminalTaskSystem(output: IOutputChannel): TerminalTaskSystem;

	private getTaskSystem(): TerminalTaskSystem {
		this.assertNotDisposed();
		if (!this.taskSystem) {
			// Discovery starts before UI Parts are registered. Execution is the first
			// operation that needs the view owner, while subscriptions stay stable.
			const system = this._register(this.createTerminalTaskSystem(this.output));
			this._register(
				system.onDidStartTask(run => {
					if (!this.retainedRuns.has(run.runId))
						this.retainedRuns.set(run.runId, {
							run,
							completedAt: run.status === 'running' ? undefined : Date.now(),
						});
					this.latestRun = this.retainedRuns.get(run.runId)!.run;
					this.pruneRuns();
					this.startEmitter.fire(this.latestRun);
				}),
			);
			this._register(
				system.onDidStateChange(run => {
					const retained = this.retainedRuns.get(run.runId);
					if (retained && run.status !== 'running' && retained.completedAt === undefined)
						retained.completedAt = Date.now();
					this.pruneRuns();
					this.stateEmitter.fire(retained?.run ?? run);
				}),
			);
			this.taskSystem = system;
		}
		return this.taskSystem;
	}

	registerTaskProvider(provider: TaskProvider): IDisposable {
		return this.registerTaskProviders([provider]);
	}

	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replaceProviders(owner, providers);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			const removed = this.deleteProviderOwner(owner);
			if (removed.length > 0) this.providersChanged(removed);
		}) as TaskProviderRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError('Task provider registration is already disposed');
			this.assertNotDisposed();
			this.replaceProviders(owner, replacement);
		};
		return registration;
	}

	refresh(): Promise<readonly IWorkspaceTask[]> {
		this.assertNotDisposed();
		this.activeRefresh?.abort();
		const controller = new AbortController();
		this.activeRefresh = controller;
		const generation = ++this.refreshGeneration;
		const operation = this.discoverTasks(controller, generation);
		this.latestRefresh = operation;
		return this.waitForCurrentRefresh(operation);
	}

	private async waitForCurrentRefresh(
		operation: Promise<readonly IWorkspaceTask[]>,
	): Promise<readonly IWorkspaceTask[]> {
		let tasks = await operation;
		// File watchers and activation may replace discovery while a command is waiting.
		// Returning the last good catalog would let that command select removed tasks.
		while (this.latestRefresh && operation !== this.latestRefresh) {
			operation = this.latestRefresh;
			tasks = await operation;
		}
		return tasks;
	}

	private async discoverTasks(controller: AbortController, generation: number): Promise<readonly IWorkspaceTask[]> {
		const folders = this.workspace.getWorkspace().folders;
		const multiRoot = folders.length > 1;
		try {
			this.activatingProviders = controller;
			try {
				await this.extensions.activateByEvent('onTaskType', controller.signal);
			} finally {
				if (this.activatingProviders === controller) this.activatingProviders = undefined;
			}
			if (controller.signal.aborted || generation !== this.refreshGeneration || this.isDisposed)
				return this.currentTasks;
			const providerSnapshot = [...this.providers.values()].map(entry => entry.provider);
			this.log(
				'debug',
				'discovery',
				`Refreshing workspace tasks from configuration and ${providerSnapshot.length} provider(s).`,
			);
			const [folderGroups, providerGroups] = await Promise.all([
				Promise.all(
					folders.map(async folder => {
						const tasks = await this.discoverWorkspaceTasks(folder.uri);
						return tasks.map(task =>
							Object.freeze({
								...task,
								id: multiRoot ? `${folder.id}:${task.id}` : task.id,
								dirId: folder.id,
							}),
						);
					}),
				),
				Promise.all(providerSnapshot.map(provider => this.provideTasks(provider, controller.signal))),
			]);
			const discovered = folderGroups.flat();
			const providerTasks = providerGroups.flat();
			if (controller.signal.aborted || generation !== this.refreshGeneration || this.isDisposed)
				return this.currentTasks;
			this.loaded = true;
			this.setTasks(mergeTasks(discovered, providerTasks));
			this.log('information', 'discovery', `Discovered ${this.currentTasks.length} workspace task(s).`);
			return this.currentTasks;
		} catch (error) {
			if (controller.signal.aborted || generation !== this.refreshGeneration || this.isDisposed)
				return this.currentTasks;
			this.log('error', 'discovery', `Task discovery failed: ${errorMessage(error)}`);
			throw error;
		} finally {
			if (this.activeRefresh === controller) this.activeRefresh = undefined;
		}
	}

	run(task: IWorkspaceTask, signal?: AbortSignal): Promise<ITaskRun> {
		return this.dispatch(task, signal);
	}

	async rerun(terminalInstanceId: string): Promise<ITaskRun | undefined> {
		const previous =
			this.lastRun?.terminalId === terminalInstanceId
				? this.lastRun
				: this.activeRuns.find(run => run.terminalId === terminalInstanceId);
		if (!previous) return undefined;
		const authority = this.providedRuns.get(previous);
		const run = await this.dispatch(previous.task, authority, authority !== undefined, previous);
		if (authority) this.providedRuns.set(run, authority);
		return run;
	}

	async runProvidedTask(ownerId: string, task: TaskProviderTask, signal: AbortSignal): Promise<ITaskRun> {
		this.assertNotDisposed();
		const provided = projectProviderTask(ownerId, task);
		const folder = URI.isUri(provided.scope)
			? this.workspace.getWorkspace().folders.find(folder => folder.uri.toString() === provided.scope!.toString())
			: undefined;
		if (URI.isUri(provided.scope) && !folder)
			throw new Error('Extension task scope is outside the current workspace');
		const run = await this.dispatch(
			Object.freeze({ ...provided, extensionTaskId: task.id, ...(folder ? { dirId: folder.id } : {}) }),
			signal,
			true,
		);
		this.providedRuns.set(run, signal);
		return run;
	}

	private async dispatch(
		task: IWorkspaceTask,
		signal?: AbortSignal,
		provided = false,
		previous?: ITaskRun,
		expectedRevision?: string,
		runId?: string,
		onStarted?: (run: ITaskRun) => void,
	): Promise<ITaskRun> {
		// Read the current configuration at dispatch, including changes a file watcher has not delivered yet.
		const workspaceGeneration = this.workspaceGeneration;
		// Plugin notifications may arrive after the mutation response. Refresh the
		// contribution owner before validating matchers or invoking providers.
		const contributions = this.extensions.reload();
		await (signal ? raceCancellationError(contributions, signal) : contributions);
		if (workspaceGeneration !== this.workspaceGeneration || this.isDisposed)
			throw new Error(
				localize(
					'tasks.configurationChanged',
					'Task configuration changed while preparing the task. The task was not started. Run the task again.',
				),
			);
		const refresh = this.refresh();
		const tasks = await (signal ? raceCancellationError(refresh, signal) : refresh);
		if (workspaceGeneration !== this.workspaceGeneration || this.isDisposed)
			throw new Error(
				localize(
					'tasks.configurationChanged',
					'Task configuration changed while preparing the task. The task was not started. Run the task again.',
				),
			);
		const generation = this.catalogGeneration;
		const terminalConfiguration = JSON.stringify(this.configuration.getValue('terminal'));
		const currentTask = provided
			? task
			: previous || expectedRevision !== undefined
				? resolveKnownTask(tasks.find(candidate => candidate.id === task.id) ?? task, tasks)
				: resolveKnownTask(task, tasks);
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) controller.abort();
		this.dispatches.add(controller);
		const started: ITaskRun[] = [];
		const pending = new Map<string, Promise<ITaskRun>>();
		const graph = new Map<string, readonly IWorkspaceTask[]>();
		const resolvedTasks = new Map<string, IWorkspaceTask>();
		const previousRuns = new Map(
			previous
				? [previous, ...(this.dependencyRuns.get(previous) ?? [])].map(run => [run.task.id, run] as const)
				: [],
		);
		const visiting = new Set<string>();
		const assertCurrent = (): void => {
			if (signal?.aborted) throw new CancellationError();
			if (
				expectedRevision !== undefined &&
				JSON.stringify(this.configuration.getValue('terminal')) !== terminalConfiguration
			)
				throw new Error(
					localize(
						'tasks.agentRevisionChanged',
						'The task configuration changed after review. Discover the task again before running it.',
					),
				);
			if (controller.signal.aborted && controller.signal.reason instanceof CancellationError)
				throw controller.signal.reason;
			if (
				controller.signal.aborted ||
				generation !== this.catalogGeneration ||
				workspaceGeneration !== this.workspaceGeneration ||
				this.isDisposed
			)
				throw new Error(
					localize(
						'tasks.configurationChanged',
						'Task configuration changed while preparing the task. The task was not started. Run the task again.',
					),
				);
		};
		const validate = async (candidate: IWorkspaceTask): Promise<void> => {
			if (visiting.has(candidate.id))
				throw new Error(
					localize('tasks.dependencyCycle', "Task '{0}' has a circular dependency.", candidate.label),
				);
			if (graph.has(candidate.id)) return;
			if (
				candidate.definition &&
				candidate.unsupportedFeatures?.some(feature => feature === `type:${candidate.definition!.type}`)
			) {
				const providers = [...this.providers.values()]
					.map(value => value.provider)
					.filter(provider => provider.type === candidate.definition!.type && provider.resolveTask);
				if (providers.length === 1) {
					const value = await raceCancellationError(
						Promise.resolve(providers[0]!.resolveTask!(candidate, controller.signal)),
						controller.signal,
					);
					assertCurrent();
					if (value) {
						if (
							value.definition &&
							JSON.stringify(value.definition) !== JSON.stringify(candidate.definition)
						)
							throw new TypeError('resolveTask must preserve the task definition');
						const provided = projectProviderTask(providers[0]!.id, value);
						// A definition-only extension Task can explicitly select a group
						// without carrying a tasks.json presence flag or a default flag.
						const preserveGroup =
							candidate.configuration?.groupIsConfigured === true ||
							candidate.groupIsDefault !== undefined ||
							(candidate.configuration === undefined && candidate.group !== 'other');
						candidate = Object.freeze({
							...candidate,
							...provided,
							id: candidate.id,
							label: candidate.label,
							dirId: candidate.dirId,
							source: candidate.source,
							scope: candidate.scope ?? provided.scope,
							extensionSource: candidate.extensionSource ?? provided.extensionSource,
							group: preserveGroup ? candidate.group : provided.group,
							groupIsDefault: preserveGroup ? candidate.groupIsDefault : provided.groupIsDefault,
							definition: candidate.definition,
							configuration: candidate.configuration,
							cwd: candidate.cwd ?? provided.cwd,
							runOptions: candidate.runOptions ?? provided.runOptions,
							presentation:
								candidate.presentation === undefined && provided.presentation === undefined
									? undefined
									: Object.freeze({ ...provided.presentation, ...candidate.presentation }),
							isBackground: candidate.isBackground ?? provided.isBackground,
							problemMatchers: candidate.problemMatchers ?? provided.problemMatchers,
							unsupportedFeatures: candidate.unsupportedFeatures.filter(
								feature => feature !== `type:${candidate.definition!.type}`,
							),
							environment: Object.freeze({ ...provided.environment, ...candidate.environment }),
						});
					}
				}
			}
			if (candidate.unsupportedFeatures?.length) {
				throw new Error(
					localize(
						'tasks.unsupportedExecution',
						"Task '{0}' was not started because Ash does not yet support: {1}. Update .vscode/tasks.json and run the task again.",
						candidate.label,
						candidate.unsupportedFeatures.join(', '),
					),
				);
			}
			this.getTaskSystem().validate(candidate);
			visiting.add(candidate.id);
			const dependencies = taskDependencies(candidate, tasks);
			for (const dependency of dependencies) await validate(dependency);
			visiting.delete(candidate.id);
			graph.set(candidate.id, dependencies);
			resolvedTasks.set(candidate.id, candidate);
		};
		const execute = (candidate: IWorkspaceTask): Promise<ITaskRun> => {
			candidate = resolvedTasks.get(candidate.id)!;
			if (expectedRevision !== undefined && (candidate.cwd === undefined || candidate.cwd === '')) {
				candidate = { ...candidate, cwd: '${workspaceFolder}' };
			}
			const existing = pending.get(candidate.id);
			if (existing) return existing;
			const preceding = this.capacityDecisions.get(candidate.id) ?? Promise.resolve();
			const admitted = new DeferredPromise<void>();
			const decision = preceding.then(() => admitted.p);
			this.capacityDecisions.set(candidate.id, decision);
			const admission = (async (): Promise<{ operation: Promise<ITaskRun> }> => {
				try {
					await raceCancellationError(preceding, controller.signal);
					assertCurrent();
					while (true) {
						const instances = this.taskInstances(candidate.id);
						if (instances.length < (candidate.runOptions?.instanceLimit ?? 1)) break;
						const policy =
							candidate.id === currentTask.id
								? (candidate.runOptions?.instancePolicy ?? 'prompt')
								: 'silent';
						if (policy === 'silent' || policy === 'warn') {
							if (expectedRevision !== undefined && candidate.id === currentTask.id)
								throw new Error(
									localize(
										'tasks.agentAlreadyRunning',
										"Task '{0}' is already running. Use tasks_list to find and inspect its Run ID.",
										candidate.label,
									),
								);
							if (policy === 'warn')
								this.notifications.warn(
									localize(
										'tasks.instanceLimitReached',
										"Task '{0}' has reached its limit of {1} running instance(s).",
										candidate.label,
										candidate.runOptions?.instanceLimit ?? 1,
									),
								);
							// Joining another graph never transfers cancellation or rollback ownership.
							const instance = instances.find(value => value.run?.status === 'running') ?? instances[0]!;
							return {
								operation: instance.run
									? Promise.resolve(instance.run)
									: raceCancellationError(instance.reservation!.operation, controller.signal),
							};
						}
						const selected =
							policy === 'prompt'
								? await this.selectInstance(candidate, instances, controller.signal)
								: policy === 'terminateNewest'
									? instances.at(-1)!
									: instances[0]!;
						assertCurrent();
						if (!selected) continue;
						// The selected instance may have completed while its picker was open.
						if (!this.taskInstances(candidate.id).some(value => value.order === selected.order)) continue;
						if (selected.run) await this.terminate(selected.run);
						else selected.reservation!.cancel();
						await raceCancellationError(
							selected.reservation?.completion ??
								Promise.resolve(selected.run!.completion).then(() => undefined),
							controller.signal,
						);
						assertCurrent();
					}
					const reservations = this.pendingRuns.get(candidate.id) ?? new Set<TaskReservation>();
					let reservation: TaskReservation;
					const operation = (async (): Promise<ITaskRun> => {
						const wait = async (dependency: IWorkspaceTask): Promise<void> => {
							const run = await execute(dependency);
							const status = await waitForTask(run, controller.signal);
							assertCurrent();
							if (status !== 'succeeded' || run.hasErrors)
								throw new Error(
									localize(
										'tasks.dependencyFailed',
										"Dependency '{0}' of task '{1}' failed.",
										dependency.label,
										candidate.label,
									),
								);
						};
						const dependencies = graph.get(candidate.id)!;
						if (candidate.dependsOrder === 'sequence') {
							for (const dependency of dependencies) await wait(dependency);
						} else {
							await Promise.all(dependencies.map(wait));
						}
						assertCurrent();
						const folder = this.workspace
							.getWorkspace()
							.folders.find(folder => candidate.dirId === undefined || folder.id === candidate.dirId);
						if (!folder) throw new Error(`Task '${candidate.label}' has no available workspace folder`);
						const run = await this.getTaskSystem().run(
							candidate,
							folder,
							assertCurrent,
							controller.signal,
							previousRuns.get(candidate.id),
							run => {
								reservation.run = run;
								if (candidate.id === currentTask.id) onStarted?.(run);
								this.runOrder.set(run, reservation.order);
							},
							candidate.id === currentTask.id ? runId : undefined,
						);
						started.push(run);
						if (candidate.id === currentTask.id)
							this.dependencyRuns.set(
								run,
								started.filter(value => value !== run),
							);
						return run;
					})();
					const completion = operation
						.then(run => run.completion)
						.then(
							() => undefined,
							() => undefined,
						)
						.finally(() => {
							reservations.delete(reservation);
							if (reservations.size === 0 && this.pendingRuns.get(candidate.id) === reservations)
								this.pendingRuns.delete(candidate.id);
						});
					// Dependency awaits yield before execution publishes a run.
					reservation = {
						operation,
						completion,
						cancel: () => controller.abort(new CancellationError()),
						order: this.nextInstanceOrder++,
					};
					reservations.add(reservation);
					this.pendingRuns.set(candidate.id, reservations);
					return { operation };
				} finally {
					void admitted.complete(undefined);
					if (this.capacityDecisions.get(candidate.id) === decision)
						this.capacityDecisions.delete(candidate.id);
				}
			})();
			const operation = admission.then(value => value.operation);
			pending.set(candidate.id, operation);
			return operation;
		};
		try {
			if (expectedRevision !== undefined && (await this.describe(currentTask)).revision !== expectedRevision)
				throw new Error(
					localize(
						'tasks.agentRevisionChanged',
						'The task configuration changed after review. Discover the task again before running it.',
					),
				);
			assertCurrent();
			await validate(currentTask);
			const run = await execute(currentTask);
			if (!this.dependencyRuns.has(run))
				this.dependencyRuns.set(
					run,
					started.filter(value => value !== run),
				);
			return run;
		} catch (error) {
			controller.abort();
			// Parallel dependencies already being created still pass assertCurrent;
			// await their retirement before returning the graph's failure.
			await Promise.allSettled(pending.values());
			await Promise.allSettled(started.map(run => this.taskSystem?.terminate(run)));
			throw error;
		} finally {
			this.dispatches.delete(controller);
			signal?.removeEventListener('abort', abort);
		}
	}

	private taskInstances(taskId: string): TaskInstance[] {
		const instances: TaskInstance[] = [...(this.pendingRuns.get(taskId) ?? [])].map(reservation => ({
			reservation,
			run: reservation.run,
			order: reservation.order,
		}));
		for (const run of this.taskSystem?.activeRuns ?? []) {
			if (run.task.id === taskId && !instances.some(instance => instance.run === run))
				instances.push({ run, reservation: undefined, order: this.runOrder.get(run)! });
		}
		return instances.sort((first, second) => first.order - second.order);
	}

	private selectInstance(
		task: IWorkspaceTask,
		instances: readonly TaskInstance[],
		signal: AbortSignal,
	): Promise<TaskInstance | null> {
		return new Promise((resolve, reject) => {
			const resources = new DisposableStore();
			const picker = resources.add(
				this.quickInput.createQuickPick<IQuickPickItem & { instance: TaskInstance }>(),
			);
			let settled = false;
			const finish = (instance?: TaskInstance | null): void => {
				if (settled) return;
				settled = true;
				picker.hide();
				resources.dispose();
				if (instance === undefined) reject(new CancellationError());
				else resolve(instance);
			};
			picker.ariaLabel = picker.placeholder = localize(
				'tasks.selectInstanceToTerminate',
				"Task '{0}' is at its instance limit. Select an instance to terminate and restart.",
				task.label,
			);
			picker.items = instances.map((instance, index) => ({
				instance,
				label: localize('tasks.runningInstance', '{0} — instance {1}', task.label, index + 1),
				description: instance.run?.terminalId ?? localize('tasks.preparingInstance', 'Preparing'),
			}));
			resources.add(
				picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					return finish(item.instance);
				}),
			);
			resources.add(picker.onDidHide(() => finish()));
			resources.add(this.onDidChangeTasks(() => finish(null)));
			const cancel = (): void => finish();
			signal.addEventListener('abort', cancel, { once: true });
			resources.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
			// Resource release can free capacity while the user is choosing.
			const released = new AbortController();
			resources.add(toDisposable(() => released.abort()));
			for (const instance of instances) {
				const completion = instance.reservation?.completion ?? instance.run?.completion;
				if (completion)
					void raceCancellationError<void | number | undefined>(completion, released.signal).then(
						() => finish(null),
						() => {
							if (!released.signal.aborted) finish(null);
						},
					);
			}
			if (signal.aborted) finish();
			else picker.show();
		});
	}

	async terminate(run: ITaskRun): Promise<void> {
		const scheduled = this.retainedRuns.get(run.runId)?.dispatch;
		if (scheduled) {
			scheduled.controller.abort();
			const actual = await scheduled.operation.catch(() => undefined);
			if (actual) {
				await this.taskSystem?.terminate(actual);
				await Promise.all(
					(this.dependencyRuns.get(actual) ?? []).map(async dependency => {
						await this.taskSystem?.terminate(dependency);
						await dependency.completion;
					}),
				);
				await actual.completion;
			}
			return;
		}
		await this.taskSystem?.terminate(run);
		await Promise.all(
			(this.dependencyRuns.get(run) ?? []).map(async dependency => {
				await this.taskSystem?.terminate(dependency);
				await dependency.completion;
			}),
		);
		await run.completion;
	}

	private setTasks(tasks: readonly IWorkspaceTask[]): void {
		if (taskListsEqual(this.currentTasks, tasks)) return;
		this.catalogGeneration++;
		// A catalog revision invalidates preparation, not its resource lease. Each
		// reservation retires only after dispatch rollback or producer release.
		this.currentTasks = tasks;
		this.changeTasksEmitter.fire(tasks);
	}

	private replaceProviders(owner: object, providers: readonly TaskProvider[]): void {
		if (!Array.isArray(providers)) throw new TypeError('Task providers must be an array');
		const normalized = providers.map(normalizeTaskProvider);
		const ids = new Set<string>();
		for (const provider of normalized) {
			const existing = this.providers.get(provider.id);
			if (ids.has(provider.id) || (existing && existing.owner !== owner))
				throw new Error(`Task provider '${provider.id}' is already registered`);
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
		for (const dispatch of this.dispatches) dispatch.abort();
		for (const run of this.activeRuns) {
			const providerId = run.task.providerId ?? taskProviderId(run.task);
			if (providerId && changedProviders.has(providerId) && run.task.execution?.type === 'custom')
				void this.terminate(run).catch(error => this.reportError(error));
		}
		const refresh = this.loaded || this.activeRefresh !== undefined;
		if (this.loaded)
			this.setTasks(
				Object.freeze(
					this.currentTasks.filter(task => {
						const providerId = taskProviderId(task);
						return providerId === undefined || !changedProviders.has(providerId);
					}),
				),
			);
		// Registrations produced by this discovery's activation belong to its next
		// provider snapshot. Existing dispatches were already revoked above.
		if (this.activeRefresh && this.activeRefresh === this.activatingProviders) return;
		this.activeRefresh?.abort();
		this.refreshGeneration += 1;
		if (refresh) void this.refresh().catch(error => this.reportError(error));
	}

	private async provideTasks(provider: TaskProvider, signal: AbortSignal): Promise<readonly IWorkspaceTask[]> {
		let contributions: readonly TaskProviderTask[];
		try {
			contributions = await raceCancellationError(Promise.resolve(provider.provideTasks(signal)), signal);
		} catch (error) {
			if (signal.aborted) return Object.freeze([]);
			this.log('error', 'provider', `Task provider '${provider.id}' failed: ${errorMessage(error)}`);
			throw error;
		}
		if (signal.aborted) return Object.freeze([]);
		if (!Array.isArray(contributions)) throw new TypeError(`Task provider '${provider.id}' must return an array`);
		const ids = new Set<string>();
		return Object.freeze(
			contributions.map(contribution => {
				const provided = projectProviderTask(provider.id, contribution);
				const scope = provided.scope;
				const folder = URI.isUri(scope)
					? this.workspace.getWorkspace().folders.find(folder => folder.uri.toString() === scope.toString())
					: undefined;
				if (URI.isUri(scope) && !folder)
					throw new Error('Extension task scope is outside the current workspace');
				const task = folder ? Object.freeze({ ...provided, dirId: folder.id }) : provided;
				if (ids.has(task.id))
					throw new Error(`Task provider '${provider.id}' returned duplicate task '${contribution.id}'`);
				ids.add(task.id);
				return task;
			}),
		);
	}

	private log(severity: OutputEntrySeverity, category: string, text: string): void {
		this.output.appendLine({ severity, category, text });
		const logCategory = `tasks.${category}`;
		if (severity === 'error') this.logService.error(logCategory, text);
		else if (severity === 'warning') this.logService.warn(logCategory, text);
		else if (severity === 'debug') this.logService.debug(logCategory, text);
		else this.logService.info(logCategory, text);
	}

	private reportError(error: unknown): void {
		this.logService.error('tasks.discovery', 'Could not refresh workspace tasks', error);
	}

	private async packageManager(root: URI): Promise<'npm' | 'pnpm' | 'yarn'> {
		if (await this.exists(childResource(root, 'pnpm-lock.yaml'))) return 'pnpm';
		if (await this.exists(childResource(root, 'yarn.lock'))) return 'yarn';
		return 'npm';
	}

	private async discoverWorkspaceTasks(root: URI): Promise<readonly IWorkspaceTask[]> {
		const discovered: IWorkspaceTask[] = [];
		const tasksJson = await this.readOptional(childResource(root, '.vscode/tasks.json'));
		if (tasksJson !== undefined)
			discovered.push(
				...parseWorkspaceTasks(
					tasksJson,
					await this.paths.getOperatingSystem(root),
					this.resolver.resolvableVariables,
				),
			);
		const packageJson = await this.readOptional(childResource(root, 'package.json'));
		if (packageJson !== undefined)
			discovered.push(...parsePackageTasks(packageJson, await this.packageManager(root)));
		if (await this.exists(childResource(root, 'Cargo.toml'))) discovered.push(...cargoWorkspaceTasks());
		return Object.freeze(discovered);
	}

	private async exists(resource: URI): Promise<boolean> {
		try {
			return (await this.fileService.stat(resource)).kind === FileKind.File;
		} catch (error) {
			if (error instanceof FileNotFoundError) return false;
			throw error;
		}
	}

	private async readOptional(resource: URI): Promise<string | undefined> {
		if (!(await this.exists(resource))) return undefined;
		// Task configuration is UTF-8 text; provider text reads keep Session routing on one request.
		return (await this.fileService.readFile(resource, 'utf8')).content;
	}
}

function taskProviderId(task: IWorkspaceTask): string | undefined {
	if (task.source !== 'extension' || !task.id.startsWith('extension:')) return undefined;
	const encoded = task.id.slice('extension:'.length).split(':', 1)[0];
	if (!encoded) return undefined;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
}

function childResource(root: URI, relativePath: string): URI {
	return URI.joinPath(root, ...relativePath.split('/'));
}

function affectsTaskConfiguration(resources: readonly URI[] | undefined): boolean {
	return (
		resources === undefined ||
		resources.some(resource =>
			/\/(?:tasks\.json|package\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml)$/i.test(resource.path),
		)
	);
}

function deduplicateTasks(tasks: readonly IWorkspaceTask[]): readonly IWorkspaceTask[] {
	const unique = new Map<string, IWorkspaceTask>();
	for (const task of tasks) if (!unique.has(task.id)) unique.set(task.id, task);
	return Object.freeze(
		[...unique.values()].sort(
			(left, right) => taskOrder(left.group) - taskOrder(right.group) || left.label.localeCompare(right.label),
		),
	);
}

function mergeTasks(
	discovered: readonly IWorkspaceTask[],
	provided: readonly IWorkspaceTask[],
): readonly IWorkspaceTask[] {
	const merged = new Map(deduplicateTasks(discovered).map(task => [task.id, task]));
	for (const task of provided) {
		if (merged.has(task.id)) throw new Error(`Workspace task '${task.id}' is already registered`);
		merged.set(task.id, task);
	}
	return Object.freeze(
		[...merged.values()].sort(
			(left, right) => taskOrder(left.group) - taskOrder(right.group) || left.label.localeCompare(right.label),
		),
	);
}

function normalizeTaskProvider(provider: TaskProvider): TaskProvider {
	if (!provider || typeof provider !== 'object') throw new TypeError('Task provider must be an object');
	const id = normalizeText(provider.id, 'Task provider ID', 256);
	if (typeof provider.provideTasks !== 'function')
		throw new TypeError(`Task provider '${id}' must implement provideTasks`);
	const type = provider.type === undefined ? undefined : normalizeText(provider.type, 'Task provider type', 256);
	return Object.freeze({
		id,
		type,
		provideTasks: (signal: AbortSignal) => provider.provideTasks.call(provider, signal),
		...(provider.resolveTask === undefined
			? {}
			: {
					resolveTask: (task: IWorkspaceTask, signal: AbortSignal) =>
						provider.resolveTask!.call(provider, task, signal),
				}),
	});
}

function projectProviderTask(providerId: string, contribution: TaskProviderTask): IWorkspaceTask {
	if (!contribution || typeof contribution !== 'object')
		throw new TypeError(`Task provider '${providerId}' returned an invalid task`);
	const id = normalizeText(contribution.id, `Task provider '${providerId}' task ID`, 256);
	const label = normalizeText(contribution.label, `Task provider '${providerId}' task label`, 256);
	const execution = contribution.execution;
	if (execution?.type === 'process') {
		normalizeText(execution.program, 'Task process', 32768, false);
		if (
			!Array.isArray(execution.args) ||
			execution.args.length > 1024 ||
			execution.args.some(
				argument => typeof argument !== 'string' || argument.length > 32768 || argument.includes('\0'),
			)
		)
			throw new TypeError('Invalid task process arguments');
	} else if (execution?.type === 'shell') {
		parseShellExecution(execution);
	} else if (execution?.type === 'custom') {
		if (typeof execution.callback !== 'function') throw new TypeError('CustomExecution requires a callback');
	} else if (execution !== undefined) {
		throw new TypeError('Unknown task execution type');
	}
	const shellCommand =
		execution?.type === 'shell'
			? (execution.commandLine ??
				(typeof execution.command === 'string' ? execution.command : execution.command.value))
			: undefined;
	const unresolved =
		contribution.command === undefined && execution === undefined && contribution.definition !== undefined;
	const command = normalizeText(
		contribution.command ??
			(execution?.type === 'process'
				? execution.program
				: (shellCommand ?? (execution?.type === 'custom' || unresolved ? label : ''))),
		`Task provider '${providerId}' task command`,
		32768,
		false,
	);
	if (!(['build', 'test', 'clean', 'rebuild', 'run', 'other'] as const).includes(contribution.group))
		throw new TypeError(`Task provider '${providerId}' task '${id}' has an invalid group`);
	if (contribution.groupIsDefault !== undefined && typeof contribution.groupIsDefault !== 'boolean')
		throw new TypeError('Task groupIsDefault must be a boolean');
	const environment =
		contribution.environment === undefined ? undefined : parseTaskEnvironment(contribution.environment);
	const detail =
		contribution.detail === undefined
			? undefined
			: normalizeText(contribution.detail, `Task provider '${providerId}' task detail`, 4096, false);
	const normalizedExecution =
		execution?.type === 'shell'
			? parseShellExecution(execution)
			: execution?.type === 'process'
				? Object.freeze({ ...execution, args: Object.freeze([...execution.args]) })
				: execution === undefined
					? undefined
					: Object.freeze({ ...execution });
	const cwd = contribution.cwd === undefined ? undefined : normalizeText(contribution.cwd, 'Task cwd', 32768, false);
	if (
		contribution.definition !== undefined &&
		(!contribution.definition ||
			typeof contribution.definition !== 'object' ||
			typeof contribution.definition.type !== 'string')
	)
		throw new TypeError('Task definition requires a type');
	if (contribution.isBackground !== undefined && typeof contribution.isBackground !== 'boolean')
		throw new TypeError('Task isBackground must be a boolean');
	if (contribution.problemMatchers !== undefined && !Array.isArray(contribution.problemMatchers))
		throw new TypeError('Task problemMatchers must be an array');
	const scope = contribution.scope;
	if (scope !== undefined && scope !== 1 && scope !== 2 && !URI.isUri(scope))
		throw new TypeError('Invalid task scope');
	const extensionSource =
		contribution.source === undefined ? undefined : normalizeText(contribution.source, 'Task source', 256, false);
	const unsupportedFeatures =
		scope === 1 ? ['scope:global'] : unresolved ? [`type:${contribution.definition!.type}`] : undefined;
	return Object.freeze({
		scope,
		extensionSource,
		...(unsupportedFeatures ? { unsupportedFeatures } : {}),
		id: `extension:${encodeURIComponent(providerId)}:${encodeURIComponent(id)}`,
		providerId,
		label,
		command,
		source: 'extension',
		group: contribution.group,
		groupIsDefault: contribution.groupIsDefault,
		runOptions: contribution.runOptions === undefined ? undefined : parseTaskRunOptions(contribution.runOptions),
		presentation:
			contribution.presentation === undefined
				? undefined
				: parseTaskPresentationOptions(contribution.presentation),
		execution: normalizedExecution,
		definition: contribution.definition,
		cwd,
		isBackground: contribution.isBackground,
		problemMatchers:
			contribution.problemMatchers === undefined ? undefined : Object.freeze([...contribution.problemMatchers]),
		...(environment === undefined ? {} : { environment }),
		...(detail === undefined ? {} : { detail }),
	});
}

function normalizeText(value: string, owner: string, maximum: number, trim = true): string {
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0'))
		throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return trim ? value.trim() : value;
}

function taskOrder(group: IWorkspaceTask['group']): number {
	return group === 'build'
		? 0
		: group === 'test'
			? 1
			: group === 'run'
				? 2
				: group === 'clean'
					? 3
					: group === 'rebuild'
						? 4
						: 5;
}

function taskListsEqual(left: readonly IWorkspaceTask[], right: readonly IWorkspaceTask[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resolveKnownTask(task: IWorkspaceTask, tasks: readonly IWorkspaceTask[]): IWorkspaceTask {
	const current = tasks.find(candidate => candidate.id === task.id);
	if (!current || current.command !== task.command)
		throw new Error('Task is no longer present in the current workspace configuration');
	return current;
}

function errorMessage(error: unknown): string {
	return getErrorMessage(error).slice(0, 4096);
}

function taskDependencies(task: IWorkspaceTask, tasks: readonly IWorkspaceTask[]): readonly IWorkspaceTask[] {
	return (task.dependsOn ?? []).map(reference => {
		const matches = tasks.filter(
			value =>
				(value.id === reference || value.label === reference) &&
				(value.dirId === task.dirId || value.dirId === undefined),
		);
		if (matches.length !== 1)
			throw new Error(
				localize(
					'tasks.dependencyUnavailable',
					"Dependency '{0}' of task '{1}' is missing or ambiguous.",
					reference,
					task.label,
				),
			);
		return matches[0]!;
	});
}

interface TaskRunQuickPickItem extends IQuickPickItem {
	readonly run: ITaskRun;
}

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: {
		id: RUN_TASK_COMMAND_ID,
		title: localize2({ bundle: 'ash', key: 'workbench.manageRunTask' }, 'Run Task...'),
	},
	group: '2_configuration',
	order: 6,
	when: AppServerAvailableContext.isEqualTo(true),
});

registerAction2(
	class RunTaskAction extends Action2 {
		constructor() {
			super({
				id: RUN_TASK_COMMAND_ID,
				title: localize2({ bundle: 'ash.workbench', key: 'command.RunTaskAction' }, 'Run Task'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				menu: { id: MenuId.MenubarRunMenu, group: '2_tasks', order: 1 },
				keybinding: {
					primary: Keybinding.chord(
						logicalKey('k', { primaryKey: true }),
						logicalKey('t', { primaryKey: true }),
					),
				},
			});
		}

		override run(accessor: ServicesAccessor): void {
			runTaskCommand(accessor);
		}
	},
);

registerAction2(
	class RunBuildTaskAction extends Action2 {
		constructor() {
			super({
				id: RUN_BUILD_TASK_COMMAND_ID,
				title: localize2('command.RunBuildTaskAction', 'Run Build Task'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				keybinding: { primary: Keybinding.single(logicalKey('b', { primaryKey: true, shiftKey: true })) },
			});
		}
		override run(accessor: ServicesAccessor): void {
			runTaskCommand(accessor, 'build');
		}
	},
);

registerAction2(
	class RunTestTaskAction extends Action2 {
		constructor() {
			super({
				id: RUN_TEST_TASK_COMMAND_ID,
				title: localize2('command.RunTestTaskAction', 'Run Test Task'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
			});
		}
		override run(accessor: ServicesAccessor): void {
			runTaskCommand(accessor, 'test');
		}
	},
);

function runTaskCommand(accessor: ServicesAccessor, group?: 'build' | 'test'): void {
	// Capture dependencies before the command accessor's synchronous lifetime ends.
	const tasks = accessor.get(ITaskService);
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const instantiation = accessor.get(IInstantiationService);
	const notifications = accessor.get(INotificationService);
	const editors = group ? accessor.get(IEditorService) : undefined;
	const workspace = group ? accessor.get(IWorkspaceContextService) : undefined;
	const candidates = (
		catalog: readonly IWorkspaceTask[],
	): { tasks: readonly IWorkspaceTask[]; isDefault: boolean } => {
		if (!group) return { tasks: catalog, isDefault: false };
		const grouped = catalog.filter(task => task.group === group);
		const resource = editors!.activeEditor?.resource;
		const folder = resource && workspace!.getWorkspaceFolder(resource);
		if (folder && resource) {
			const relative = resource.path.slice(folder.uri.path.replace(/\/+$/, '').length + 1).toLowerCase();
			const matching = grouped.filter(
				task =>
					task.dirId === folder.id &&
					typeof task.groupIsDefault === 'string' &&
					match(task.groupIsDefault.toLowerCase(), relative),
			);
			if (matching.length) return { tasks: matching, isDefault: true };
		}
		const defaults = grouped.filter(task => task.groupIsDefault === true);
		return { tasks: defaults.length ? defaults : grouped, isDefault: defaults.length > 0 };
	};
	const run = (task: IWorkspaceTask): Promise<unknown> => tasks.run(task);
	void tasks
		.refresh()
		.then(() => {
			const selection = candidates(tasks.tasks);
			const available = selection.tasks;
			if (selection.isDefault && available.length === 1) return run(available[0]!);
			if (available.length === 0) {
				if (group)
					notifications.info(
						group === 'build'
							? localize('tasks.noBuildTask', 'No build task is available.')
							: localize('tasks.noTestTask', 'No test task is available.'),
					);
				return commands.executeCommand('workbench.action.tasks.configureTaskRunner');
			}
			const picker = instantiation.createInstance(
				TaskQuickPick,
				(catalog: readonly IWorkspaceTask[]) => candidates(catalog).tasks,
			);
			const placeholder =
				group === 'build'
					? localize('tasks.selectBuildTask', 'Select the build task to run')
					: group === 'test'
						? localize('tasks.selectTestTask', 'Select the test task to run')
						: localize('tasks.selectTask', 'Select a task to run');
			return picker
				.show(placeholder)
				.then(task => (task ? run(task) : undefined))
				.finally(() => picker.dispose());
		})
		.catch(error => reportTaskError(notifications, error));
}

registerAction2(
	class RerunLastTaskAction extends Action2 {
		constructor() {
			super({
				id: RERUN_LAST_TASK_COMMAND_ID,
				title: localize2({ bundle: 'ash.workbench', key: 'command.RerunLastTaskAction' }, 'Rerun Last Task'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				menu: { id: MenuId.MenubarRunMenu, group: '2_tasks', order: 2 },
			});
		}

		override run(accessor: ServicesAccessor): void {
			const tasks = accessor.get(ITaskService);
			const notifications = accessor.get(INotificationService);
			const last = tasks.lastRun;
			if (!last) return;
			void tasks.rerun(last.terminalId).catch(error => reportTaskError(notifications, error));
		}
	},
);

registerAction2(
	class TerminateTaskAction extends Action2 {
		constructor() {
			super({
				id: TERMINATE_TASK_COMMAND_ID,
				title: localize2({ bundle: 'ash.workbench', key: 'command.TerminateTaskAction' }, 'Terminate Task'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				menu: { id: MenuId.MenubarRunMenu, group: '2_tasks', order: 3 },
			});
		}

		override run(accessor: ServicesAccessor): void {
			const tasks = accessor.get(ITaskService);
			const notifications = accessor.get(INotificationService);
			if (tasks.activeRuns.length === 0) return;
			if (tasks.activeRuns.length === 1) {
				void tasks.terminate(tasks.activeRuns[0]!).catch(error => reportTaskError(notifications, error));
				return;
			}
			const picker = accessor.get(IQuickInputService).createQuickPick<TaskRunQuickPickItem>();
			const disposables = new DisposableStore();
			disposables.add(picker);
			picker.ariaLabel = picker.placeholder = localize(
				'tasks.selectTerminateTask',
				'Select a running task to terminate',
			);
			picker.items = tasks.activeRuns.map(run => ({
				run,
				label: run.task.label,
				description: run.task.source,
				detail: run.task.command,
			}));
			disposables.add(
				picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					picker.hide();
					void tasks.terminate(item.run).catch(error => reportTaskError(notifications, error));
				}),
			);
			disposables.add(picker.onDidHide(() => disposables.dispose()));
			picker.show();
		}
	},
);

function reportTaskError(notifications: INotificationService, error: unknown): void {
	if (isCancellationError(error)) return;
	notifications.error(getErrorMessage(error));
}

registerAction2(
	class ConfigureTasksAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.tasks.configureTaskRunner',
				title: localize2('tasks.configure', 'Configure Tasks...'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = accessor.get(IWorkspaceContextService);
			const commands = accessor.get(ICommandService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			const notifications = accessor.get(INotificationService);
			const tasks = accessor.get(ITaskService);
			const instantiation = accessor.get(IInstantiationService);
			const quickInput = accessor.get(IQuickInputService);
			const folders = workspace.getWorkspace().folders;
			if (folders.length === 0) {
				notifications.info(localize('tasks.configure.openFolder', 'Open a folder to configure tasks.'));
				return;
			}
			await tasks.refresh();
			let selectedTask: IWorkspaceTask | null | undefined;
			if (tasks.tasks.length) {
				using picker = instantiation.createInstance(
					TaskQuickPick,
					(catalog: readonly IWorkspaceTask[]) => catalog,
				);
				selectedTask = await picker.show(localize('tasks.configure.selectTask', 'Select a task to configure'), {
					label: localize('tasks.configure.createFile', 'Create tasks.json file from template'),
					task: null,
				});
				if (selectedTask === undefined) return;
			}
			const taskFolder = selectedTask?.dirId && folders.find(folder => folder.id === selectedTask!.dirId);
			const folder =
				taskFolder ||
				(folders.length === 1
					? folders[0]
					: await commands.executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [
							{
								placeHolder: localize(
									'tasks.configure.selectFolder',
									'Select a workspace folder to configure tasks.',
								),
							},
						]));
			if (
				!folder ||
				!workspace
					.getWorkspace()
					.folders.some(
						current => current.id === folder.id && current.uri.toString() === folder.uri.toString(),
					)
			)
				return;
			const resource = URI.joinPath(folder.uri, '.vscode', 'tasks.json');
			try {
				await files.stat(resource);
			} catch (error) {
				if (
					!(error instanceof FileNotFoundError) &&
					toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound
				)
					throw error;
				let content: string;
				if (selectedTask) {
					const definition =
						selectedTask.configuration?.task ??
						(selectedTask.definition
							? { ...selectedTask.definition, label: selectedTask.label }
							: { label: selectedTask.label, type: 'shell', command: selectedTask.command });
					content = JSON.stringify({ version: '2.0.0', tasks: [definition] }, null, '\t') + '\n';
				} else {
					const template = await selectTaskTemplate(quickInput);
					if (!template) return;
					content = template.content;
				}
				if (
					!workspace
						.getWorkspace()
						.folders.some(
							current => current.id === folder.id && current.uri.toString() === folder.uri.toString(),
						)
				)
					return;
				await files.createDirectory(URI.joinPath(folder.uri, '.vscode'));
				try {
					// Conditional creation preserves a file written while folder selection or I/O was pending.
					await files.writeFile({ resource, content }, { create: true, overwrite: false });
				} catch (error) {
					if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileExists)
						throw error;
				}
			}
			await editors.openEditor({ resource }, { pinned: true, ignoreError: true });
		}
	},
);

async function selectTaskTemplate(quickInput: IQuickInputService): Promise<ITaskEntry | undefined> {
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<ITaskEntry>());
	picker.ariaLabel = picker.placeholder = localize('tasks.configure.selectTemplate', 'Select a task template');
	picker.items = getTemplates();
	// Await inside the using scope so the picker survives asynchronous user input.
	return await new Promise(resolve => {
		let selected: ITaskEntry | undefined;
		lifetime.add(
			picker.onDidAccept(() => {
				selected = picker.selectedItems[0];
				if (selected) picker.hide();
			}),
		);
		lifetime.add(picker.onDidHide(() => resolve(selected)));
		picker.show();
	});
}
