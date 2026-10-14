import { Emitter, Event } from '../../../../base/common/event.js';
import { isLowSurrogate } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { DeferredPromise, raceCancellationError } from '../../../../base/common/async.js';
import { CancellationError, getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { formatMessageForTerminal } from '../../../../platform/terminal/common/terminalStrings.js';
import { escapeNonWindowsPath } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { GeneralShellType, PosixShellType } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IFileSearchService } from '../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { mergeEnvironments } from '../../terminal/common/terminalEnvironment.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ProcessPropertyType, type ITerminalChildProcess, type IProcessProperty, type IProcessReadyEvent, type IShellLaunchConfig, type TerminalProcessExecution, type TerminalArguments } from '../../../../platform/terminal/common/terminal.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ConfigurationResolverExpression, type Replacement, type IResolvedValue } from '../../../services/configurationResolver/common/configurationResolverExpression.js';
import { type IOutputChannel, type OutputEntrySeverity } from '../../../services/output/common/output.js';
import { readTaskOutput, ShellQuoting, type ITaskRun, type ITaskOutput, type IWorkspaceTask, type TaskRunStatus, type TaskPseudoterminal, type TaskShellExecution, type ShellQuotedString } from '../../../services/tasks/common/taskService.js';
import { type ITerminalCreateOptions, type ITerminalCommandStatusEvent, type ITerminalInstance, type ITerminalProfileSelection, ITerminalService } from '../../../services/terminal/browser/terminal.js';
import { parseShellExecution } from '../../../services/tasks/common/workspaceTasks.js';
import { parseProblemMatchers, type ProblemMatcher } from '../../../services/tasks/common/problemMatcher.js';
import { WatchingProblemCollector } from '../common/problemCollectors.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { ITerminalProfileResolverService } from '../../../services/terminal/common/terminal.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';

interface TaskTerminal {
	readonly terminal: ITerminalInstance;
	readonly folderId: string;
	readonly taskId: string;
	readonly panel: 'shared' | 'dedicated';
	idle: boolean;
}

interface ProblemSearchDirectory {
	readonly folder: IWorkspaceFolder;
	readonly include: URI;
	readonly exclude: readonly URI[];
}

/** Owns task command resolution, terminal dispatch, and execution lifetimes. */
export class TerminalTaskSystem extends Disposable {
	private readonly startEmitter = this._register(new Emitter<ITaskRun>());
	private readonly stateEmitter = this._register(new Emitter<ITaskRun>());
	private readonly runs = this._register(new DisposableMap<string, TaskRun>());
	private variableSnapshots = new WeakMap<ITaskRun, readonly [Replacement, IResolvedValue][]>();
	private readonly markerOwners = new Map<string, { readonly taskId: string; readonly runId: string; }>();
	private readonly taskTerminals = new Map<string, TaskTerminal>();
	public readonly onDidStartTask = this.startEmitter.event;
	public readonly onDidStateChange = this.stateEmitter.event;

	constructor(
		private readonly output: IOutputChannel,
		@ITerminalService private readonly terminals: ITerminalService,
		@IConfigurationResolverService private readonly resolver: IConfigurationResolverService,
		@ILogService private readonly logService: ILogService,
		@IMarkerService private readonly markers: IMarkerService,
		@IModelService private readonly models: IModelService,
		@IViewsService private readonly views: IViewsService,
		@IFileSearchService private readonly fileSearch: IFileSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IPathService private readonly paths: IPathService,
		@ITerminalProfileResolverService private readonly profiles: ITerminalProfileResolverService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(terminals.onDidDisposeInstance(terminal => this.taskTerminals.delete(terminal.id)));
	}

	public get activeRuns(): readonly ITaskRun[] { return [...this.runs].map(([, run]) => run).filter(run => run.status === 'running'); }

	private problemSearchDirectories(paths: ProblemMatcher['searchPaths'], taskFolder: IWorkspaceFolder): readonly ProblemSearchDirectory[] {
		if (!paths) return [];
		const resource = (path: string): URI => taskFolder.uri.scheme === 'file' ? URI.file(path) : taskFolder.uri.with({ path: path.replaceAll('\\', '/') });
		const exclude = paths.exclude.map(resource);
		return paths.include.map(path => {
			const include = resource(path);
			const folder = this.workspace.getWorkspaceFolder(include);
			if (!path || path.includes('\0') || !folder) throw new RangeError(localize('tasks.problemSearchScope', "Problem matcher search directory '{0}' is outside the current workspace.", path));
			return { folder, include, exclude: exclude.filter(value => extUriBiasedIgnorePathCase.isEqualOrParent(value, include)) };
		});
	}

