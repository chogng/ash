import { commands as ashCommands, languages as ashLanguages, workspace as ashWorkspace, window as ashWindow, tasks as ashTasks, debug as ashDebug, __runtime as ashRuntime, CancellationTokenSource } from '@ash/extension';

// This is the public editor contract inside the confined process. Editor models and UI
// remain with the initiating client; this module owns only extension callback lifetimes.
export function createApi(configuration, initialization) {
	const titles = new Map();
	if (!Array.isArray(configuration.commands)) throw new TypeError('Invalid command contributions');
	for (const entry of configuration.commands) {
		if (typeof entry.command !== 'string' || !entry.command || typeof entry.title !== 'string' || !entry.title || titles.has(entry.command)) {
			throw new TypeError('Invalid command contribution');
		}
		titles.set(entry.command, entry.title);
	}
	const pending = new Map();
	let subscriptions;
	let providerSequence = 0;
	const documents = new Map();
	// Live documents can change during an await; diagnostic versions belong to the invocation's reads.
	const observedDocuments = new Map();
	const documentListeners = { open: new Set(), change: new Set(), close: new Set() };
	let documentRegistration;
	let collectionSequence = 0;
	const statusItems = new Map();
	const statusFlushes = new Set();
	let statusSequence = 0;
	let statusRevision = 1;
	let statusActive = false;
	let activationPromise;
	let activationExports;
	let statusDisposed = false;
	const statusRegistrationId = 'vscode.statusBar';
	const taskTypes = new Set();
	const fetchedTaskIds = new WeakMap();
	const fetchedTaskSnapshots = new WeakMap();
	// Execution provenance survives a public Task copy without moving the
	// provider's callback or retaining the fetched Task.
	const fetchedCustomExecutions = new WeakMap();
	const taskProblemRevealModes = new WeakMap();
	const providedTaskIds = new WeakMap();
	let providedTaskSequence = 0;
	const providedCustomExecutions = new Map();
	const taskExecutionHandles = new Map();
	const activeTaskExecutions = new Map();
	const pendingTaskExecutions = new Map();
	const taskListeners = { start: new Set(), end: new Set(), processStart: new Set(), processEnd: new Set() };
	let taskEventRegistration;
	let taskSnapshotSequence = 0;
	let taskEventSequence = 0;
	const taskStateSequences = new Map();
	const debuggerTypes = new Set((configuration.debuggers ?? []).map(value => value.type));
	const registeredDebuggerTypes = new Set();
	const debugSessions = new Map();
	const debugListeners = { start: new Set(), end: new Set(), active: new Set(), custom: new Set(), breakpoints: new Set(), stackItem: new Set() };
	let debugEventRegistration;
	let debugSequence = -1;
	let activeDebugSession;
	let activeStackItem;
	const debugBreakpoints = new Map();
	const breakpointStates = new WeakMap();
	let breakpointSequence = 0;

	function debugSession(value) {
		if (typeof value?.id !== 'string' || typeof value.type !== 'string' || typeof value.name !== 'string' || !value.configuration || typeof value.configuration !== 'object') throw new TypeError('Invalid debug session snapshot');
		let entry = debugSessions.get(value.id);
		if (!entry) {
			entry = { value, handle: undefined, parent: debugSessions.get(value.parentSessionId)?.handle };
			entry.handle = Object.freeze({
				id: value.id,
				get type() { return entry.value.type; },
				get parentSession() { return entry.value.parentSessionId == null ? undefined : entry.parent ??= debugSessions.get(entry.value.parentSessionId)?.handle; },
				get name() { return entry.value.name; },
				set name(name) {
					if (typeof name !== 'string' || name.length > 32768 || name.includes('\0')) throw new TypeError('Invalid debug session name');
					serviceOwner();
					entry.value = { ...entry.value, name };
					void request({ operation: 'setDebugSessionName', sessionId: value.id, name }, 'done');
				},
				get configuration() { return entry.value.configuration; },
				get workspaceFolder() {
					const folder = entry.value.workspaceFolder;
					return folder === null ? undefined : { uri: Uri.parse(folder.uri), name: folder.name, index: folder.index };
				},
				getDebugProtocolBreakpoint(breakpoint) {
					if (!(breakpoint instanceof Breakpoint)) throw new TypeError('Invalid debug breakpoint');
					return request({ operation: 'getDebugProtocolBreakpoint', sessionId: value.id, breakpointId: breakpoint.id }, 'debugResponse').then(result => result.hasBody ? result.value : undefined);
				},
				customRequest(command, args) {
					if (typeof command !== 'string' || !command || command.length > 256 || command.includes('\0')) throw new TypeError('Invalid Debug Adapter command');
					return request({ operation: 'debugCustomRequest', sessionId: value.id, command, arguments: args === undefined ? null : args, hasArguments: args !== undefined }, 'debugResponse').then(result => result.hasBody ? result.value : undefined);
				},
			});
			debugSessions.set(value.id, entry);
		} else entry.value = value;
		return entry.handle;
	}

	function listenDebug(kind, listener, thisArg, disposables) {
		if (typeof listener !== 'function') throw new TypeError('Debug event requires a listener');
		ensureDebugEvents();
		const entry = { listener, thisArg };
		debugListeners[kind].add(entry);
		const disposable = new Disposable(() => debugListeners[kind].delete(entry));
		disposables?.push(disposable);
		return disposable;
	}

	function ensureDebugEvents() {
		if (debugEventRegistration) return;
		debugEventRegistration = ashDebug.registerDebugEvents('vscode.debug.events', (_context, event) => invoke(async () => {
			if (!Number.isSafeInteger(event?.sequence) || event.sequence < 0) throw new TypeError('Invalid debug event sequence');
			if (event.sequence < debugSequence) return;
			debugSequence = event.sequence;
			if (event.type === 'snapshot') {
				if (!Array.isArray(event.sessions) || !Array.isArray(event.breakpoints)) throw new TypeError('Invalid debug snapshot');
				await applyBreakpointChanges(event.breakpoints, [...debugBreakpoints.values()].filter(point => !event.breakpoints.some(value => value.id === point.id)).map(encodeBreakpoint), []);
				const retained = new Set(event.sessions.map(value => { debugSession(value); return value.id; }));
				for (const id of debugSessions.keys()) if (!retained.has(id)) debugSessions.delete(id);
				activeDebugSession = event.activeSession === null ? undefined : debugSessions.get(event.activeSession)?.handle;
				await updateActiveStackItem(event.activeStackItem);
				return;
			}
			if (event.type === 'stackItem') { await updateActiveStackItem(event.item); return; }
			if (event.type === 'name') { debugSession(event.session); return; }
			if (event.type === 'breakpoints') { await applyBreakpointChanges(event.added, event.removed, event.changed); return; }
			if (!Object.hasOwn(debugListeners, event.type)) throw new TypeError('Invalid debug event');
			const session = event.session === null ? undefined : debugSession(event.session);
			if (event.type === 'active') activeDebugSession = session;
			const value = event.type === 'custom' ? { session, event: event.event, body: event.hasBody ? event.body : undefined } : session;
			try {
				await Promise.all([...debugListeners[event.type]].map(async entry => entry.listener.call(entry.thisArg, value)));
			} finally {
				if (event.type === 'end') debugSessions.delete(event.session.id);
			}
		}));
		subscriptions.push(debugEventRegistration);
	}

	async function updateActiveStackItem(value) {
		let item;
		if (value !== undefined && value !== null) {
			if (!['thread', 'frame'].includes(value.kind) || !Number.isSafeInteger(value.threadId) || value.kind === 'frame' && !Number.isSafeInteger(value.frameId)) throw new TypeError('Invalid active debug stack item');
			const session = debugSession(value.session);
			if (activeStackItem?.session === session && activeStackItem.threadId === value.threadId && (activeStackItem instanceof DebugStackFrame ? activeStackItem.frameId : undefined) === (value.kind === 'frame' ? value.frameId : undefined)) return;
			item = value.kind === 'frame' ? new DebugStackFrame(session, value.threadId, value.frameId) : new DebugThread(session, value.threadId);
		}
		if (item === activeStackItem) return;
		activeStackItem = item;
		await Promise.all([...debugListeners.stackItem].map(async entry => entry.listener.call(entry.thisArg, item)));
	}

	function encodeBreakpoint(point) {
		if (!(point instanceof SourceBreakpoint) && !(point instanceof FunctionBreakpoint)) throw new TypeError('Unsupported breakpoint type');
		const state = breakpointStates.get(point);
		return {
			id: point.id, enabled: point.enabled,
			...(point instanceof SourceBreakpoint ? { kind: 'source', uri: point.location.uri.toString(), line: point.location.range.start.line, column: state.column === null ? null : point.location.range.start.character } : { kind: 'function', name: point.functionName }),
			...(point.condition === undefined ? {} : { condition: point.condition }),
			...(point.hitCondition === undefined ? {} : { hitCondition: point.hitCondition }),
			...(point.logMessage === undefined ? {} : { logMessage: point.logMessage }),
		};
	}

	function decodeBreakpoint(value) {
		if (typeof value?.id !== 'string' || typeof value.enabled !== 'boolean' || !['source', 'function'].includes(value.kind)) throw new TypeError('Invalid breakpoint snapshot');
		const previous = debugBreakpoints.get(value.id);
		const point = previous ?? (value.kind === 'source'
			? new SourceBreakpoint(new Location(Uri.parse(value.uri), new Position(value.line, value.column ?? 0)), value.enabled, value.condition, value.hitCondition, value.logMessage)
			: new FunctionBreakpoint(value.name, value.enabled, value.condition, value.hitCondition, value.logMessage));
		breakpointStates.set(point, { ...value, location: value.kind === 'source' ? new Location(Uri.parse(value.uri), new Position(value.line, value.column ?? 0)) : undefined });
		return point;
	}

	async function applyBreakpointChanges(additions, removals, changes) {
		if (![additions, removals, changes].every(Array.isArray)) throw new TypeError('Invalid breakpoint change');
		const added = [], removed = [], changed = [];
		for (const value of removals) {
			const point = debugBreakpoints.get(value.id);
			if (point) { debugBreakpoints.delete(value.id); removed.push(point); }
		}
		for (const value of [...additions, ...changes]) {
			const previous = debugBreakpoints.get(value.id);
			const before = previous && JSON.stringify(encodeBreakpoint(previous));
			const point = decodeBreakpoint(value);
			debugBreakpoints.set(value.id, point);
			if (!previous) added.push(point);
			else if (before !== JSON.stringify(encodeBreakpoint(point))) changed.push(point);
		}
		if (added.length || removed.length || changed.length) {
			const event = Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), changed: Object.freeze(changed) });
			await Promise.all([...debugListeners.breakpoints].map(entry => entry.listener.call(entry.thisArg, event)));
		}
	}

	function changeBreakpoints(points, remove) {
		if (!Array.isArray(points)) throw new TypeError('Breakpoints must be an array');
		// Validate the complete batch before publishing its local public handles.
		const values = points.map(encodeBreakpoint);
		const owned = serviceOwner();
		ensureDebugEvents();
		const added = [], removed = [];
		for (const point of points) {
			if (remove) { const current = debugBreakpoints.get(point.id); if (current) { removed.push(current); debugBreakpoints.delete(point.id); } }
			else if (!debugBreakpoints.has(point.id)) { debugBreakpoints.set(point.id, point); added.push(point); }
		}
		const changes = added.length || removed.length
			? Promise.all([...debugListeners.breakpoints].map(entry => entry.listener.call(entry.thisArg, Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), changed: Object.freeze([]) }))))
			: Promise.resolve();
		owned?.push(changes);
		void request(remove ? { operation: 'removeDebugBreakpoints', breakpointIds: values.map(value => value.id) } : { operation: 'addDebugBreakpoints', breakpoints: values }, 'done');
	}

	class ProcessExecution {
		constructor(process, argsOrOptions = [], options) {
			this.process = process;
			this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
			this.options = Array.isArray(argsOrOptions) ? options : argsOrOptions;
		}
	}
	class ShellExecution {
		constructor(command, argsOrOptions, options) {
			if (Array.isArray(argsOrOptions)) {
				this.command = command;
				this.args = argsOrOptions;
				this.options = options;
			} else {
				if (typeof command !== 'string' || options !== undefined) throw new TypeError('ShellExecution requires a command line or a command and arguments');
				this.commandLine = command;
				this.options = argsOrOptions;
			}
		}
	}
	class CustomExecution { constructor(callback) { if (typeof callback !== 'function') throw new TypeError('CustomExecution requires a callback'); this.callback = callback; } }
	class EventEmitter {
		constructor() {
			this.listeners = new Set();
			this.event = (listener, thisArg, disposables) => {
				const entry = { listener, thisArg }; this.listeners.add(entry);
				const disposable = new Disposable(() => this.listeners.delete(entry));
				disposables?.push(disposable); return disposable;
			};
		}
		fire(value) { for (const entry of [...this.listeners]) entry.listener.call(entry.thisArg, value); }
		dispose() { this.listeners.clear(); }
	}
	class Task {
		constructor(definition, scopeOrName, nameOrSource, sourceOrExecution, executionOrMatchers, problemMatchers = []) {
			this.definition = definition;
			if (typeof scopeOrName === 'string') {
				this.name = scopeOrName; this.source = nameOrSource; this.execution = sourceOrExecution; this.problemMatchers = executionOrMatchers ?? [];
			} else {
				this.scope = scopeOrName; this.name = nameOrSource; this.source = sourceOrExecution; this.execution = executionOrMatchers; this.problemMatchers = problemMatchers;
			}
			this.problemMatchers = typeof this.problemMatchers === 'string' ? [this.problemMatchers] : this.problemMatchers;
			this.isBackground = false;
			this.presentationOptions = {};
			this.runOptions = {};
		}
	}
	class TaskGroup {
		constructor(id, label, isDefault) {
			if (typeof id !== 'string' || typeof label !== 'string') throw new TypeError('TaskGroup requires an ID and label');
			Object.defineProperties(this, { id: { value: id, enumerable: true }, isDefault: { value: isDefault, enumerable: true } });
			this.label = label;
		}
		static Build = new TaskGroup('build', 'Build');
		static Test = new TaskGroup('test', 'Test');
		static Clean = new TaskGroup('clean', 'Clean');
		static Rebuild = new TaskGroup('rebuild', 'Rebuild');
	}
	class DebugAdapterExecutable {
		constructor(command, args = [], options) { this.command = command; this.args = args; this.options = options; }
	}
	class DebugThread {
		constructor(session, threadId) { this.session = session; this.threadId = threadId; Object.freeze(this); }
	}
	class DebugStackFrame {
		constructor(session, threadId, frameId) { this.session = session; this.threadId = threadId; this.frameId = frameId; Object.freeze(this); }
	}
	class DebugAdapterInlineImplementation {
		constructor(implementation) { this.implementation = implementation; }
	}
	class DebugAdapterServer {
		constructor(port, host) {
			if (!Number.isInteger(port) || port < 1 || port > 65535 || host !== undefined && (typeof host !== 'string' || !host.trim() || host.length > 256 || host.includes('\0'))) { throw new TypeError('Invalid Debug Adapter server'); }
			this.port = port; this.host = host;
		}
	}
	class DebugAdapterNamedPipeServer {
		constructor(path) {
			if (typeof path !== 'string' || !path || path.length > 32768 || path.includes('\0')) { throw new TypeError('Invalid Debug Adapter named pipe'); }
			this.path = path;
		}
	}
	const TaskPanelKind = Object.freeze({ Shared: 1, Dedicated: 2, New: 3 });
	const TaskRevealKind = Object.freeze({ Always: 1, Silent: 2, Never: 3 });
	const taskPanelNames = ['shared', 'dedicated', 'new'];
	const taskRevealNames = ['always', 'silent', 'never'];
	function encodeTaskPresentationOptions(options) {
		if (options === undefined) return undefined;
		if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid Task presentationOptions');
		if (Object.keys(options).some(key => !['echo', 'showReuseMessage', 'panel', 'clear', 'reveal', 'focus', 'close'].includes(key))) return unsupported('Task presentation options');
		if (options.panel !== undefined && !Object.values(TaskPanelKind).includes(options.panel)
			|| options.reveal !== undefined && !Object.values(TaskRevealKind).includes(options.reveal)
			|| ['echo', 'showReuseMessage', 'clear', 'focus', 'close'].some(key => options[key] !== undefined && typeof options[key] !== 'boolean')) throw new TypeError('Invalid Task presentationOptions');
		const presentation = {
			...(options.echo === undefined ? {} : { echo: options.echo }),
			...(options.showReuseMessage === undefined ? {} : { showReuseMessage: options.showReuseMessage }),
			...(options.panel === undefined ? {} : { panel: taskPanelNames[options.panel - 1] }),
			...(options.reveal === undefined ? {} : { reveal: taskRevealNames[options.reveal - 1] }),
			...(options.focus === undefined ? {} : { focus: options.focus }),
			...(options.clear === undefined ? {} : { clear: options.clear }),
			...(options.close === undefined ? {} : { close: options.close }),
		};
		return Object.keys(presentation).length ? presentation : undefined;
	}
	function encodeTask(task, id, customExecutions, fetchedCustomExecution) {
		if (!(task instanceof Task) || typeof task.definition?.type !== 'string') throw new TypeError('Task requires a TaskDefinition');
		let presentation = encodeTaskPresentationOptions(task.presentationOptions);
		// revealProblems belongs to tasks.json, not the public TaskPresentationOptions.
		// Editing a fetched Task must retain this configuration-only policy even
		// when its catalog identity becomes an explicit execution identity.
		const revealProblems = taskProblemRevealModes.get(task);
		if (revealProblems !== undefined) presentation = { ...presentation, revealProblems };
		const runOptions = task.runOptions;
		if (runOptions !== undefined && (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions) || Object.keys(runOptions).some(key => key !== 'reevaluateOnRerun') || runOptions.reevaluateOnRerun !== undefined && typeof runOptions.reevaluateOnRerun !== 'boolean')) {
			throw new TypeError('Invalid Task runOptions');
		}
		const execution = task.execution;
		if (execution instanceof CustomExecution) {
			if (execution === fetchedCustomExecution && typeof execution.callback !== 'function') customExecutions.delete(id);
			else {
				if (typeof execution.callback !== 'function') return unsupported('CustomExecution copied from another task owner');
				customExecutions.set(id, execution);
			}
		}
		else customExecutions.delete(id);
		let descriptor;
		if (execution instanceof ProcessExecution) {
			descriptor = { type: 'process', program: execution.process, args: execution.args };
		} else if (execution instanceof ShellExecution) {
			const options = execution.options;
			const shellOptions = options && { ...(options.executable === undefined ? {} : { executable: options.executable }), ...(options.shellArgs === undefined ? {} : { shellArgs: options.shellArgs }), ...(options.shellQuoting === undefined ? {} : { shellQuoting: options.shellQuoting }) };
			descriptor = { type: 'shell', ...(execution.commandLine === undefined ? { command: execution.command, args: execution.args } : { commandLine: execution.commandLine }), ...(shellOptions && Object.keys(shellOptions).length ? { options: shellOptions } : {}) };
		} else if (execution instanceof CustomExecution) {
			descriptor = { type: 'custom', id };
		} else if (execution !== undefined) {
			return unsupported('Task execution');
		}
		const scope = typeof task.scope === 'number' ? task.scope : task.scope?.uri ? { uri: task.scope.uri.toString() } : undefined;
		const group = ['build', 'test', 'clean', 'rebuild'].includes(task.group?.id) ? task.group.id : 'other';
		return {
			id, label: task.name, source: task.source, group, definition: task.definition,
			...(presentation === undefined ? {} : { presentation }),
			...(runOptions === undefined ? {} : { runOptions }),
			...(scope === undefined ? {} : { scope }),
			...(task.group?.isDefault === undefined ? {} : { groupIsDefault: task.group.isDefault }),
			...(descriptor === undefined ? {} : { execution: descriptor }),
			problemMatchers: task.problemMatchers ?? [], isBackground: task.isBackground ?? false,
			...(task.detail === undefined ? {} : { detail: task.detail }),
			...(execution?.options?.cwd === undefined ? {} : { cwd: execution.options.cwd }),
			...(execution?.options?.env === undefined ? {} : { env: execution.options.env }),
		};
	}
	function decodeTask(value) {
		if (typeof value?.id !== 'string' || typeof value.name !== 'string' || typeof value.source !== 'string' || typeof value.definition?.type !== 'string') throw new TypeError('Invalid task snapshot');
		const scope = typeof value.scope === 'number' ? value.scope : Object.freeze({ uri: Uri.parse(value.scope.uri), name: value.scope.name, index: value.scope.index });
		const descriptor = value.execution;
		let execution;
		if (descriptor?.type === 'process') execution = new ProcessExecution(descriptor.program, descriptor.args, value.options);
		else if (descriptor?.type === 'shell') {
			const options = { ...value.options, ...descriptor.options };
			execution = descriptor.commandLine === undefined ? new ShellExecution(descriptor.command, descriptor.args, options) : new ShellExecution(descriptor.commandLine, options);
		} else if (descriptor?.type === 'custom') {
			// The callback remains with the canonical task's extension owner. Fetched
			// instances expose its public execution type and run through that task identity.
			execution = Object.create(CustomExecution.prototype);
		} else if (descriptor !== undefined) throw new TypeError('Invalid task execution snapshot');
		const task = new Task(value.definition, scope, value.name, value.source, execution, value.problemMatchers);
		if (value.presentation !== undefined) {
			const presentation = value.presentation;
			if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)
				|| Object.keys(presentation).some(key => !['echo', 'showReuseMessage', 'panel', 'clear', 'reveal', 'revealProblems', 'focus', 'close'].includes(key))
				|| presentation.panel !== undefined && !taskPanelNames.includes(presentation.panel)
				|| presentation.reveal !== undefined && !taskRevealNames.includes(presentation.reveal)
				|| presentation.revealProblems !== undefined && !['always', 'onProblem', 'never'].includes(presentation.revealProblems)
				|| ['echo', 'showReuseMessage', 'clear', 'focus', 'close'].some(key => presentation[key] !== undefined && typeof presentation[key] !== 'boolean')) throw new TypeError('Invalid Task presentation snapshot');
			task.presentationOptions = {
				...(presentation.echo === undefined ? {} : { echo: presentation.echo }),
				...(presentation.showReuseMessage === undefined ? {} : { showReuseMessage: presentation.showReuseMessage }),
				...(presentation.panel === undefined ? {} : { panel: taskPanelNames.indexOf(presentation.panel) + 1 }),
				...(presentation.reveal === undefined ? {} : { reveal: taskRevealNames.indexOf(presentation.reveal) + 1 }),
				...(presentation.focus === undefined ? {} : { focus: presentation.focus }),
				...(presentation.clear === undefined ? {} : { clear: presentation.clear }),
				...(presentation.close === undefined ? {} : { close: presentation.close }),
			};
			if (presentation.revealProblems !== undefined) taskProblemRevealModes.set(task, presentation.revealProblems);
		}
		task.runOptions = value.runOptions === undefined ? {} : { ...value.runOptions };
		task.isBackground = value.isBackground;
		if (value.detail !== null) task.detail = value.detail;
		const group = [TaskGroup.Build, TaskGroup.Test, TaskGroup.Clean, TaskGroup.Rebuild].find(group => group.id === value.group);
		if (value.groupIsDefault !== undefined && typeof value.groupIsDefault !== 'boolean') throw new TypeError('Invalid TaskGroup default flag');
		if (group) task.group = value.groupIsDefault === undefined ? group : new TaskGroup(group.id, group.label, value.groupIsDefault);
		fetchedTaskIds.set(task, value.id);
		fetchedTaskSnapshots.set(task, { signature: taskFingerprint(task), execution, callback: execution?.callback });
		if (execution instanceof CustomExecution) fetchedCustomExecutions.set(execution, value.id);
		return task;
	}
	function taskFingerprint(task) {
		const execution = task.execution;
		return JSON.stringify({
			definition: task.definition, scope: task.scope, name: task.name, source: task.source,
			isBackground: task.isBackground, detail: task.detail, group: task.group?.id, groupIsDefault: task.group?.isDefault, problemMatchers: task.problemMatchers,
			presentationOptions: task.presentationOptions, runOptions: task.runOptions,
			execution: execution instanceof CustomExecution ? { type: 'custom' } : execution,
		});
	}
	function decodeTaskExecution(value, task, sequence = 0) {
		if (typeof value?.id !== 'string' || typeof value.active !== 'boolean') throw new TypeError('Invalid task execution snapshot');
		let execution = taskExecutionHandles.get(value.id);
		if (!execution) {
			execution = Object.freeze({ task: task ?? pendingTaskExecutions.get(value.task.clientTaskId ?? value.task.id)?.task ?? decodeTask(value.task), terminate() { void request({ operation: 'terminateTask', executionId: value.id }, 'done'); } });
			taskExecutionHandles.set(value.id, execution);
		}
		if (value.active && sequence >= Math.max(taskSnapshotSequence, taskStateSequences.get(value.id) ?? 0)) {
			activeTaskExecutions.set(value.id, execution);
			taskStateSequences.set(value.id, sequence);
		}
		return execution;
	}
	function applyTaskSnapshot(executions, sequence) {
		if (!Array.isArray(executions) || !Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Invalid task execution snapshot');
		if (sequence < taskEventSequence || sequence < taskSnapshotSequence) return;
		taskSnapshotSequence = sequence;
		activeTaskExecutions.clear();
		taskStateSequences.clear();
		for (const execution of executions) decodeTaskExecution(execution, undefined, sequence);
		for (const [id, execution] of taskExecutionHandles) if (!activeTaskExecutions.has(id) && !pendingTaskExecutions.has(fetchedTaskIds.get(execution.task) ?? providedTaskIds.get(execution.task))) taskExecutionHandles.delete(id);
	}
	function listenTask(kind, listener, thisArg, disposables) {
		if (typeof listener !== 'function') throw new TypeError('Task event requires a listener');
		ensureTaskEvents();
		const entry = { listener, thisArg };
		taskListeners[kind].add(entry);
		const disposable = new Disposable(() => taskListeners[kind].delete(entry));
		disposables?.push(disposable);
		return disposable;
	}
	function ensureTaskEvents() {
		if (taskEventRegistration) return;
		taskEventRegistration = ashTasks.registerTaskEvents('vscode.tasks.events', (_context, event) => invoke(async () => {
			if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new TypeError('Invalid task event sequence');
			if (event.type === 'snapshot') {
				applyTaskSnapshot(event.executions, event.sequence);
				return;
			}
			if (!Object.hasOwn(taskListeners, event.type)) throw new TypeError('Invalid task event');
			taskEventSequence = Math.max(taskEventSequence, event.sequence);
			const execution = decodeTaskExecution(event.execution, undefined, event.sequence);
			const content = event.type === 'processStart' ? { execution, processId: event.processId } : event.type === 'processEnd' ? { execution, exitCode: event.exitCode ?? undefined } : { execution };
			if (event.type === 'end') {
				activeTaskExecutions.delete(event.execution.id);
				// Retain an end fence only while executeTask can still return an older start snapshot.
				if (pendingTaskExecutions.has(event.execution.task.clientTaskId ?? event.execution.task.id)) taskStateSequences.set(event.execution.id, event.sequence);
				else taskStateSequences.delete(event.execution.id);
			}
			try {
				await Promise.all([...taskListeners[event.type]].map(async entry => entry.listener.call(entry.thisArg, content)));
			} finally {
				if (event.type === 'end' && !pendingTaskExecutions.has(event.execution.task.clientTaskId ?? event.execution.task.id)) taskExecutionHandles.delete(event.execution.id);
			}
		}), (_context, executionId, definition) => invoke(async () => {
			const execution = providedCustomExecutions.get(executionId);
			if (!execution) throw new Error('Custom Task execution has retired');
			return await execution.callback(definition);
		}));
		subscriptions.push(taskEventRegistration);
	}

	function statusSnapshot() {
		return { revision: statusRevision, entries: [...statusItems.values()].filter(item => item.visible).map(item => item.snapshot()) };
	}
	function statusChanged() {
		++statusRevision;
		if (!statusActive || statusDisposed || ashRuntime.isDisposed) return;
		const id = globalThis.__ashInvocation(false);
		const owned = serviceOwner();
		if (statusFlushes.has(id)) return;
		statusFlushes.add(id);
		// Coalesce synchronous property changes and keep the flush inside its originating invocation.
		const flush = Promise.resolve().then(async () => {
			statusFlushes.delete(id);
			await request({ operation: 'setStatusBarEntries', registrationId: statusRegistrationId, ...statusSnapshot() }, 'done');
		});
		owned?.push(flush);
		flush.catch(() => undefined);
	}
	function checkStatusUpdate() {
		if (statusActive && !statusDisposed && !ashRuntime.isDisposed) serviceOwner();
	}
	class StatusBarItem {
		#handle;
		#values = { text: '', name: undefined, tooltip: undefined, command: undefined, accessibilityInformation: undefined };
		#disposed = false;
		#visible = false;
		constructor(id, alignment, priority) {
			Object.defineProperties(this, { id: { value: id, enumerable: true }, alignment: { value: alignment, enumerable: true }, priority: { value: priority, enumerable: true } });
			this.#handle = `item.${++statusSequence}`;
			statusItems.set(this.#handle, this);
		}
		get visible() { return this.#visible; }
		get text() { return this.#values.text; }
		set text(value) { if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new TypeError('Invalid status bar text'); this.set('text', value); }
		get name() { return this.#values.name; }
		set name(value) { if (value !== undefined && (typeof value !== 'string' || value.length > 8192 || value.includes('\0'))) throw new TypeError('Invalid status bar name'); this.set('name', value); }
		get color() { return unsupported('StatusBarItem.color'); }
		set color(_value) { return unsupported('StatusBarItem.color'); }
		get backgroundColor() { return unsupported('StatusBarItem.backgroundColor'); }
		set backgroundColor(_value) { return unsupported('StatusBarItem.backgroundColor'); }
		get tooltip() { return this.#values.tooltip; }
		set tooltip(value) { if (value !== undefined && typeof value !== 'string') return unsupported('StatusBarItem.tooltip MarkdownString'); if (value?.length > 8192 || value?.includes('\0')) throw new TypeError('Invalid status bar tooltip'); this.set('tooltip', value); }
		get command() { return this.#values.command; }
		set command(value) {
			if (value !== undefined && (typeof (typeof value === 'string' ? value : value?.command) !== 'string' || !(typeof value === 'string' ? value : value.command) || typeof value !== 'string' && value.arguments !== undefined && !Array.isArray(value.arguments))) throw new TypeError('Invalid status bar command');
			this.set('command', value);
		}
		get accessibilityInformation() { return this.#values.accessibilityInformation; }
		set accessibilityInformation(value) { if (value !== undefined && (typeof value?.label !== 'string' || value.label.length > 8192 || value.label.includes('\0'))) throw new TypeError('Invalid status bar accessibility information'); if (value?.role !== undefined && value.role !== 'button') return unsupported('StatusBarItem.accessibilityInformation.role'); this.set('accessibilityInformation', value); }
		set(key, value) { if (this.#disposed) return; if (this.#visible) checkStatusUpdate(); this.#values[key] = value; if (this.#visible) statusChanged(); }
		show() { if (this.#disposed || this.#visible) return; checkStatusUpdate(); this.#visible = true; statusChanged(); }
		hide() { if (!this.#visible) return; checkStatusUpdate(); this.#visible = false; statusChanged(); }
		dispose() {
			if (this.#disposed) return;
			this.hide();
			this.#disposed = true;
			statusItems.delete(this.#handle);
			// A retained, disposed public item must not keep its last command's argument graph alive.
			this.#values = { text: '', name: undefined, tooltip: undefined, command: undefined, accessibilityInformation: undefined };
		}
		snapshot() {
			const value = this.#values.command;
			const command = value === undefined ? null : { command: typeof value === 'string' ? value : value.command, arguments: typeof value === 'string' ? [] : value.arguments ?? [] };
			return { id: this.#handle, text: this.text, tooltip: this.tooltip ?? null, ariaLabel: this.accessibilityInformation?.label ?? this.name ?? null, alignment: this.alignment === 1 ? 'left' : 'right', priority: this.priority ?? 0, command };
		}
	}
	function createStatusBarItem(idOrAlignment, alignmentOrPriority, priority) {
		if (statusDisposed || ashRuntime.isDisposed) throw new Error('Extension is not active');
		const explicitId = typeof idOrAlignment === 'string';
		const id = explicitId ? idOrAlignment : configuration.extensionId;
		const alignment = (explicitId ? alignmentOrPriority : idOrAlignment) ?? 1;
		const order = explicitId ? priority : alignmentOrPriority;
		if (!id || id.length > 256 || ![1, 2].includes(alignment) || order !== undefined && !Number.isFinite(order)) throw new TypeError('Invalid status bar identity, alignment or priority');
		if (statusItems.size >= 128) throw new RangeError('Status bar item quota exceeded');
		return new StatusBarItem(id, alignment, order);
	}

	function unsupported(name) { throw new Error(`Unsupported VS Code API: ${name}`); }
	let workspaceFolders;
	const workspaceFolderStates = new WeakMap();
	const workspaceListeners = { configuration: new Set(), workspace: new Set() };
	const workspaceRevisions = { configuration: 0, workspace: 0 };
	let workspaceRegistration;
	function folderKey(uri) {
		const path = uri.scheme === 'file' && configuration.pathSeparator === '\\' ? uri.path.toLowerCase() : uri.path;
		return JSON.stringify([uri.scheme, uri.authority.toLowerCase(), path]);
	}
	function acceptFolders(folders, previous = []) {
		return Object.freeze(folders.map(folder => {
			const uri = Uri.parse(folder.uri);
			const retained = previous.find(value => folderKey(value.uri) === folderKey(uri));
			if (retained) {
				const state = workspaceFolderStates.get(retained);
				state.name = folder.name; state.index = folder.index;
				return retained;
			}
			const state = { name: folder.name, index: folder.index };
			const value = Object.freeze({ uri, get name() { return state.name; }, get index() { return state.index; } });
			workspaceFolderStates.set(value, state);
			return value;
		}));
	}
	function listenWorkspace(kind, listener, thisArg, disposables) {
		if (typeof listener !== 'function') throw new TypeError('Workspace event requires a listener');
		ensureWorkspaceEvents();
		const entry = { listener, thisArg };
		workspaceListeners[kind].add(entry);
		const disposable = new Disposable(() => workspaceListeners[kind].delete(entry));
		disposables?.push(disposable);
		return disposable;
	}
	function equalConfig(left, right) {
		if (Object.is(left, right)) return true;
		if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalConfig(left[key], right[key]));
	}
	function ensureWorkspaceEvents() {
		if (workspaceRegistration) return workspaceRegistration;
		workspaceRegistration = ashWorkspace.registerWorkspaceEvents('vscode.workspace.events', (_context, event) => invoke(async () => {
			if (!Object.hasOwn(workspaceRevisions, event.type) || !Number.isSafeInteger(event.revision) || event.revision < 1 || typeof event.emit !== 'boolean') throw new TypeError('Invalid workspace event');
			if (event.revision <= workspaceRevisions[event.type]) return;
			const before = windowFacts();
			let content;
			if (event.type === 'configuration') {
				if (!event.configurationValues || typeof event.configurationValues !== 'object' || Array.isArray(event.configurationValues) || !event.configurationData || typeof event.configurationData !== 'object' || Array.isArray(event.configurationData)
					|| !Array.isArray(event.change?.keys) || event.change.keys.some(key => typeof key !== 'string') || !Array.isArray(event.change.overrides)
					|| event.change.overrides.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1]) || entry[1].some(key => typeof key !== 'string'))) throw new TypeError('Invalid configuration snapshot');
				const after = Object.freeze({ ...before, configurationValues: copyConfig(event.configurationValues), configurationData: copyConfig(event.configurationData) });
				initialization = after;
				const keys = [...event.change.keys, ...event.change.overrides.flatMap(entry => entry[1])];
				content = Object.freeze({ affectsConfiguration(section, scope) {
					if (typeof section !== 'string') throw new TypeError('Configuration section must be a string');
					if (!keys.some(key => section === '' || key === section || key.startsWith(section + '.') || section.startsWith(key + '.'))) return false;
					return scope == null || !equalConfig(getConfiguration(undefined, scope, before).get(section), getConfiguration(undefined, scope, after).get(section));
				} });
			} else {
				if (!Array.isArray(event.workspaceFolders) || event.workspaceFolders.length > 256 || event.workspaceFolders.some((folder, index) => typeof folder.uri !== 'string' || typeof folder.name !== 'string' || folder.index !== index)
					|| event.workspaceName !== null && typeof event.workspaceName !== 'string' || event.workspaceFile !== null && typeof event.workspaceFile !== 'string') throw new TypeError('Invalid workspace snapshot');
				const previous = getWorkspaceFolders() ?? [];
				const next = acceptFolders(event.workspaceFolders, previous);
				initialization = Object.freeze({ ...before, workspaceFolders: copyConfig(event.workspaceFolders), workspaceName: event.workspaceName, workspaceFile: event.workspaceFile });
				workspaceFolders = next;
				content = Object.freeze({ added: Object.freeze(next.filter(folder => !previous.includes(folder))), removed: Object.freeze(previous.filter(folder => !next.includes(folder))) });
			}
			workspaceRevisions[event.type] = event.revision;
			if (event.emit) await Promise.all([...workspaceListeners[event.type]].map(async entry => entry.listener.call(entry.thisArg, content)));
		}));
		return workspaceRegistration;
	}
	function windowFacts() {
		if (!initialization || !Array.isArray(initialization.workspaceFolders) || !initialization.configurationValues || !initialization.configurationData) {
			throw new Error('Window initialization is unavailable for this activation');
		}
		return initialization;
	}
	function getWorkspaceFolders() {
		if (!workspaceFolders) workspaceFolders = acceptFolders(windowFacts().workspaceFolders);
		return workspaceFolders.length ? workspaceFolders : undefined;
	}
	function workspaceFolder(resource, folders = getWorkspaceFolders()) {
		if (!(resource instanceof Uri)) throw new TypeError('Workspace resource must be a URI');
		const normalize = path => configuration.pathSeparator === '\\' && resource.scheme === 'file' ? path.toLowerCase() : path;
		const path = normalize(resource.path);
		return (folders ?? []).filter(folder => {
			const root = normalize(folder.uri.path).replace(/\/+$/, '');
			return resource.scheme === folder.uri.scheme && resource.authority.toLowerCase() === folder.uri.authority.toLowerCase() && (path === root || path.startsWith(root + '/'));
		}).sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
	}
	function configValue(values, key) {
		if (!key) return values;
		for (const part of key.split('.')) {
			if (!values || typeof values !== 'object' || !Object.hasOwn(values, part)) return undefined;
			values = values[part];
		}
		return values;
	}
	function copyConfig(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
	function mergeConfig(left, right) {
		if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return copyConfig(right);
		const result = Object.assign(Object.create(null), copyConfig(left));
		for (const [key, value] of Object.entries(right)) result[key] = Object.hasOwn(result, key) ? mergeConfig(result[key], value) : copyConfig(value);
		return result;
	}
	function getConfiguration(section, scope, facts = windowFacts()) {
		if (section !== undefined && typeof section !== 'string') throw new TypeError('Configuration section must be a string');
		const data = facts.configurationData;
		const resource = scope instanceof Uri ? scope : scope?.uri;
		const language = scope instanceof Uri ? undefined : scope?.languageId;
		const folders = facts.workspaceFolders.map(folder => ({ ...folder, uri: Uri.parse(folder.uri) }));
		const folder = resource ? workspaceFolder(resource, folders) : undefined;
		const folderModel = folder ? data.folders.find(([uri]) => Uri.from(uri).toString() === folder.uri.toString())?.[1] : undefined;
		const models = [data.defaults, data.application, data.userLocal, data.userRemote, data.workspace, folderModel, data.policy].filter(Boolean);
		const languageContents = model => (model?.overrides ?? []).filter(override => override.identifiers.includes(language)).reduce((result, override) => mergeConfig(result, override.contents), {});
		let values = copyConfig(facts.configurationValues);
		if (folderModel) values = mergeConfig(values, folderModel.contents);
		if (language) for (const model of models) values = mergeConfig(values, languageContents(model));
		values = mergeConfig(values, data.policy?.contents ?? {});
		const fullKey = key => section ? key ? section + '.' + key : section : key;
		const combinedValue = (first, second, key, override) => {
			const a = configValue(override ? languageContents(first) : first?.contents, key);
			const b = configValue(override ? languageContents(second) : second?.contents, key);
			return b === undefined ? copyConfig(a) : a === undefined ? copyConfig(b) : mergeConfig(a, b);
		};
		const contents = configValue(values, section);
		return Object.freeze({
			...(contents && typeof contents === 'object' && !Array.isArray(contents) ? copyConfig(contents) : {}),
			get(key, fallback) { const value = configValue(values, fullKey(key)); return value === undefined ? fallback : copyConfig(value); },
			has(key) { return configValue(values, fullKey(key)) !== undefined; },
			inspect(key) {
				const name = fullKey(key);
				if (!models.some(model => model.keys?.includes(name)) && configValue(values, name) === undefined) return undefined;
				return {
					key: name,
					defaultValue: copyConfig(configValue(data.defaults?.contents, name)),
					globalValue: combinedValue(data.userLocal, data.userRemote, name, false),
					workspaceValue: copyConfig(configValue(data.workspace?.contents, name)),
					workspaceFolderValue: copyConfig(configValue(folderModel?.contents, name)),
					defaultLanguageValue: language ? copyConfig(configValue(languageContents(data.defaults), name)) : undefined,
					globalLanguageValue: language ? combinedValue(data.userLocal, data.userRemote, name, true) : undefined,
					workspaceLanguageValue: language ? copyConfig(configValue(languageContents(data.workspace), name)) : undefined,
					workspaceFolderLanguageValue: language ? copyConfig(configValue(languageContents(folderModel), name)) : undefined,
					languageIds: [...new Set(models.flatMap(model => (model.overrides ?? []).filter(override => override.keys.includes(name)).flatMap(override => override.identifiers)))],
				};
			},
		});
	}
	function contract(name, members) {
		return new Proxy(Object.freeze(members), {
			get(object, key) {
				if (key in object || typeof key === 'symbol') return Reflect.get(object, key);
				// CommonJS transpilers probe module metadata before accessing public APIs.
				if (key === '__esModule') return undefined;
				return unsupported(`${name}.${key}`);
			},
		});
	}
	function serviceOwner() {
		const id = globalThis.__ashInvocation(false);
		const owned = pending.get(id);
		if (!owned && typeof globalThis.__ashBackgroundRequest !== 'function') {
			// The confined host remains the owner of its invocation authorization and error.
			if (id === undefined || id === null) globalThis.__ashInvocation();
			throw new Error('VS Code callback is no longer active');
		}
		return owned;
	}
	function request(operation, resultKind) {
		const id = globalThis.__ashInvocation(false);
		const owned = serviceOwner();
		const promise = (async () => {
			const encoded = JSON.stringify(operation);
			const result = JSON.parse(await (owned ? globalThis.__ashRequest(id, encoded) : globalThis.__ashBackgroundRequest(encoded)));
			if (result.result !== resultKind) throw new Error(`Invalid result for ${operation.operation}`);
			return result;
		})();
		// The SDK callback retains its IO. Node lifecycle calls survive callback return
		// and are cancelled by the supervisor when this authorized incarnation retires.
		const settled = promise.then(() => undefined, () => undefined);
		owned?.push(settled);
		return promise;
	}

	async function invoke(callback) {
		const id = globalThis.__ashInvocation();
		pending.set(id, []);
		observedDocuments.set(id, new Map());
		try {
			const result = await callback();
			let drained = 0;
			const owned = pending.get(id);
			while (drained < owned.length) {
				const batch = owned.slice(drained);
				drained = owned.length;
				await Promise.all(batch);
			}
			return result;
		} finally {
			pending.delete(id);
			observedDocuments.delete(id);
		}
	}
	function message(severity, text, ...items) {
		if (typeof text !== 'string') throw new TypeError('Message must be a string');
		if (items.length) return unsupported('window message options/items');
		return request({ operation: 'showMessage', message: text, severity }, 'done').then(() => undefined);
	}
	class Disposable {
		#callback;
		constructor(callback) {
			if (typeof callback !== 'function') throw new TypeError('Disposable requires a callback');
			this.#callback = callback;
		}
		dispose() { const callback = this.#callback; this.#callback = undefined; callback?.(); }
		static from(...items) { return new Disposable(() => { for (const item of items) item.dispose(); }); }
	}
	class Position {
		constructor(line, character) {
			if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) throw new RangeError('Invalid position');
			this.line = line;
			this.character = character;
			Object.freeze(this);
		}
		compareTo(other) { return Math.sign(this.line - other.line || this.character - other.character); }
		isEqual(other) { return this.compareTo(other) === 0; }
		isBefore(other) { return this.compareTo(other) < 0; }
		isAfter(other) { return this.compareTo(other) > 0; }
		isBeforeOrEqual(other) { return this.compareTo(other) <= 0; }
		isAfterOrEqual(other) { return this.compareTo(other) >= 0; }
		translate(lineDelta = 0, characterDelta = 0) {
			if (typeof lineDelta === 'object') return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
			return new Position(this.line + lineDelta, this.character + characterDelta);
		}
		with(line = this.line, character = this.character) {
			if (typeof line === 'object') return this.with(line.line ?? this.line, line.character ?? this.character);
			return new Position(line, character);
		}
	}
	class Range {
		constructor(start, end, endLine, endCharacter) {
			if (typeof start === 'number') { start = new Position(start, end); end = new Position(endLine, endCharacter); }
			const first = new Position(start.line, start.character);
			const last = new Position(end.line, end.character);
			this.start = first.isBeforeOrEqual(last) ? first : last;
			this.end = first.isBeforeOrEqual(last) ? last : first;
			Object.freeze(this);
		}
		get isEmpty() { return this.start.isEqual(this.end); }
		get isSingleLine() { return this.start.line === this.end.line; }
		contains(value) {
			if (value.start && value.end) return this.contains(value.start) && this.contains(value.end);
			return this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
		}
		isEqual(other) { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
	}
	class Location {
		constructor(uri, rangeOrPosition) {
			if (!(uri instanceof Uri) || !(rangeOrPosition instanceof Position) && !(rangeOrPosition instanceof Range)) throw new TypeError('Invalid location');
			this.uri = uri;
			this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
		}
	}
	class Breakpoint {
		constructor(enabled = true, condition, hitCondition, logMessage) {
			if (typeof enabled !== 'boolean' || [condition, hitCondition, logMessage].some(value => value !== undefined && (typeof value !== 'string' || value.length > 32768 || value.includes('\0')))) throw new TypeError('Invalid breakpoint properties');
			breakpointStates.set(this, { id: `vscode.breakpoint.${configuration.extensionId}.${++breakpointSequence}.${Math.random().toString(36).slice(2)}`, enabled, condition, hitCondition, logMessage });
		}
		get id() { return breakpointStates.get(this).id; }
		get enabled() { return breakpointStates.get(this).enabled; }
		get condition() { return breakpointStates.get(this).condition; }
		get hitCondition() { return breakpointStates.get(this).hitCondition; }
		get logMessage() { return breakpointStates.get(this).logMessage; }
	}
	class SourceBreakpoint extends Breakpoint {
		constructor(location, enabled, condition, hitCondition, logMessage) {
			super(enabled, condition, hitCondition, logMessage);
			if (!(location instanceof Location)) throw new TypeError('SourceBreakpoint requires a Location');
			Object.assign(breakpointStates.get(this), { location, column: location.range.start.character });
		}
		get location() { return breakpointStates.get(this).location; }
	}
	class FunctionBreakpoint extends Breakpoint {
		constructor(functionName, enabled, condition, hitCondition, logMessage) {
			super(enabled, condition, hitCondition, logMessage);
			if (typeof functionName !== 'string' || !functionName || functionName.length > 32768 || functionName.includes('\0')) throw new TypeError('FunctionBreakpoint requires a function name');
			breakpointStates.get(this).name = functionName;
		}
		get functionName() { return breakpointStates.get(this).name; }
	}
	class Uri {
		constructor(scheme, authority, path, query = '', fragment = '') {
			Object.assign(this, { scheme, authority, path, query, fragment });
			Object.freeze(this);
		}
		static parse(value) {
			const match = /^([a-zA-Z][\w+.-]*):(?:(\/\/)([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
			if (!match) throw new TypeError('Invalid URI');
			return new Uri(match[1], decodeURIComponent(match[3] ?? ''), decodeURIComponent(match[4]), match[5] ?? '', match[6] ?? '');
		}
		static file(path) {
			if (typeof path !== 'string') throw new TypeError('File path required');
			if (configuration.pathSeparator === '\\') path = path.replaceAll('\\', '/');
			if (path.startsWith('//')) {
				const boundary = path.indexOf('/', 2);
				return new Uri('file', boundary < 0 ? path.slice(2) : path.slice(2, boundary), boundary < 0 ? '/' : path.slice(boundary));
			}
			return new Uri('file', '', path.startsWith('/') ? path : '/' + path);
		}
		static joinPath(base, ...segments) {
			if (!(base instanceof Uri) || !base.path || segments.some(value => typeof value !== 'string')) throw new TypeError('URI path required');
			let path = [base.path, ...segments.filter(value => value.length > 0)].join('/');
			if (base.scheme === 'file' && configuration.pathSeparator === '\\') path = path.replaceAll('\\', '/');
			const driveRoot = base.scheme === 'file' && configuration.pathSeparator === '\\' && /^\/[a-zA-Z]:\//.test(path);
			const parts = [];
			for (const part of path.split('/')) {
				if (!part || part === '.') continue;
				if (part === '..') {
					if (parts.length > (driveRoot ? 1 : 0)) parts.pop();
				} else parts.push(part);
			}
			return base.with({ path: (path.startsWith('/') ? '/' : '') + parts.join('/') + (path.endsWith('/') && parts.length ? '/' : '') });
		}
		static from(components) { return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '', components.fragment ?? ''); }
		with(change) { return Uri.from({ ...this, ...change }); }
		get fsPath() {
			let path = this.authority ? `//${this.authority}${this.path}` : this.path;
			if (!this.authority && /^\/[a-zA-Z]:/.test(path)) path = path[1].toLowerCase() + path.slice(2);
			return configuration.pathSeparator === '\\' ? path.replaceAll('/', '\\') : path;
		}
		toString(skipEncoding = false) {
			const path = skipEncoding ? this.path : this.path.split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
			return `${this.scheme}:${this.authority || this.scheme === 'file' ? `//${this.authority}` : ''}${path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
		}
		toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
	}
	const extensionUri = Uri.file(configuration.extensionPath);
	const extension = Object.freeze({
		id: configuration.extensionId,
		extensionUri,
		extensionPath: extensionUri.fsPath,
		packageJSON: configuration.manifest,
		extensionKind: 1,
		get isActive() { return statusActive; },
		get exports() {
			if (!statusActive) throw new Error('Extension has not completed activation');
			return activationExports;
		},
		activate() { return activationPromise; },
	});
	function observeDocument(snapshot) {
		if (snapshot.uri !== undefined) observedDocuments.get(globalThis.__ashInvocation(false))?.set(snapshot.uri, snapshot.version);
	}
	function document(snapshot, live = false) {
		const key = snapshot.uri;
		observeDocument(snapshot);
		const existing = live ? documents.get(key) : undefined;
		if (existing && existing.snapshot.version > snapshot.version) return existing.value;
		if (existing) { existing.snapshot = snapshot; return existing.value; }
		const state = { snapshot, closed: false };
		const value = Object.freeze({
			uri: key === undefined ? undefined : Uri.parse(key),
			get version() { observeDocument(state.snapshot); return state.snapshot.version; },
			get languageId() { return state.snapshot.languageId; },
			get isClosed() { return state.closed; },
			get lineCount() { observeDocument(state.snapshot); return state.snapshot.text.split('\n').length; },
			getText(range) {
				observeDocument(state.snapshot);
				if (!range) return state.snapshot.text;
				return state.snapshot.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
			},
			offsetAt(position) {
				observeDocument(state.snapshot);
				const lines = state.snapshot.text.split('\n');
				if (position.line < 0) return 0;
				if (position.line >= lines.length) return state.snapshot.text.length;
				return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + Math.max(0, Math.min(position.character, lines[position.line].replace(/\r$/, '').length));
			},
			positionAt(offset) {
				observeDocument(state.snapshot);
				const text = state.snapshot.text;
				const bounded = Math.max(0, Math.min(Math.floor(offset), text.length));
				const lines = text.slice(0, bounded).split('\n');
				return new Position(lines.length - 1, lines.at(-1).replace(/\r$/, '').length);
			},
			lineAt(line) {
				observeDocument(state.snapshot);
				const index = typeof line === 'number' ? line : line.line;
				const lines = state.snapshot.text.split('\n');
				if (!Number.isSafeInteger(index) || index < 0 || index >= lines.length) throw new RangeError('Line is outside the document');
				const text = lines[index].replace(/\r$/, '');
				return Object.freeze({ lineNumber: index, text, range: new Range(index, 0, index, text.length), rangeIncludingLineBreak: index + 1 < lines.length ? new Range(index, 0, index + 1, 0) : new Range(index, 0, index, text.length), firstNonWhitespaceCharacterIndex: text.search(/\S/) < 0 ? text.length : text.search(/\S/), isEmptyOrWhitespace: !text.trim() });
			},
			getWordRangeAtPosition(position, regex) {
				if (regex !== undefined) return unsupported('TextDocument custom word regex');
				const text = this.lineAt(position).text;
				for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
					if (match.index <= position.character && position.character <= match.index + match[0].length) return new Range(position.line, match.index, position.line, match.index + match[0].length);
				}
				return undefined;
			},
		});
		state.value = value;
		if (live && key !== undefined) documents.set(key, state);
		return value;
	}
	function listenDocument(kind, listener, thisArg, disposables) {
		if (typeof listener !== 'function') throw new TypeError('Document event requires a listener');
		ensureDocumentEvents();
		const entry = { listener, thisArg };
		documentListeners[kind].add(entry);
		const disposable = new Disposable(() => documentListeners[kind].delete(entry));
		disposables?.push(disposable);
		return disposable;
	}
	function ensureDocumentEvents() {
		if (!documentRegistration) {
			documentRegistration = ashWorkspace.registerTextDocumentEvents('vscode.documents', (_call, event) => invoke(async () => {
				if (!['open', 'change', 'close'].includes(event.type) || !event.document) throw new TypeError('Invalid document event');
				const value = document(event.document, true);
				if (event.type === 'close') {
					const state = documents.get(event.document.uri);
					state.closed = true;
					documents.delete(event.document.uri);
				}
				const content = event.type === 'change' ? { document: value, contentChanges: event.contentChanges.map(change => ({ ...change, range: new Range(change.range.start, change.range.end) })), reason: event.reason === 'undo' ? 1 : event.reason === 'redo' ? 2 : undefined } : value;
				await Promise.all([...documentListeners[event.type]].map(entry => entry.listener.call(entry.thisArg, content)));
			}));
			subscriptions.push(documentRegistration);
		}
	}
	class Diagnostic {
		constructor(range, message, severity = 0) {
			if (!(range instanceof Range) || typeof message !== 'string' || !message || !Number.isInteger(severity) || severity < 0 || severity > 3) throw new TypeError('Invalid diagnostic');
			Object.assign(this, { range, message, severity });
		}
	}
	function diagnosticCollection(name = '') {
		if (typeof name !== 'string' || name.length > 256) throw new TypeError('Invalid diagnostic collection name');
		ensureDocumentEvents();
		const id = `vscode.diagnostics.${++collectionSequence}`;
		let entries = new Map();
		let disposed = false;
		function publish(next) {
			if (disposed) throw new Error('Diagnostic collection is disposed');
			if (next.size > 1024) throw new RangeError('Too many diagnostic resources');
			const payload = [...next].map(([uri, value]) => ({
				uri, version: value.version, diagnostics: value.diagnostics.map(diagnostic => {
					if (!diagnostic || ![0, 1, 2, 3].includes(diagnostic.severity) || typeof diagnostic.message !== 'string' || !diagnostic.message || !(diagnostic.range instanceof Range)) throw new TypeError('Invalid diagnostic');
					if (diagnostic.relatedInformation !== undefined || diagnostic.tags !== undefined || typeof diagnostic.code === 'object') return unsupported('Diagnostic related information/tags/code targets');
					return { start: diagnostic.range.start, end: diagnostic.range.end, message: diagnostic.message, severity: ['error', 'warning', 'information', 'hint'][diagnostic.severity], source: diagnostic.source ?? null, code: diagnostic.code === undefined ? null : String(diagnostic.code) };
				})
			}));
			request({ operation: 'setDiagnostics', collection: id, entries: payload }, 'done');
			entries = next;
		}
		return Object.freeze({
			name,
			set(uri, diagnostics) {
				if (uri === undefined) { publish(new Map()); return; }
				const values = uri instanceof Uri ? [[uri, diagnostics]] : uri;
				if (!Array.isArray(values)) throw new TypeError('Diagnostic entries must be an array');
				const next = new Map(entries);
				const merged = new Map();
				for (const [resource, items] of values) {
					if (!(resource instanceof Uri)) throw new TypeError('Diagnostic resource must be a URI');
					const key = resource.toString();
					if (items === undefined) { next.delete(key); merged.delete(key); }
					else {
						if (!Array.isArray(items) || items.length > 10_000) throw new TypeError('Invalid diagnostic list');
						const combined = [...(merged.get(key) ?? []), ...items];
						merged.set(key, combined);
						next.set(key, { version: observedDocuments.get(globalThis.__ashInvocation(false))?.get(key) ?? null, diagnostics: Object.freeze(combined) });
					}
				}
				publish(next);
			},
			delete(uri) { const next = new Map(entries); next.delete(uri.toString()); publish(next); },
			clear() { publish(new Map()); },
			get(uri) { if (disposed) throw new Error('Diagnostic collection is disposed'); return entries.get(uri.toString())?.diagnostics ?? []; },
			has(uri) { return entries.has(uri.toString()); },
			forEach(callback, thisArg) { for (const [uri, value] of entries) callback.call(thisArg, Uri.parse(uri), value.diagnostics, this); },
			*[Symbol.iterator]() { for (const [uri, value] of entries) yield [Uri.parse(uri), value.diagnostics]; },
			dispose() {
				if (disposed) return;
				// Deactivation has no live client invocation; the Workbench retires its owners.
				if (!ashRuntime.isDisposed && (pending.has(globalThis.__ashInvocation(false)) || typeof globalThis.__ashBackgroundRequest === 'function')) publish(new Map());
				disposed = true;
				entries.clear();
			},
		});
	}
	const completionKinds = ['text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', undefined, 'file', 'reference', 'folder', undefined, undefined, undefined, undefined, undefined, 'typeParameter'];
	const completionNames = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
	function completionResult(value, snapshot, position) {
		const items = value == null ? [] : Array.isArray(value) ? value : value.items;
		if (!Array.isArray(items) || items.length > 10_000) throw new TypeError('Invalid completion list');
		return {
			isIncomplete: value?.isIncomplete === true, items: items.map((item, index) => {
				const label = typeof item.label === 'string' ? item.label : item.label?.label;
				if (typeof label !== 'string' || !label || (item.kind !== undefined && !completionKinds[item.kind])) throw new TypeError('Invalid completion item');
				if (item.command !== undefined || item.range?.inserting !== undefined) return unsupported('CompletionItem command/insert-replace ranges');
				const range = item.textEdit?.range ?? item.range ?? snapshot.getWordRangeAtPosition(position) ?? new Range(position, position);
				const insertion = item.textEdit?.newText ?? item.insertText ?? label;
				const result = { id: String(index), label, kind: completionKinds[item.kind ?? 0], range, insertText: insertion instanceof SnippetString ? insertion.value : insertion, insertTextFormat: insertion instanceof SnippetString ? 'snippet' : 'plainText' };
				for (const field of ['detail', 'filterText', 'sortText', 'preselect', 'commitCharacters']) if (item[field] !== undefined) result[field] = item[field];
				if (item.documentation !== undefined) result.documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
				if (item.additionalTextEdits !== undefined) result.additionalTextEdits = item.additionalTextEdits.map(edit => ({ range: edit.range, text: edit.newText }));
				return result;
			})
		};
	}
	class SnippetString { constructor(value = '') { this.value = value; } }
	class TreeItem {
		constructor(labelOrResource, collapsibleState = 0) {
			if (labelOrResource instanceof Uri) this.resourceUri = labelOrResource;
			else this.label = labelOrResource;
			this.collapsibleState = collapsibleState;
		}
	}
	function localizeMessage(messageOrOptions, ...parameters) {
		const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions?.message;
		if (typeof message !== 'string') throw new TypeError('Localization requires a message');
		let values = parameters.length === 1 && parameters[0] && typeof parameters[0] === 'object' ? parameters[0] : parameters;
		let key = message;
		if (typeof messageOrOptions !== 'string') {
			values = messageOrOptions.args ?? {};
			const comment = Array.isArray(messageOrOptions.comment) ? messageOrOptions.comment.join('') : messageOrOptions.comment;
			if (comment) key += '/' + comment;
		}
		const bundle = configuration.localization?.bundle;
		const translated = bundle && Object.hasOwn(bundle, key) ? bundle[key] : message;
		return translated.replace(/\{([^}]+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
	}
	const api = contract('vscode', {
		env: contract('env', { get language() { return windowFacts().language ?? 'en'; } }),
		l10n: contract('l10n', {
			t: localizeMessage,
			bundle: configuration.localization?.bundle,
			uri: configuration.localization?.uri ? Uri.parse(configuration.localization.uri) : undefined,
		}),
		TreeItem, TreeItemCollapsibleState: Object.freeze({ None: 0, Collapsed: 1, Expanded: 2 }), TreeItemCheckboxState: Object.freeze({ Unchecked: 0, Checked: 1 }),
		Task, TaskGroup, ProcessExecution, ShellExecution, CustomExecution, EventEmitter, CancellationTokenSource, DebugConsoleMode: Object.freeze({ Separate: 0, MergeWithParent: 1 }), DebugAdapterExecutable, DebugAdapterServer, DebugAdapterNamedPipeServer, DebugAdapterInlineImplementation,
		TaskScope: Object.freeze({ Global: 1, Workspace: 2 }), TaskPanelKind, TaskRevealKind,
		ShellQuoting: Object.freeze({ Escape: 1, Strong: 2, Weak: 3 }),
		tasks: contract('tasks', {
			get taskExecutions() { return [...activeTaskExecutions.values()]; },
			onDidStartTask: (listener, thisArg, disposables) => listenTask('start', listener, thisArg, disposables),
			onDidEndTask: (listener, thisArg, disposables) => listenTask('end', listener, thisArg, disposables),
			onDidStartTaskProcess: (listener, thisArg, disposables) => listenTask('processStart', listener, thisArg, disposables),
			onDidEndTaskProcess: (listener, thisArg, disposables) => listenTask('processEnd', listener, thisArg, disposables),
			async fetchTasks(filter = {}) {
				if (filter.version !== undefined && typeof filter.version !== 'string' || filter.type !== undefined && typeof filter.type !== 'string') throw new TypeError('Invalid task filter');
				const result = await request({ operation: 'fetchTasks', version: filter.version ?? null, taskType: filter.type ?? null }, 'tasks');
				if (!Array.isArray(result.tasks) || !Array.isArray(result.executions)) throw new TypeError('Invalid task catalog');
				applyTaskSnapshot(result.executions, result.sequence);
				return result.tasks.map(decodeTask);
			},
			async executeTask(task) {
				if (!(task instanceof Task)) throw new TypeError('executeTask requires a Task');
				let fetchedId = fetchedTaskIds.get(task);
				const fetched = fetchedTaskSnapshots.get(task);
				if (fetchedId && (fetched.signature !== taskFingerprint(task) || task.execution instanceof CustomExecution && (fetched.execution !== task.execution || fetched.callback !== task.execution.callback))) {
					// Changed metadata becomes an explicit execution; the original custom
					// callback stays with its provider and is selected separately below.
					fetchedTaskIds.delete(task);
					fetchedTaskSnapshots.delete(task);
					fetchedId = undefined;
				}
				if (!fetchedId && !providedTaskIds.has(task)) providedTaskIds.set(task, `provided.${++providedTaskSequence}`);
				const taskId = fetchedId ?? providedTaskIds.get(task);
				const customId = fetchedCustomExecutions.get(task.execution);
				const originalCustom = customId && typeof task.execution.callback !== 'function' ? { id: customId, execution: task.execution } : undefined;
				const provided = fetchedId ? null : encodeTask(task, taskId, providedCustomExecutions, originalCustom?.execution);
				const pending = pendingTaskExecutions.get(taskId) ?? { task, count: 0 };
				pending.count++;
				pendingTaskExecutions.set(taskId, pending);
				let result;
				try {
					result = await request({ operation: 'executeTask', taskId: fetchedId ?? originalCustom?.id ?? null, task: provided }, 'taskExecution');
					return decodeTaskExecution(result.execution, task, result.sequence);
				} finally {
					if (--pending.count === 0) pendingTaskExecutions.delete(taskId);
					if (pending.count === 0) {
						providedCustomExecutions.delete(taskId);
						for (const [id, handle] of taskExecutionHandles) {
							const key = fetchedTaskIds.get(handle.task) ?? providedTaskIds.get(handle.task);
							if (key === taskId && !activeTaskExecutions.has(id)) { taskExecutionHandles.delete(id); taskStateSequences.delete(id); }
						}
					}
				}
			},
			registerTaskProvider(type, provider) {
				ensureTaskEvents();
				if (taskTypes.has(type)) throw new Error(`Task provider '${type}' is already registered`);
				const registrationId = `vscode.tasks.${++providerSequence}`;
				const ids = new Map();
				const customExecutions = new Map();
				let sequence = 0;
				const handle = ashTasks.registerTaskProvider(registrationId, type, {
					provideTasks: context => invoke(async () => {
						const tasks = await provider.provideTasks(context.cancellationToken) ?? [];
						if (!Array.isArray(tasks) || tasks.length > 10000) throw new TypeError('Invalid task list');
						const current = new Set(tasks.map(task => JSON.stringify([task.definition, task.name])));
						for (const [key, id] of ids) if (!current.has(key)) { ids.delete(key); customExecutions.delete(id); }
						return tasks.map(task => {
							const key = JSON.stringify([task.definition, task.name]);
							if (!ids.has(key)) ids.set(key, `task.${++sequence}`);
							return encodeTask(task, ids.get(key), customExecutions);
						});
					}),
					resolveTask: (context, value) => invoke(async () => {
						if (!provider.resolveTask) return undefined;
						const task = decodeTask(value);
						const resolved = await provider.resolveTask(task, context.cancellationToken);
						if (resolved === undefined) return undefined;
						if (resolved.definition !== task.definition) throw new Error('resolveTask must retain the exact TaskDefinition');
						return encodeTask(resolved, value.id, customExecutions);
					}),
					createTaskTerminal: (_context, executionId, definition) => invoke(async () => {
						const execution = customExecutions.get(executionId);
						if (!execution) throw new Error('Custom task is no longer provided');
						return await execution.callback(definition);
					}),
				});
				taskTypes.add(type);
				return new Disposable(() => { try { handle.dispose(); } finally { ids.clear(); customExecutions.clear(); taskTypes.delete(type); } });
			},
		}),
		debug: contract('debug', {
			get activeDebugSession() { return activeDebugSession; },
			get activeStackItem() { return activeStackItem; },
			onDidChangeActiveStackItem: (listener, thisArg, disposables) => listenDebug('stackItem', listener, thisArg, disposables),
			asDebugSourceUri(source, session = activeDebugSession) {
				if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Invalid debug source');
				if (source.sourceReference !== undefined && source.sourceReference > 0) {
					if (!Number.isSafeInteger(source.sourceReference) || !/^[A-Za-z0-9._-]{1,256}$/.test(session?.id ?? '')) throw new TypeError('A debug source reference requires a session');
					const path = source.path || source.name || `source-${source.sourceReference}`;
					if (typeof path !== 'string' || path.includes('\0') || path.length > 32768) throw new TypeError('Invalid debug source path');
					return Uri.from({ scheme: 'debug', path: path.startsWith('/') ? path : '/' + path, query: `session=${session.id}&ref=${source.sourceReference}` });
				}
				if (typeof source.path !== 'string' || !source.path || source.path.includes('\0') || source.path.length > 32768) throw new TypeError('A debug source requires a path or reference');
				const path = /^(?:[a-z]:[\\/]|\\\\)/i.test(source.path) ? source.path.replaceAll('\\', '/') : source.path;
				if (path.startsWith('//')) {
					const slash = path.indexOf('/', 2);
					return Uri.from({ scheme: 'file', authority: slash < 0 ? path.slice(2) : path.slice(2, slash), path: slash < 0 ? '/' : path.slice(slash) });
				}
				return Uri.from({ scheme: 'file', path: path.startsWith('/') ? path : '/' + path });
			},
			get breakpoints() { return Object.freeze([...debugBreakpoints.values()]); },
			onDidChangeBreakpoints: (listener, thisArg, disposables) => listenDebug('breakpoints', listener, thisArg, disposables),
			addBreakpoints: points => changeBreakpoints(points, false),
			removeBreakpoints: points => changeBreakpoints(points, true),
			onDidStartDebugSession: (listener, thisArg, disposables) => listenDebug('start', listener, thisArg, disposables),
			onDidTerminateDebugSession: (listener, thisArg, disposables) => listenDebug('end', listener, thisArg, disposables),
			onDidChangeActiveDebugSession: (listener, thisArg, disposables) => listenDebug('active', listener, thisArg, disposables),
			onDidReceiveDebugSessionCustomEvent: (listener, thisArg, disposables) => listenDebug('custom', listener, thisArg, disposables),
			startDebugging(folder, nameOrConfiguration, options) {
				if (options && typeof options.id === 'string' && debugSessions.get(options.id)?.handle === options) options = { parentSession: options };
				let encoded;
				if (options !== undefined) {
					if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['parentSession', 'lifecycleManagedByParent', 'consoleMode', 'noDebug', 'suppressSaveBeforeStart'].includes(key)) || [options.noDebug, options.lifecycleManagedByParent, options.suppressSaveBeforeStart].some(value => value !== undefined && typeof value !== 'boolean') || options.consoleMode !== undefined && ![0, 1].includes(options.consoleMode)) throw new TypeError('Invalid Debug session options');
					if (options.parentSession !== undefined && debugSessions.get(options.parentSession?.id)?.handle !== options.parentSession) throw new TypeError('Invalid parent Debug session');
					const { parentSession, ...values } = options;
					encoded = { ...values, ...(parentSession === undefined ? {} : { parentSessionId: parentSession.id }) };
				}
				if (typeof nameOrConfiguration !== 'string' && (!nameOrConfiguration || typeof nameOrConfiguration !== 'object')) throw new TypeError('Debugging requires a name or configuration');
				return request({ operation: 'startDebugging', folder: folder?.uri?.toString() ?? null, configuration: nameOrConfiguration, ...(encoded === undefined ? {} : { options: encoded }) }, 'debugStarted').then(result => result.started);
			},
			stopDebugging(session) {
				if (session !== undefined && typeof session.id !== 'string') throw new TypeError('Invalid debug session');
				return request({ operation: 'stopDebugging', sessionId: session?.id ?? null }, 'done').then(() => undefined);
			},
			registerDebugConfigurationProvider(type, provider, triggerKind = 1) {
				const methods = ['provideDebugConfigurations', 'resolveDebugConfiguration', 'resolveDebugConfigurationWithSubstitutedVariables'];
				if (!provider || !methods.some(method => typeof provider[method] === 'function') || methods.some(method => provider[method] !== undefined && typeof provider[method] !== 'function')) throw new TypeError('Debug configuration provider requires callbacks');
				const folder = value => {
					if (value === undefined) return undefined;
					if (typeof value?.uri !== 'string' || typeof value.name !== 'string' || !Number.isSafeInteger(value.index) || value.index < 0) throw new TypeError('Invalid Debug workspace folder');
					return Object.freeze({ uri: Uri.parse(value.uri), name: value.name, index: value.index });
				};
				const callbacks = {};
				if (provider.provideDebugConfigurations) callbacks.provideDebugConfigurations = (context, value) => invoke(() => provider.provideDebugConfigurations(folder(value), context.cancellationToken));
				if (provider.resolveDebugConfiguration) callbacks.resolveDebugConfiguration = (context, value, config) => invoke(() => provider.resolveDebugConfiguration(folder(value), config, context.cancellationToken));
				if (provider.resolveDebugConfigurationWithSubstitutedVariables) callbacks.resolveDebugConfigurationWithSubstitutedVariables = (context, value, config) => invoke(() => provider.resolveDebugConfigurationWithSubstitutedVariables(folder(value), config, context.cancellationToken));
				return ashDebug.registerDebugConfigurationProvider(`vscode.debugConfiguration.${++providerSequence}`, type, callbacks, triggerKind);
			},
			registerDebugAdapterTrackerFactory(type, factory) {
				if (typeof type !== 'string' || !type || typeof factory?.createDebugAdapterTracker !== 'function') { throw new TypeError('Invalid Debug Adapter tracker factory'); }
				return ashDebug.registerDebugAdapterTrackerFactory(`vscode.debugTracker.${++providerSequence}`, type, {
					createDebugAdapterTracker: (_context, snapshot) => invoke(async () => {
						const tracker = await factory.createDebugAdapterTracker(debugSession(snapshot));
						if (!tracker) { return undefined; }
						const callbacks = {};
						for (const operation of ['onWillStartSession', 'onWillReceiveMessage', 'onDidSendMessage', 'onWillStopSession', 'onError', 'onExit']) {
							if (tracker[operation] === undefined) { continue; }
							if (typeof tracker[operation] !== 'function') { throw new TypeError('Invalid Debug Adapter tracker callback'); }
							callbacks[operation] = (_context, ...args) => invoke(() => tracker[operation].apply(tracker, args));
						}
						return callbacks;
					}),
				});
			},
			registerDebugAdapterDescriptorFactory(type, factory) {
				if (!debuggerTypes.has(type) || registeredDebuggerTypes.has(type)) throw new Error(`Debug adapter type '${type}' is undeclared or already registered`);
				const handle = ashDebug.registerDebugAdapterDescriptorFactory(`vscode.debug.${++providerSequence}`, type, {
					createDebugAdapterDescriptor: (_context, value, session, executable) => invoke(async () => {
						const descriptor = await factory.createDebugAdapterDescriptor(debugSession({ ...session, type: value.type, name: value.name, configuration: value }), executable === undefined ? undefined : new DebugAdapterExecutable(executable.program, executable.arguments, { ...(executable.cwd === undefined ? {} : { cwd: executable.cwd }), ...(executable.env === undefined ? {} : { env: executable.env }) }));
						if (descriptor === undefined || descriptor === null) return descriptor;
						if (descriptor instanceof DebugAdapterInlineImplementation) {
							const implementation = descriptor.implementation;
							if (typeof implementation?.handleMessage !== 'function' || typeof implementation.onDidSendMessage !== 'function' || typeof implementation.dispose !== 'function') { throw new TypeError('Invalid inline Debug Adapter implementation'); }
							return {
								implementation: {
									handleMessage: (_context, message) => invoke(() => implementation.handleMessage(message)),
									onDidSendMessage: listener => implementation.onDidSendMessage(listener),
									dispose: context => context ? invoke(() => implementation.dispose()) : implementation.dispose(),
								}
							};
						}
						if (descriptor instanceof DebugAdapterServer) { return { connection: { type: 'server', port: descriptor.port, ...(descriptor.host === undefined ? {} : { host: descriptor.host }) } }; }
						if (descriptor instanceof DebugAdapterNamedPipeServer) { return { connection: { type: 'namedPipe', path: descriptor.path } }; }
						if (!(descriptor instanceof DebugAdapterExecutable)) return unsupported('Debug adapter descriptor');
						return { program: descriptor.command, arguments: descriptor.args, ...(descriptor.options?.cwd === undefined ? {} : { cwd: descriptor.options.cwd }), ...(descriptor.options?.env === undefined ? {} : { env: descriptor.options.env }) };
					}),
				});
				registeredDebuggerTypes.add(type);
				return new Disposable(() => { handle.dispose(); registeredDebuggerTypes.delete(type); });
			},
		}),
		StatusBarAlignment: Object.freeze({ Left: 1, Right: 2 }),
		DebugConfigurationProviderTriggerKind: Object.freeze({ Initial: 1, Dynamic: 2 }),
		ExtensionMode: Object.freeze({ Production: 1, Development: 2, Test: 3 }),
		ExtensionKind: Object.freeze({ UI: 1, Workspace: 2 }),
		Disposable, Position, Range, Location, Breakpoint, SourceBreakpoint, FunctionBreakpoint, DebugThread, DebugStackFrame, Uri, Diagnostic, SnippetString,
		DiagnosticSeverity: Object.freeze({ Error: 0, Warning: 1, Information: 2, Hint: 3 }),
		CompletionItemKind: Object.freeze(Object.fromEntries(completionNames.map((name, index) => [name, index]))),
		CompletionTriggerKind: Object.freeze({ Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 }),
		CompletionItem: class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } },
		CompletionList: class CompletionList { constructor(items = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } },
		TextEdit: class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } static replace(range, newText) { return new this(range, newText); } static insert(position, newText) { return new this(new Range(position, position), newText); } static delete(range) { return new this(range, ''); } },
		Hover: class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } },
		MarkdownString: class MarkdownString {
			constructor(value = '') { this.value = value; }
			appendText(value) { this.value += value.replace(/[\\`*_{}[\]()#+.!-]/g, '\\$&'); return this; }
			appendMarkdown(value) { this.value += value; return this; }
		},
		commands: contract('commands', {
			async executeCommand(command, ...args) {
				if (typeof command !== 'string' || !command || command.includes('\0')) throw new TypeError('executeCommand requires a command ID');
				const result = await request({ operation: 'executeCommand', command, arguments: args }, 'command');
				return result.hasValue === false ? undefined : result.value;
			},
			registerCommand(command, callback, thisArg) {
				if (typeof callback !== 'function' || !titles.has(command)) throw new TypeError('Command must be declared in package.json');
				return ashCommands.registerCommand(command, titles.get(command), (_call, ...args) => invoke(() => callback.apply(thisArg, args)));
			},
		}),
		window: contract('window', {
			createStatusBarItem,
			showInformationMessage: (text, ...items) => message('information', text, ...items),
			showWarningMessage: (text, ...items) => message('warning', text, ...items),
			showErrorMessage: (text, ...items) => message('error', text, ...items),
			async showQuickPick(items, options = {}) {
				if (!Array.isArray(items) || options.canPickMany) return unsupported('window.showQuickPick input/multi-select');
				const labels = items.map(item => typeof item === 'string' ? item : item.label);
				const { index } = await request({ operation: 'showQuickPick', items: labels, placeholder: options.placeHolder ?? '' }, 'selection');
				return index === null ? undefined : items[index];
			},
		}),
		workspace: contract('workspace', {
			onDidChangeConfiguration: (listener, thisArg, disposables) => listenWorkspace('configuration', listener, thisArg, disposables),
			onDidChangeWorkspaceFolders: (listener, thisArg, disposables) => listenWorkspace('workspace', listener, thisArg, disposables),
			get workspaceFolders() { return getWorkspaceFolders(); },
			get name() { return windowFacts().workspaceName ?? getWorkspaceFolders()?.[0]?.name; },
			get workspaceFile() { const uri = windowFacts().workspaceFile; return uri === null ? undefined : Uri.parse(uri); },
			get rootPath() { return getWorkspaceFolders()?.[0]?.uri.fsPath; },
			getWorkspaceFolder: resource => workspaceFolder(resource),
			getConfiguration: (section, scope) => getConfiguration(section, scope),
			get textDocuments() { return [...documents.values()].map(state => { observeDocument(state.snapshot); return state.value; }); },
			onDidOpenTextDocument: (listener, thisArg, disposables) => listenDocument('open', listener, thisArg, disposables),
			onDidChangeTextDocument: (listener, thisArg, disposables) => listenDocument('change', listener, thisArg, disposables),
			onDidCloseTextDocument: (listener, thisArg, disposables) => listenDocument('close', listener, thisArg, disposables),
			async openTextDocument(uri) {
				if (!(uri instanceof Uri)) return unsupported('workspace.openTextDocument overload');
				const result = await request({ operation: 'readDocument', uri: uri.toString() }, 'document');
				return document(result.document, true);
			},
		}),
		languages: contract('languages', {
			createDiagnosticCollection: diagnosticCollection,
			registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
				ensureDocumentEvents();
				const entries = Array.isArray(selector) ? selector : [selector];
				if (entries.some(entry => typeof entry !== 'string')) return unsupported('languages.registerCompletionItemProvider selector filters');
				if (typeof provider?.provideCompletionItems !== 'function' || provider.resolveCompletionItem !== undefined) return unsupported('CompletionItemProvider missing provideCompletionItems/resolveCompletionItem');
				const registration = ashLanguages.registerCompletionProvider(`vscode.completion.${++providerSequence}`, entries, {
					provideCompletionItems: (call, snapshot, coordinate, context) => invoke(async () => {
						const value = document(snapshot);
						const position = new Position(coordinate.line, coordinate.character);
						const result = await provider.provideCompletionItems(value, position, call.cancellationToken, { triggerKind: context.kind === 'triggerCharacter' ? 1 : context.kind === 'incompleteRefresh' ? 2 : 0, triggerCharacter: context.triggerCharacter });
						return completionResult(result, value, position);
					}),
				}, triggerCharacters);
				subscriptions.push(registration);
				return registration;
			},
			registerHoverProvider(selector, provider) {
				const entries = Array.isArray(selector) ? selector : [selector];
				if (entries.some(entry => typeof entry !== 'string')) return unsupported('languages.registerHoverProvider selector filters');
				const registration = ashLanguages.registerHoverProvider(`vscode.hover.${++providerSequence}`, entries, {
					provideHover: (call, snapshot, position) => invoke(async () => {
						const hover = await provider.provideHover(document(snapshot), new Position(position.line, position.character),
							call.cancellationToken);
						return hover == null ? undefined : { contents: hover.contents, ...(hover.range === undefined ? {} : { range: hover.range }) };
					}),
				});
				subscriptions.push(registration);
				return registration;
			},
		}),
	});
	return Object.freeze({
		api,
		activate(context, callback, receiver, capabilities) {
			subscriptions = context.subscriptions;
			if (initialization) subscriptions.push(ensureWorkspaceEvents());
			// The supervisor supplies the admitted ceiling. Optional API observers must
			// not turn an unrelated command into a rejected registration handshake.
			if (capabilities.includes('taskProvider')) ensureTaskEvents();
			if (capabilities.includes('debugAdapter')) ensureDebugEvents();
			if (capabilities.includes('statusBar')) subscriptions.push(ashWindow.registerStatusBar(statusRegistrationId, statusSnapshot));
			subscriptions.push(new Disposable(() => {
				statusDisposed = true;
				statusActive = false;
				for (const item of [...statusItems.values()]) item.dispose();
				statusFlushes.clear();
				activeTaskExecutions.clear();
				activeStackItem = undefined;
				taskExecutionHandles.clear();
				pendingTaskExecutions.clear();
				providedCustomExecutions.clear();
				taskStateSequences.clear();
				for (const listeners of Object.values(taskListeners)) listeners.clear();
				for (const listeners of Object.values(debugListeners)) listeners.clear();
				for (const listeners of Object.values(workspaceListeners)) listeners.clear();
				debugSessions.clear();
				debugBreakpoints.clear();
				activeDebugSession = undefined;
			}));
			// Keep the SDK subscription array: host retirement disposes this exact owner.
			const publicContext = Object.freeze({
				subscriptions,
				extensionUri,
				extensionPath: extensionUri.fsPath,
				extensionMode: 1,
				extension,
				asAbsolutePath(relativePath) { return Uri.joinPath(extensionUri, relativePath).fsPath; },
			});
			activationPromise = Promise.resolve().then(() => callback.call(receiver, publicContext)).then(result => {
				activationExports = result;
				statusActive = true;
				return result;
			});
			return activationPromise;
		},
		deactivate() { statusActive = false; },
	});
}