	private async searchProblemFile(file: string, directories: readonly ProblemSearchDirectory[], signal: AbortSignal): Promise<URI | undefined> {
		const filename = file.replaceAll('\\', '/');
		// Character classes quote literal glob metacharacters in both the browser
		// grammar and the Workspace engine, without turning backslashes into paths.
		const escape = (value: string): string => value.replace(/[?*[{]/g, character => `[${character}]`);
		for (const directory of directories) {
			if (directory.exclude.some(value => extUriBiasedIgnorePathCase.isEqual(value, directory.include))) continue;
			const relative = directory.include.path.slice(directory.folder.uri.path.length).replace(/^\/+|\/+$/g, '');
			const suffix = filename.startsWith(directory.folder.uri.path + '/') ? filename.slice(directory.folder.uri.path.length + 1) : filename.replace(/^\/+/, '');
			if (!suffix || suffix.split('/').some(part => part === '..')) continue;
			const prefix = relative ? `${escape(relative)}/` : '';
			const pattern = `${prefix}**/*${escape(suffix)}`;
			const found = await this.fileSearch.glob({ resource: directory.folder.uri, target: { type: 'workspace', dirId: directory.folder.id } }, {
				includePatterns: [pattern.startsWith('!') ? `{${pattern}}` : pattern],
				excludePatterns: directory.exclude.map(value => {
					const pattern = escape(value.path.slice(directory.folder.uri.path.length).replace(/^\/+/, ''));
					return pattern.startsWith('!') ? `{${pattern}}` : pattern;
				}),
				maxResults: 5000,
			}, signal);
			const candidates = found.matches.filter(value => extUriBiasedIgnorePathCase.isEqualOrParent(value.resource, directory.include) && value.resource.path.endsWith(filename));
			candidates.sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
			if (candidates[0]) return candidates[0].resource;
		}
		return undefined;
	}

	public validate(task: IWorkspaceTask): void {
		parseProblemMatchers(task.problemMatchers ?? []);
	}

	public cancelAll(): void {
		this.taskTerminals.clear();
		this.variableSnapshots = new WeakMap();
		for (const run of this.activeRuns) {
			void this.terminate(run).catch(error => this.log('error', errorMessage(error)));
		}
		for (const owner of this.markerOwners.keys()) {
			this.markers.changeAll(owner, []);
		}
		this.markerOwners.clear();
	}

	protected override disposeCore(): void {
		this.cancelAll();
		super.disposeCore();
	}

	public async run(task: IWorkspaceTask, folder: IWorkspaceFolder, assertCurrent: () => void, signal?: AbortSignal, previousRun?: ITaskRun, onStarted?: (run: ITaskRun) => void, runId?: string): Promise<ITaskRun> {
		if (!task.command && task.dependsOn?.length) {
			assertCurrent();
			this.assertNotDisposed();
			const run: ITaskRun = Object.freeze({ task, runId: runId ?? generateUuid(), terminalId: '', status: 'succeeded', exitCode: 0, onDidChangeStatus: Event.None, readOutput: (cursor: number, limit: number) => readTaskOutput('', 0, cursor, limit) });
			onStarted?.(run);
			this.startEmitter.fire(run);
			this.stateEmitter.fire(run);
			return run;
		}
		// Retained extension metadata is not executable configuration; resolving it
		// could invoke a command variable that the task never uses.
		const matchers = parseProblemMatchers(task.problemMatchers ?? []);
		// Resolve file prefixes with execution variables, while regular expressions
		// stay literal and cannot accidentally invoke a command variable.
		const configuration = { command: task.command, execution: task.execution, definition: task.execution?.type === 'custom' ? task.definition : undefined, cwd: task.cwd, matcherPrefixes: matchers.map(matcher => matcher.filePrefix), matcherSearchPaths: matchers.map(matcher => matcher.searchPaths), ...(task.environment === undefined ? {} : { env: task.environment }) };
		const expression = ConfigurationResolverExpression.parse(configuration);
		if (previousRun && task.runOptions?.reevaluateOnRerun === false) {
			for (const [reference, value] of this.variableSnapshots.get(previousRun) ?? []) {
				expression.resolve(reference, value);
			}
		}
		// Standard Task commands receive variable strings, not internal execution
		// records. Custom callbacks and absent optional fields never cross Host JSON.
		const resolution = this.resolver.resolveWithInteraction(folder, [...expression.unresolved()].map(reference => reference.id), 'tasks');
		const values = await (signal ? raceCancellationError(resolution, signal) : resolution);
		assertCurrent();
		this.assertNotDisposed();
		if (!values) {
			throw new CancellationError();
		}
		for (const reference of expression.unresolved()) {
			const value = values.get(reference.inner);
			if (value !== undefined) expression.resolve(reference, value);
		}
		const resolved = expression.toObject();
		if (!resolved.command.trim() || resolved.command.includes('\0')) {
			throw new Error(localize('tasks.invalidResolvedCommand', 'The resolved task command is empty or contains an invalid character.'));
		}
		const runtimeMatchers: ProblemMatcher[] = matchers.map((matcher, index) => ({ ...matcher, filePrefix: resolved.matcherPrefixes[index], searchPaths: resolved.matcherSearchPaths[index] }));
		const searchDirectories = new Map(runtimeMatchers.map(matcher => [matcher, this.problemSearchDirectories(matcher.searchPaths, folder)]));
		let execution: TerminalProcessExecution | undefined;
		let profile: ITerminalProfileSelection = { type: 'default' };
		let launch: IShellLaunchConfig | undefined;
		let os: OperatingSystem | undefined;
		const configuredEnvironments = this.configuration.getValue<
			Readonly<Record<string, Readonly<Record<string, string | null>>>>
		>('terminal.integrated.env') ?? {};
		const needsShell = resolved.execution === undefined || resolved.execution.type === 'shell';
		const needsEnvironment = Object.values(configuredEnvironments).some(env => Object.keys(env).length > 0)
			|| Object.keys(resolved.env ?? {}).length > 0;
		if (resolved.execution?.type !== 'custom' && (needsShell || needsEnvironment)) {
			const platform = this.paths.getOperatingSystem(folder.uri);
			os = await (signal ? raceCancellationError(platform, signal) : platform);
			assertCurrent();
			this.assertNotDisposed();
			if (os === undefined) throw new Error(localize('tasks.shellUnavailable', 'No shell is available to execute this task.'));
		}
		if (resolved.execution?.type === 'process') {
			execution = resolved.execution;
		} else if (resolved.execution?.type === 'shell' || resolved.execution === undefined) {
			// Variable results may contain spaces or shell metacharacters. Preserve
			// their argument boundaries until the actual shell has been selected.
			const shell = resolved.execution ? parseShellExecution(resolved.execution) : { type: 'shell' as const, command: resolved.command, args: [] };
			const executable = shell.options?.executable;
			let shellName: string;
			let shellPath: string;
			if (executable) {
				shellPath = executable;
				shellName = executable.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase();
				launch = { executable, args: shell.options?.shellArgs };
			} else {
				const resolution = this.profiles.getDefaultProfile({ os: os!, remoteAuthority: getRemoteAuthority(folder.uri), allowAutomationShell: true });
				const selected = await (signal ? raceCancellationError(resolution, signal) : resolution);
				assertCurrent();
				this.assertNotDisposed();
				const path = typeof selected.path === 'string' ? selected.path : selected.path[0]!;
				shellPath = path;
				profile = selected.isAutoDetected
					? { type: 'profile', profileId: selected.profileId }
					: { type: 'custom', name: selected.profileName, path: [path], args: selected.args ?? [] };
				launch = { executable: path, args: shell.options?.shellArgs ?? selected.args, env: selected.env ?? {} };
				shellName = path.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase();
			}
			const commandLine = resolved.execution ? shellCommandLine(shell, shellName) : resolved.command;
			execution = executable || profile.type === 'custom' || launch.args?.length || shell.options?.shellArgs !== undefined || usesWindowsCommandLine(shellName, os!) ? {
				type: 'process', program: shellPath,
				args: taskShellArguments(shellName, launch.args ?? [], commandLine, os!, executable !== undefined),
			} : { type: 'shell', commandLine };
		}
		let environment = resolved.env;
		if (os !== undefined) {
			const resolution = (async () => {
				const platform = os === OperatingSystem.Windows ? 'windows' : os === OperatingSystem.Macintosh ? 'osx' : 'linux';
				const caseSensitive = os !== OperatingSystem.Windows;
				const env: Record<string, string | null> = {};
				mergeEnvironments(env, configuredEnvironments[platform], caseSensitive);
				mergeEnvironments(env, launch?.env, caseSensitive);
				if (Object.keys(env).length) {
					const inherited = await this.profiles.getEnvironment(folder.uri.authority || undefined);
					for (const [key, value] of Object.entries(env)) {
						env[key] = value === null ? null : await this.resolver.resolveWithEnvironment(inherited, folder, value);
					}
				}
				// Task variables have already been resolved, including command results
				// that may contain variable syntax intended as literal text.
				mergeEnvironments(env, resolved.env, caseSensitive);
				return Object.keys(env).length || resolved.env !== undefined || launch?.env !== undefined
					? Object.freeze(env) : undefined;
			})();
			environment = await (signal ? raceCancellationError(resolution, signal) : resolution);
			assertCurrent();
			this.assertNotDisposed();
		}
		this.log('information', `Starting task '${task.label}' (${task.id}).`);
		const commandText = execution?.type === 'process'
			? typeof execution.args === 'string' ? `${JSON.stringify(execution.program)} ${execution.args}` : [execution.program, ...execution.args].map(value => JSON.stringify(value)).join(' ')
			: execution?.commandLine;
		const initialText = task.presentation?.echo !== false && commandText !== undefined
			? { text: formatMessageForTerminal(localize('tasks.executingCommand', 'Executing task: {0}', commandText)), trailingNewLine: false } : undefined;
		let waitOnExit: IShellLaunchConfig['waitOnExit'] = !task.presentation?.close;
		if (waitOnExit && (task.presentation?.reveal !== 'never' || !task.isBackground || task.presentation?.close === false)) {
			if (task.presentation?.panel === 'new') waitOnExit = localize('tasks.terminalCloseMessage', 'Press any key to close the terminal.');
			else if (task.presentation?.showReuseMessage !== false) waitOnExit = localize('tasks.terminalReuseMessage', 'Terminal will be reused by tasks, press any key to close it.');
		}
		let pty: TaskPseudoterminal | undefined;
		let ptyClosed = false;
		const closePty = (value: TaskPseudoterminal | undefined = pty): void => {
			if (!ptyClosed && value) {
				ptyClosed = true;
				value.close();
			}
		};
		if (resolved.execution?.type === 'custom') {
			const creation = Promise.resolve(resolved.execution.callback(resolved.definition ?? { type: 'custom' }));
			// A provider may return a PTY after cancellation. Its owner must still close it.
			void creation.then(value => { if (signal?.aborted || this.isDisposed) closePty(value); }).catch(error => this.log('error', `Custom task resource failed: ${errorMessage(error)}`));
			pty = await (signal ? raceCancellationError(creation, signal) : creation);
			try { assertCurrent(); } catch (error) { closePty(); throw error; }
		}
		let terminal: ITerminalInstance;
		// Reserving an idle instance synchronously keeps overlapping preparations from sharing a process.
		const panel = task.presentation?.panel ?? 'shared';
		const reusable = panel === 'new' ? undefined : [...this.taskTerminals.values()].find(slot => slot.idle && slot.folderId === folder.id && slot.panel === panel && (panel === 'shared' || slot.taskId === task.id) && this.terminals.instances.includes(slot.terminal));
		if (reusable) reusable.idle = false;
		try {
			const options: ITerminalCreateOptions = pty ? {
				dirId: folder.id, dimensions: { rows: 24, cols: 80 }, title: `Task: ${task.label}`, deferStart: true,
				config: {
					name: task.label, isFeatureTerminal: true,
					waitOnExit,
					customPtyImplementation: (id, cols, rows) => new TaskTerminalProcess(id, {
						onDidWrite: pty!.onDidWrite, onDidClose: pty!.onDidClose, onDidChangeName: pty!.onDidChangeName,
						open: dimensions => pty!.open(dimensions), close: () => closePty(),
						handleInput: pty!.handleInput?.bind(pty), setDimensions: pty!.setDimensions?.bind(pty),
					}, cols, rows),
				},
			} : {
				dirId: folder.id, dimensions: { rows: 24, cols: 80 }, profile, title: `Task: ${task.label}`,
				deferStart: true,
				waitOnExit,
				...(initialText === undefined ? {} : { initialText }),
				...(environment === undefined ? {} : { env: environment }),
				...(resolved.cwd === undefined ? {} : { cwd: resolved.cwd }),
				...(execution === undefined ? {} : { execution }),
			};
			if (reusable) {
				terminal = reusable.terminal;
				if (task.presentation?.clear) terminal.clearBuffer();
				await terminal.reuseTerminal(options.config ? { ...options.config, name: options.title, deferStart: true } : {
					executable: launch?.executable, args: launch?.args,
					name: options.title, env: options.env, cwd: options.cwd, execution: options.execution, initialText: options.initialText, waitOnExit: options.waitOnExit, deferStart: true,
				});
				this.terminals.setActiveInstance(terminal);
			} else {
				terminal = await this.terminals.createTerminal(options);
			}
		} catch (error) {
			closePty();
			if (reusable) {
				this.taskTerminals.delete(reusable.terminal.id);
				await this.closeTerminal(reusable.terminal);
			}
			this.log('error', `Could not create a terminal for task '${task.label}': ${errorMessage(error)}`);
			throw error;
		}
		try {
			// A workspace switch or disposal can finish while the backend creates the terminal.
			// The returned handle must be closed before any command or run event is published.
			assertCurrent();
			this.assertNotDisposed();
			if (terminal.state !== 'running' && !((resolved.execution || resolved.cwd) && terminal.state === 'exited')) {
				throw new Error(localize('tasks.terminalUnavailable', 'The terminal is unavailable. The task was not started. Run the task again.'));
			}
		} catch (error) {
			await this.closeTerminal(terminal);
			throw error;
		}
		const executionId = runId ?? generateUuid();
		const activeRunIds = new Set(this.activeRuns.map(run => run.runId));
		// A new invocation replaces this task's completed diagnostics. Concurrent
		// producers keep separate owners until their own compilation or retirement.
		for (const [owner, entry] of this.markerOwners) {
			if (entry.taskId === task.id && !activeRunIds.has(entry.runId)) {
				this.markers.changeAll(owner, []);
				this.markerOwners.delete(owner);
			}
		}
		const collector = new WatchingProblemCollector(runtimeMatchers, folder.uri, this.markers, executionId, resource => this.models.getModel(resource) !== null, (file, matcher, signal) => this.searchProblemFile(file, searchDirectories.get(matcher) ?? [], signal));
		for (const owner of collector.owners) {
			this.markerOwners.set(owner, { taskId: task.id, runId: executionId });
		}
		let revealing: Promise<void> | undefined;
		const run = new TaskRun(task, terminal, collector, current => {
			const exit = current.exitCode === undefined ? '' : ` (exit code ${current.exitCode})`;
			this.log(current.status === 'failed' ? 'error' : current.status === 'canceled' ? 'warning' : 'information', `Task '${current.task.label}' ${current.status}${exit}.`);
			this.stateEmitter.fire(current);
			// Retained runs keep their output artifact; completed runs no longer own listeners.
			if (current.status !== 'running') this.runs.deleteAndDispose(current.terminalId);
		}, pty?.releaseCompletion, () => {
			if ((task.presentation?.revealProblems ?? 'never') === 'never' && task.presentation?.reveal === 'silent') revealing = this.revealTerminal(terminal, task.presentation?.focus === true);
		}, () => {
			if (task.presentation?.revealProblems === 'onProblem') revealing = this.revealProblems(true);
		}, async error => {
			this.log('error', errorMessage(error));
			await this.closeTerminal(terminal);
		}, executionId);
		this.runs.set(terminal.id, run);
		let slot: TaskTerminal | undefined;
		if (panel !== 'new' && !task.presentation?.close) {
			slot = { terminal, folderId: folder.id, taskId: task.id, panel, idle: false };
			this.taskTerminals.set(terminal.id, slot);
		}
		void run.completion.then(async () => {
			if (this.isDisposed) return;
			if (task.presentation?.revealProblems === 'onProblem' && !run.hasBackgroundMatcher && run.hasProblems) {
				revealing = this.revealProblems(false);
			} else if (!revealing && task.presentation?.reveal === 'silent' && (run.status === 'failed' || run.hasErrors)) {
				revealing = this.revealTerminal(terminal, task.presentation?.focus === true);
			}
			if (revealing) await revealing;
			if (task.presentation?.close) await this.closeTerminal(terminal);
			// Release and the run's final reveal must finish before another task can reserve this screen.
			if (slot && this.taskTerminals.get(terminal.id) === slot) {
				if (run.status === 'canceled') this.taskTerminals.delete(terminal.id);
				else slot.idle = true;
			}
		}, () => { if (slot && this.taskTerminals.get(terminal.id) === slot) this.taskTerminals.delete(terminal.id); });
		this.variableSnapshots.set(run, [...expression.resolved()]);
		onStarted?.(run);
		this.startEmitter.fire(run);
		try {
			// A start listener may synchronously change workspace or dispose the service.
			assertCurrent();
			this.assertNotDisposed();
			if (task.presentation?.revealProblems === 'always') {
				revealing = this.revealProblems(false);
				await revealing;
				assertCurrent();
				this.assertNotDisposed();
			} else if ((task.presentation?.reveal ?? 'always') === 'always') {
				await this.revealTerminal(terminal, task.presentation?.focus === true);
				assertCurrent();
				this.assertNotDisposed();
			}
			terminal.start();
			if (terminal.state === 'exited') {
				run.finish(terminal.exitCode);
			}
		} catch (error) {
			run.fail(isCancellationError(error));
			this.log('error', localize('tasks.terminalSendFailed', "Could not send task '{0}': {1}", task.label, errorMessage(error)));
			try { await this.terminals.closeTerminal(terminal); run.completeExecution(undefined); await run.completion; }
			catch (closeError) { run.rejectCompletion(closeError); this.log('error', localize('tasks.terminalCloseFailed', 'Could not close the task terminal: {0}', errorMessage(closeError))); }
			throw error;
		}
		this.log('debug', `Task '${task.label}' is running in terminal '${terminal.id}'.`);
		return run;
	}

	private async revealTerminal(terminal: ITerminalInstance, focus: boolean): Promise<void> {
		if (this.isDisposed || !this.terminals.instances.includes(terminal)) return;
		this.terminals.setActiveInstance(terminal);
		try { await this.views.openView(TERMINAL_VIEW_ID, focus); }
		catch (error) { this.log('error', errorMessage(error)); }
	}

	private async revealProblems(focus: boolean): Promise<void> {
		if (this.isDisposed) return;
		try { await this.views.openViewContainer(WorkbenchViewContainerId.Problems, focus); }
		catch (error) { this.log('error', errorMessage(error)); }
	}

	public async terminate(run: ITaskRun): Promise<void> {
		const owned = this.runs.get(run.terminalId);
		if (owned !== run) {
			return;
		}
		this.log('warning', `Terminating task '${run.task.label}'.`);
		owned.cancel();
		try { await this.terminals.closeTerminal(owned.terminal); owned.completeExecution(undefined); await owned.completion; }
		catch (error) { owned.rejectCompletion(error); throw error; }
	}

	private async closeTerminal(terminal: ITerminalInstance): Promise<void> {
		try {
			await this.terminals.closeTerminal(terminal);
		} catch (error) {
			this.log('error', localize('tasks.terminalCloseFailed', 'Could not close the task terminal: {0}', errorMessage(error)));
		}
	}

	private log(severity: OutputEntrySeverity, text: string): void {
		if (!this.isDisposed) {
			this.output.appendLine({ severity, category: 'execution', text });
		}
		if (severity === 'error') {
			this.logService.error('tasks.execution', text);
		} else if (severity === 'warning') {
			this.logService.warn('tasks.execution', text);
		} else if (severity === 'debug') {
			this.logService.debug('tasks.execution', text);
		} else {
			this.logService.info('tasks.execution', text);
		}
	}
}

class TaskRun extends Disposable implements ITaskRun {
	private outputText = '';
	private outputStart = 0;
	private outputEnd = 0;
	private readonly changeEmitter = this._register(new Emitter<TaskRunStatus>());
	private commandId: string | undefined;
	private _status: TaskRunStatus = 'running';
	private _exitCode: number | undefined;
	private readonly completionResult = new DeferredPromise<number | undefined>();
	public readonly completion = this.completionResult.p;
	public readonly processCompletion: Promise<number | undefined> | undefined;
	public readonly processId: number | undefined;
	public readonly onDidChangeStatus: Event<TaskRunStatus> = this.changeEmitter.event;
	private collectionCompletion: Promise<void> | undefined;

	constructor(public readonly task: IWorkspaceTask, public readonly terminal: ITerminalInstance, private readonly collector: WatchingProblemCollector, private readonly onChange: (run: TaskRun) => void, private readonly customRelease?: Promise<void>, onError?: () => void, onBackgroundProblem?: () => void, onCollectionError?: (error: unknown) => Promise<void>, public readonly runId: string = generateUuid()) {
		super();
		this.processId = terminal.processId > 0 && task.execution?.type !== 'custom' ? terminal.processId : undefined;
		this.processCompletion = this.processId === undefined ? undefined : this.completion;
		// TerminalTaskSystem reports release failures even when no extension observes this run.
		void this.completion.catch(() => undefined);
		this._register(collector);
		this._register(collector.onDidBecomeReady(() => {
			if (collector.hasErrors) onBackgroundProblem?.();
		}));
		let errorRevealed = false;
		this._register(collector.onDidChangeProblems(() => {
			if (!errorRevealed && collector.hasErrors) { errorRevealed = true; onError?.(); }
		}));
		this._register(collector.onDidError(error => {
			this.collectionCompletion = Promise.resolve(onCollectionError?.(error)).then(() => { throw error; });
			this.fail(false);
			this.completeExecution(undefined);
		}));
		this._register(terminal.onDidWriteData(event => {
			this.appendOutput(event.data);
			collector.accept(new TextEncoder().encode(event.data));
		}));
		this._register(terminal.onDidChangeCommandStatus(event => this.acceptCommandStatus(event)));
		this._register(terminal.onDidExit(exitCode => {
			if (this._status === 'running') {
				this.finish(exitCode);
			}
		}));
		this._register(terminal.onDidChangeState(state => {
			if (this._status === 'running' && (state === 'disconnected' || state === 'error')) {
				this.fail(state !== 'error');
				this.completeExecution(undefined);
			}
		}));
	}

	private appendOutput(text: string): void {
		this.outputText += text;
		this.outputEnd += text.length;
		if (this.outputText.length > 1_048_576) {
			let start = this.outputText.length - 1_048_576;
			if (isLowSurrogate(this.outputText.charCodeAt(start))) start++;
			this.outputText = this.outputText.slice(start);
			this.outputStart = this.outputEnd - this.outputText.length;
		}
	}
	public get terminalId(): string { return this.terminal.id; }
	public readOutput(cursor: number, maxCharacters: number): ITaskOutput {
		return readTaskOutput(this.outputText, this.outputStart, cursor, maxCharacters);
	}
	public get status(): TaskRunStatus { return this._status; }
	public get exitCode(): number | undefined { return this._exitCode; }
	public get isReady(): boolean { return this.task.isBackground === true && this.collector.isReady; }
	public get hasBackgroundMatcher(): boolean { return this.collector.isWatching; }
	public get hasErrors(): boolean { return this.collector.hasErrors; }
	public get hasProblems(): boolean { return this.collector.hasProblems; }
	public get onDidBecomeReady(): Event<void> { return this.collector.onDidBecomeReady; }

	public cancel(): void { this.stopCollection(); this.setStatus('canceled', undefined); }
	public fail(canceled: boolean): void { this.stopCollection(); this.setStatus(canceled ? 'canceled' : 'failed', undefined); }

	private stopCollection(): void {
		const pending = this.collector.hasPendingResolutions;
		this.collector.cancelSearch();
		if (pending) {
			// A fresh barrier survives clearing queued work and waits for the active
			// search's cancellation acknowledgment before releasing this run.
			this.collectionCompletion = Promise.allSettled([this.collectionCompletion, this.collector.flush()]).then(results => {
				const failure = results.find(result => result.status === 'rejected');
				if (failure?.status === 'rejected') throw failure.reason;
			});
		}
	}
	public finish(exitCode: number | undefined, status: TaskRunStatus = exitCode === undefined ? 'completed' : exitCode === 0 ? 'succeeded' : 'failed'): void {
		if (this._status !== 'running' || this.collectionCompletion) return;
		this.collector.done();
		if (this.collector.hasPendingResolutions) {
			// Keep the run and collector alive until asynchronous resources are
			// published; completion observers must see the final diagnostics.
			this.collectionCompletion = this.collector.flush().then(() => this.setStatus(status, exitCode));
		} else this.setStatus(status, exitCode);
		this.completeExecution(exitCode);
	}
	public completeExecution(exitCode: number | undefined): void {
		const collectionCompletion = this.collectionCompletion;
		void Promise.allSettled([collectionCompletion, this.customRelease]).then(results => {
			if (collectionCompletion !== this.collectionCompletion) return;
			const failure = results.find(result => result.status === 'rejected');
			if (failure?.status === 'rejected') this.rejectCompletion(failure.reason);
			else if (!this.completionResult.isSettled) void this.completionResult.complete(this._status === 'canceled' ? undefined : exitCode);
		});
	}
	public rejectCompletion(error: unknown): void { if (!this.completionResult.isSettled) void this.completionResult.error(error); }

	private acceptCommandStatus(event: ITerminalCommandStatusEvent): void {
		if (!this.commandId && event.status === 'running') {
			this.commandId = event.commandId;
		}
		if (event.commandId !== this.commandId || event.status === 'running') {
			return;
		}
		this.finish(event.exitCode, event.status);
	}

	private setStatus(status: TaskRunStatus, exitCode: number | undefined): void {
		if (this._status !== 'running') {
			return;
		}
		this._status = status;
		this._exitCode = exitCode;
		this.collector.done();
		this.changeEmitter.fire(status);
		this.onChange(this);
	}
}

function shellInvocationArguments(shellName: string): readonly string[] {
	if (shellName === 'cmd' || shellName === 'command-prompt') return ['/d', '/s', '/c'];
	if (['powershell', 'windows-powershell', 'pwsh'].includes(shellName)) return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
	return ['-c'];
}

function taskShellArguments(shellName: string, args: TerminalArguments, commandLine: string, os: OperatingSystem, explicitShell: boolean): TerminalArguments {
	// Profiles may already include a command flag; adding a second one would
	// turn the intended command into a shell option instead of executing it.
	const commandFlag = shellName === 'cmd' ? /^\/c$/i : ['powershell', 'pwsh'].includes(shellName) ? /^-command$/i
		: shellName === 'wsl' ? /^(?:-e|--exec)$/i : /^-[il]*c[il]*$/;
	const raw = typeof args === 'string';
	const hasFlag = raw
		? (args.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? []).some(arg => commandFlag.test(arg.replace(/^"(.*)"$/, '$1')))
		: args.some(arg => commandFlag.test(arg));
	const defaults = explicitShell || hasFlag ? [] : os === OperatingSystem.Windows
		? ['powershell', 'pwsh'].includes(shellName) ? ['-Command']
			: shellName === 'wsl' ? ['-e'] : ['bash', 'zsh', 'fish', 'nu'].includes(shellName) ? ['-c'] : ['/d', '/c']
		: shellInvocationArguments(shellName);
	if (raw || usesWindowsCommandLine(shellName, os)) {
		const prefix = raw ? args : args.map(arg => /[\s"]/.test(arg) || arg.length === 0 ? quoteWindowsArgument(arg) : arg).join(' ');
		const command = raw && ['bash', 'zsh', 'fish'].includes(shellName) ? quoteWindowsArgument(commandLine) : commandLine;
		const result = [prefix, ...defaults, command].filter(value => value.length > 0).join(' ');
		if (result.length > 32768 || result.includes('\0')) throw new TypeError(localize('terminal.profile.invalidArguments', 'The terminal arguments are too large or contain NUL.'));
		return result;
	}
	return [...args, ...defaults, commandLine];
}

function usesWindowsCommandLine(shellName: string, os: OperatingSystem): boolean {
	return os === OperatingSystem.Windows && !['bash', 'zsh', 'fish'].includes(shellName);
}

function quoteWindowsArgument(value: string): string {
	return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

function shellCommandLine(execution: TaskShellExecution, shellName: string): string {
	if (execution.commandLine !== undefined) return execution.commandLine;
	const powershell = ['powershell', 'windows-powershell', 'pwsh'].includes(shellName);
	const commandPrompt = shellName === 'cmd' || shellName === 'command-prompt';
	const supplied = execution.options?.shellQuoting;
	const strong = supplied?.strong ?? (commandPrompt ? '"' : "'");
	const weak = supplied?.weak ?? '"';
	const escape = supplied?.escape ?? { escapeChar: powershell ? '`' : commandPrompt ? '^' : '\\', charsToEscape: ' \\"\'' };

	const quote = (argument: string | ShellQuotedString): string => {
		const value = typeof argument === 'string' ? argument : argument.value;
		let kind = typeof argument === 'string' ? undefined : argument.quoting;
		if (kind === undefined) {
			// Already quoted shell expressions retain their expansion behavior.
			const alreadyQuoted = value.length >= 2 && [strong, weak].includes(value[0]!) && value.at(-1) === value[0];
			if (value && (!/\s/.test(value) || alreadyQuoted)) return value;
			kind = ShellQuoting.Strong;
		}
		if (kind === ShellQuoting.Escape) {
			const character = typeof escape === 'string' ? escape : escape.escapeChar;
			const characters = typeof escape === 'string' ? ' ' : escape.charsToEscape;
			return [...value].map(item => characters.includes(item) ? character + item : item).join('');
		}
		const delimiter = kind === ShellQuoting.Strong ? strong : weak;
		let content: string;
		if (delimiter === "'") {
			return escapeNonWindowsPath(value, powershell ? GeneralShellType.PowerShell : shellName === 'fish' ? PosixShellType.Fish : undefined);
		} else {
			const character = powershell ? '`' : commandPrompt ? '^' : '\\';
			content = value.replaceAll(character, character + character).replaceAll(delimiter, character + delimiter);
		}
		return delimiter + content + delimiter;
	};
	const command = quote(execution.command);
	const argumentsList = execution.args.map(quote);
	let commandLine = [command, ...argumentsList].join(' ');
	if (powershell && command !== (typeof execution.command === 'string' ? execution.command : execution.command.value)) commandLine = '& ' + commandLine;
	if (commandPrompt && command.startsWith('"') && argumentsList.some(argument => argument.startsWith('"'))) commandLine = '"' + commandLine + '"';
	if (commandLine.length > 32768 || commandLine.includes('\0')) throw new TypeError('Resolved shell command is too large or contains NUL');
	return commandLine;
}

class TaskTerminalProcess extends Disposable implements ITerminalChildProcess {
	private readonly dataEmitter = this._register(new Emitter<string>());
	private readonly readyEmitter = this._register(new Emitter<IProcessReadyEvent>());
	private readonly exitEmitter = this._register(new Emitter<number | undefined>());
	private readonly propertyEmitter = this._register(new Emitter<IProcessProperty>());
	private started = false;
	private closed = false;
	public readonly shouldPersist = false;
	public readonly onProcessData = this.dataEmitter.event;
	public readonly onProcessReady = this.readyEmitter.event;
	public readonly onProcessExit = this.exitEmitter.event;
	public readonly onDidChangeProperty = this.propertyEmitter.event;
	public readonly input: ((data: string) => void) | undefined;

	constructor(public readonly id: number, private readonly pty: TaskPseudoterminal, private columns: number, private rows: number) {
		super();
		if (typeof pty?.onDidWrite !== 'function' || typeof pty.open !== 'function' || typeof pty.close !== 'function') {
			throw new TypeError('CustomExecution must return a Pseudoterminal');
		}
		this.input = pty.handleInput ? data => { if (!this.closed) pty.handleInput!(data); } : undefined;
		this._register(pty.onDidWrite(data => { if (!this.closed) this.dataEmitter.fire(data); }));
		if (pty.onDidClose) {
			this._register(pty.onDidClose(code => {
				if (!this.closed) {
					this.closed = true;
					this.exitEmitter.fire(typeof code === 'number' ? code : undefined);
				}
			}));
		}
		if (pty.onDidChangeName) {
			this._register(pty.onDidChangeName(value => { if (!this.closed) this.propertyEmitter.fire({ type: ProcessPropertyType.Title, value }); }));
		}
	}

	public async start(): Promise<void> {
		if (this.started || this.closed) return;
		this.started = true;
		this.readyEmitter.fire({ pid: -1, cwd: '' });
		this.pty.open({ columns: this.columns, rows: this.rows });
	}

	public resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		if (this.started && !this.closed) this.pty.setDimensions?.({ columns, rows });
	}

	public shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		this.pty.close();
	}

	protected override disposeCore(): void {
		this.shutdown();
		super.disposeCore();
	}
}

function errorMessage(error: unknown): string { return getErrorMessage(error).slice(0, 4096); }
