import { isExecutionVariable } from '../../configurationResolver/common/configurationResolver.js';
import { localize } from '../../../../nls.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { parseJsonc } from "../../../../base/common/jsonc.js";
import { ShellQuoting, type RunOptions, type TaskPresentationOptions, type ShellQuotedString, type TaskShellExecution, type IWorkspaceTask, type WorkspaceTaskGroup, type WorkspaceTaskSource } from "./taskService.js";

const MAX_TASKS = 256;
const MAX_COMMAND_LENGTH = 32_768;

/** Preserves VS Code task configuration and identifies execution settings Ash cannot honor. */
export function parseWorkspaceTasks(source: string, operatingSystem?: OperatingSystem, resolvableVariables?: ReadonlySet<string>): readonly IWorkspaceTask[] {
	const document = record(parseJsonc(source, ".vscode/tasks.json"), ".vscode/tasks.json");
	if (document.version !== "2.0.0") throw new TypeError(".vscode/tasks.json version must be '2.0.0'");
	if (!Array.isArray(document.tasks)) throw new TypeError(".vscode/tasks.json tasks must be an array");
	if (document.tasks.length > MAX_TASKS) throw new RangeError(`.vscode/tasks.json cannot contain more than ${MAX_TASKS} tasks`);
	const { tasks, version, ...defaults } = document;
	freezeConfiguration(defaults);
	return Object.freeze(tasks.map((value, index) => parseWorkspaceTask(value, index, String(version), defaults, operatingSystem, resolvableVariables)));
}

/** Projects conventional package scripts into explicit user-selectable tasks. */
export function parsePackageTasks(source: string, packageManager: "npm" | "pnpm" | "yarn"): readonly IWorkspaceTask[] {
	const document = record(parseJsonc(source, "package.json"), "package.json");
	if (document.scripts === undefined) return Object.freeze([]);
	const scripts = record(document.scripts, "package.json scripts");
	return Object.freeze(Object.entries(scripts).flatMap(([name, command]) => {
		if (!/^[A-Za-z0-9:_-]{1,128}$/.test(name) || typeof command !== "string" || !command.trim()) return [];
		const invocation = packageManager === "yarn" ? `yarn run ${name}` : `${packageManager} run ${name}`;
		return [task(`${packageManager}:${name}`, name, invocation, packageManager, packageTaskGroup(name), command.trim())];
	}).slice(0, MAX_TASKS));
}

/** Conventional Cargo entry points available when the workspace has Cargo.toml. */
export function cargoWorkspaceTasks(): readonly IWorkspaceTask[] {
	return Object.freeze([
		task("cargo:check", "cargo check", "cargo check", "cargo", "build", "Check the workspace without producing binaries"),
		task("cargo:build", "cargo build", "cargo build", "cargo", "build", "Build the workspace"),
		task("cargo:test", "cargo test", "cargo test", "cargo", "test", "Run the workspace test suite"),
		task("cargo:run", "cargo run", "cargo run", "cargo", "run", "Run the default workspace binary"),
	]);
}

function mergeExecutionConfiguration(base: Readonly<Record<string, unknown>>, override: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const effective = { ...base, ...override };
	for (const key of ['options', 'presentation', 'runOptions', 'windows', 'osx', 'linux']) {
		if (base[key] !== undefined || override[key] !== undefined) {
			const inherited = base[key] === undefined ? {} : record(base[key], key);
			const supplied = override[key] === undefined ? {} : record(override[key], key);
			const values = { ...inherited, ...supplied };
			// Environments merge by key: empty retains inherited values and null removes one.
			if (key === 'options' && (inherited.env !== undefined || supplied.env !== undefined)) {
				values.env = { ...(inherited.env === undefined ? {} : record(inherited.env, 'options.env')), ...(supplied.env === undefined ? {} : record(supplied.env, 'options.env')) };
			}
			effective[key] = values;
		}
	}
	return effective;
}

function platformConfiguration(source: Readonly<Record<string, unknown>>, os: OperatingSystem | undefined): Record<string, unknown> {
	for (const key of ['windows', 'osx', 'linux']) if (source[key] !== undefined) record(source[key], key);
	if (os === undefined) return { ...source };
	const key = os === OperatingSystem.Windows ? 'windows' : os === OperatingSystem.Macintosh ? 'osx' : 'linux';
	const effective = source[key] === undefined ? { ...source } : mergeExecutionConfiguration(source, record(source[key], key));
	delete effective.windows;
	delete effective.osx;
	delete effective.linux;
	return effective;
}

function parseWorkspaceTask(value: unknown, index: number, version: string, defaults: Readonly<Record<string, unknown>>, os: OperatingSystem | undefined, resolvableVariables?: ReadonlySet<string>): IWorkspaceTask {
	const input = record(value, `.vscode/tasks.json tasks[${index}]`);
	// Apply each scope's platform block before the more specific task scope.
	// The caller supplies the execution host OS; renderer platform facts are insufficient.
	const taskConfiguration = platformConfiguration(input, os);
	const effective = mergeExecutionConfiguration(platformConfiguration(defaults, os), taskConfiguration);
	const type = effective.type === undefined ? "shell" : string(effective.type, `tasks[${index}].type`);
	// Provider-defined tasks may omit their label until the provider resolves them.
	const label = input.label === undefined && type !== 'shell' && type !== 'process' ? type : string(input.label, `tasks[${index}].label`).trim();
	if (!label || label.length > 256) throw new TypeError(`tasks[${index}].label must contain 1 to 256 characters`);
	const unsupported = unsupportedExecution(effective, type);
	const shellCommand = type === 'shell' && effective.command !== undefined ? shellValue(effective.command, 'command', true) : undefined;
	const baseCommand = typeof shellCommand === 'object' ? shellCommand.value : typeof effective.command === 'string' ? effective.command.trim() : '';
	if (effective.command !== undefined && typeof effective.command !== 'string' && shellCommand === undefined) unsupported.push('command');
	const dependencies = effective.dependsOn === undefined ? [] : (typeof effective.dependsOn === 'string' ? [effective.dependsOn] : array(effective.dependsOn, 'dependsOn')).map(value => string(value, 'dependsOn'));
	if (!baseCommand && dependencies.length === 0 && unsupported.length === 0) throw new TypeError(`tasks[${index}].command must contain 1 to ${MAX_COMMAND_LENGTH} characters without NUL`);
	const shellArgs: (string | ShellQuotedString)[] = [];
	const args = effective.args === undefined ? [] : array(effective.args, `tasks[${index}].args`).map((argument, argumentIndex) => {
		if (type === 'process') {
			if (typeof argument !== 'string' || argument.length > MAX_COMMAND_LENGTH || argument.includes('\0')) throw new TypeError(`tasks[${index}].args[${argumentIndex}] must be a bounded string without NUL`);
			return argument;
		}
		if (type === 'shell') {
			const parsed = shellValue(argument, `args[${argumentIndex}]`, true);
			shellArgs.push(parsed);
			if (unsupportedVariables(typeof parsed === 'string' ? parsed : parsed.value, resolvableVariables)) unsupported.push(`args[${argumentIndex}]`);
			return shellArgument(typeof parsed === 'string' ? parsed : parsed.value, `tasks[${index}].args[${argumentIndex}]`);
		}
		if (typeof argument !== 'string' && typeof argument !== 'number' || typeof argument === 'string' && unsupportedVariables(argument, resolvableVariables)) {
			unsupported.push(`args[${argumentIndex}]`);
			return typeof argument === 'string' ? argument : '';
		}
		return shellArgument(argument, `tasks[${index}].args[${argumentIndex}]`);
	});
	if (unsupportedVariables(baseCommand, resolvableVariables)) unsupported.push('command');
	const options = effective.options === undefined ? {} : record(effective.options, 'options');
	const shellOptions = options.shell === undefined ? undefined : record(options.shell, 'options.shell');
	const shellExecution = type !== 'shell' || shellCommand === undefined ? undefined : parseShellExecution({
		type: 'shell',
		...(shellArgs.length || typeof shellCommand !== 'string' ? { command: shellCommand, args: shellArgs } : { commandLine: shellCommand }),
		...(shellOptions === undefined ? {} : { options: { executable: shellOptions.executable, shellArgs: shellOptions.args, shellQuoting: shellOptions.quoting } }),
	});
	const environment = options.env === undefined ? undefined : parseTaskEnvironment(options.env);
	const command = [baseCommand, ...args].filter(Boolean).join(" ");
	if ((!command && dependencies.length === 0 && unsupported.length === 0) || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) throw new TypeError(`tasks[${index}].command must contain 1 to ${MAX_COMMAND_LENGTH} characters without NUL`);
	const matchers = effective.problemMatcher === undefined ? [] : Array.isArray(effective.problemMatcher) ? effective.problemMatcher : [effective.problemMatcher];
	if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.includes('\0'))) throw new TypeError('options.cwd must be a string without NUL');
	if (effective.dependsOrder !== undefined && effective.dependsOrder !== 'parallel' && effective.dependsOrder !== 'sequence') throw new TypeError('dependsOrder must be parallel or sequence');
	if (effective.isBackground !== undefined && typeof effective.isBackground !== 'boolean') throw new TypeError('isBackground must be a boolean');
	const groupOptions = typeof effective.group === 'object' && effective.group !== null && !Array.isArray(effective.group) ? effective.group as Record<string, unknown> : undefined;
	if (groupOptions?.isDefault !== undefined && typeof groupOptions.isDefault !== 'boolean' && typeof groupOptions.isDefault !== 'string') throw new TypeError('group.isDefault must be a boolean or glob string');
	return Object.freeze({
		...task(`vscode:${index}:${stableId(label)}`, label, command, "vscode", taskGroup(effective.group), typeof effective.detail === 'string' ? effective.detail : type === "shell" ? "Shell task" : type === "process" ? "Process task" : type),
		configuration: Object.freeze({ version, defaults, task: freezeConfiguration(input), groupIsConfigured: effective.group !== undefined }),
		...(groupOptions?.isDefault === undefined ? {} : { groupIsDefault: groupOptions.isDefault as boolean | string }),
		...(effective.runOptions === undefined ? {} : { runOptions: parseTaskRunOptions(effective.runOptions) }),
		...(effective.presentation === undefined ? {} : { presentation: parseTaskPresentationOptions(effective.presentation) }),
		definition: Object.freeze({ ...input, ...taskConfiguration, type }),
		...(type === 'process' ? { execution: Object.freeze({ type: 'process' as const, program: baseCommand, args: Object.freeze(args) }) } : {}),
		// Keep ordinary command lines on the interactive path; structured arguments
		// require dispatch-time quoting and an explicit shell spawn.
		...(shellExecution && (shellArgs.length || typeof shellCommand !== 'string' || shellOptions) ? { execution: shellExecution } : {}),
		...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
		dependsOn: Object.freeze(dependencies),
		dependsOrder: effective.dependsOrder === 'sequence' ? 'sequence' : 'parallel',
		isBackground: effective.isBackground === true,
		problemMatchers: Object.freeze(matchers.map(freezeConfiguration)),
		...(environment && Object.keys(environment).length ? { environment } : {}),
		unsupportedFeatures: Object.freeze([...new Set(unsupported)]),
	});
}

/** Shared validation for configured and extension-provided child environments. */
export function parseTaskEnvironment(value: unknown): Readonly<Record<string, string | null>> {
	const environment = record(value, 'Task environment');
	if (Object.keys(environment).length > 128) throw new RangeError('Task environment cannot contain more than 128 values');
	for (const [name, item] of Object.entries(environment)) {
		if (!name || name.length > 256 || /[=\0]/.test(name) || item !== null && (typeof item !== 'string' || item.length > 32768 || item.includes('\0'))) throw new TypeError('Task environment must contain valid names and bounded strings or null removals');
	}
	return Object.freeze({ ...environment } as Record<string, string | null>);
}

function unsupportedExecution(input: Readonly<Record<string, unknown>>, type: string): string[] {
	const unsupported = type === 'shell' || type === 'process' ? [] : [`type:${type}`];
	if (type !== 'shell' && input.options !== undefined && record(input.options, 'options').shell !== undefined) unsupported.push('options.shell');
	if (input.runOptions !== undefined) {
		const options = record(input.runOptions, 'runOptions');
		if (options.runOn !== undefined && options.runOn !== 'default') unsupported.push('runOptions.runOn');
	}
	for (const key of ['windows', 'osx', 'linux']) {
		if (input[key] !== undefined && Object.keys(record(input[key], key)).length > 0) unsupported.push(key);
	}
	if (input.presentation !== undefined) {
		const presentation = record(input.presentation, 'presentation');
		if (presentation.group !== undefined) unsupported.push('presentation');
	}
	return unsupported;
}

/** The configuration and provider boundary validates task screen reuse before process creation. */
export function parseTaskPresentationOptions(value: unknown): TaskPresentationOptions {
	const options = record(value, 'presentation');
	if (options.panel !== undefined && !['shared', 'dedicated', 'new'].includes(options.panel as string)
		|| options.reveal !== undefined && !['always', 'silent', 'never'].includes(options.reveal as string)
		|| options.revealProblems !== undefined && !['always', 'onProblem', 'never'].includes(options.revealProblems as string)
		|| ['echo', 'showReuseMessage', 'clear', 'focus', 'close'].some(key => options[key] !== undefined && typeof options[key] !== 'boolean')) {
		throw new TypeError(localize('tasks.invalidPresentation', 'Invalid task presentation options.'));
	}
	return Object.freeze({
		...(options.echo === undefined ? {} : { echo: options.echo as boolean }),
		...(options.showReuseMessage === undefined ? {} : { showReuseMessage: options.showReuseMessage as boolean }),
		...(options.reveal === undefined ? {} : { reveal: options.reveal as TaskPresentationOptions['reveal'] }),
		...(options.revealProblems === undefined ? {} : { revealProblems: options.revealProblems as TaskPresentationOptions['revealProblems'] }),
		...(options.focus === undefined ? {} : { focus: options.focus as boolean }),
		...(options.panel === undefined ? {} : { panel: options.panel as TaskPresentationOptions['panel'] }),
		...(options.clear === undefined ? {} : { clear: options.clear as boolean }),
		...(options.close === undefined ? {} : { close: options.close as boolean }),
	});
}

/** Shared policy boundary for configured tasks and authenticated extension descriptors. */
export function parseTaskRunOptions(value: unknown): RunOptions {
	const options = record(value, 'runOptions');
	if (options.reevaluateOnRerun !== undefined && typeof options.reevaluateOnRerun !== 'boolean') {
		throw new TypeError('runOptions.reevaluateOnRerun must be a boolean');
	}
	if (options.instanceLimit !== undefined && (typeof options.instanceLimit !== 'number' || !Number.isSafeInteger(options.instanceLimit) || options.instanceLimit < 1)) {
		throw new TypeError('runOptions.instanceLimit must be a positive integer');
	}
	if (options.instancePolicy !== undefined && !['terminateNewest', 'terminateOldest', 'prompt', 'warn', 'silent'].includes(options.instancePolicy as string)) {
		throw new TypeError('runOptions.instancePolicy must be terminateNewest, terminateOldest, prompt, warn or silent');
	}
	return Object.freeze({
		...(options.reevaluateOnRerun === undefined ? {} : { reevaluateOnRerun: options.reevaluateOnRerun }),
		...(options.instanceLimit === undefined ? {} : { instanceLimit: options.instanceLimit as number }),
		...(options.instancePolicy === undefined ? {} : { instancePolicy: options.instancePolicy as RunOptions['instancePolicy'] }),
	});
}

/** Normalizes configured and provider shell execution at their shared task boundary. */
export function parseShellExecution(value: unknown): TaskShellExecution {
	const input = record(value, 'ShellExecution');
	let options: TaskShellExecution['options'];
	if (input.options !== undefined) {
		const supplied = record(input.options, 'ShellExecution.options');
		const executable = supplied.executable;
		if (executable !== undefined && (typeof executable !== 'string' || !executable.trim() || executable.length > MAX_COMMAND_LENGTH || executable.includes('\0'))) throw new TypeError('Shell executable must be a bounded nonempty string without NUL');
		const shellArgs = supplied.shellArgs === undefined ? undefined : array(supplied.shellArgs, 'ShellExecution.shellArgs').map(argument => {
			if (typeof argument !== 'string' || argument.length > MAX_COMMAND_LENGTH || argument.includes('\0')) throw new TypeError('Shell arguments must be bounded strings without NUL');
			return argument;
		});
		if (shellArgs && (!executable || shellArgs.length > 256)) throw new TypeError('Shell arguments require an executable and at most 256 values');
		let shellQuoting: NonNullable<TaskShellExecution['options']>['shellQuoting'];
		if (supplied.shellQuoting !== undefined) {
			const quoting = record(supplied.shellQuoting, 'ShellExecution.shellQuoting');
			for (const key of ['strong', 'weak']) {
				if (quoting[key] !== undefined && (typeof quoting[key] !== 'string' || (quoting[key] as string).length !== 1 || /[\0\r\n]/.test(quoting[key] as string))) throw new TypeError('Shell quoting characters must have length one');
			}
			let escape = quoting.escape;
			if (escape !== undefined && typeof escape !== 'string') {
				const escaping = record(escape, 'ShellExecution.escape');
				if (typeof escaping.escapeChar !== 'string' || escaping.escapeChar.length !== 1 || /[\0\r\n]/.test(escaping.escapeChar) || typeof escaping.charsToEscape !== 'string' || escaping.charsToEscape.length > 256 || escaping.charsToEscape.includes('\0')) throw new TypeError('Invalid shell escaping options');
				escape = Object.freeze({ escapeChar: escaping.escapeChar, charsToEscape: escaping.charsToEscape });
			} else if (typeof escape === 'string' && (escape.length !== 1 || /[\0\r\n]/.test(escape))) {
				throw new TypeError('Shell escape character must have length one');
			}
			shellQuoting = Object.freeze({ ...(escape === undefined ? {} : { escape: escape as NonNullable<typeof shellQuoting>['escape'] }), ...(quoting.strong === undefined ? {} : { strong: quoting.strong as string }), ...(quoting.weak === undefined ? {} : { weak: quoting.weak as string }) });
		}
		options = Object.freeze({ ...(executable === undefined ? {} : { executable: executable as string }), ...(shellArgs === undefined ? {} : { shellArgs: Object.freeze(shellArgs) }), ...(shellQuoting === undefined ? {} : { shellQuoting }) });
	}
	if (input.commandLine !== undefined) {
		if (input.command !== undefined || input.args !== undefined || typeof input.commandLine !== 'string' || !input.commandLine.trim() || input.commandLine.length > MAX_COMMAND_LENGTH || input.commandLine.includes('\0')) throw new TypeError('ShellExecution requires one bounded command line or command and arguments');
		return Object.freeze({ type: 'shell', commandLine: input.commandLine, ...(options === undefined ? {} : { options }) });
	}
	const command = shellValue(input.command, 'ShellExecution.command');
	if (!(typeof command === 'string' ? command : command.value).trim()) throw new TypeError('ShellExecution command must not be empty');
	const args = array(input.args, 'ShellExecution.args').map(argument => shellValue(argument, 'ShellExecution argument'));
	if (args.length > 1024) throw new RangeError('ShellExecution has too many arguments');
	return Object.freeze({ type: 'shell', command, args: Object.freeze(args), ...(options === undefined ? {} : { options }) });
}

function shellValue(value: unknown, owner: string, configuration = false): string | ShellQuotedString {
	if (configuration && typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'string') {
		if (value.length > MAX_COMMAND_LENGTH || value.includes('\0')) throw new TypeError(`${owner} must be a bounded string without NUL`);
		return value;
	}
	const input = record(value, owner);
	const text = input.value;
	const quoting = configuration && typeof input.quoting === 'string' ? ({ escape: ShellQuoting.Escape, strong: ShellQuoting.Strong, weak: ShellQuoting.Weak } as Record<string, ShellQuoting>)[input.quoting] : input.quoting;
	if (typeof text !== 'string' || text.length > MAX_COMMAND_LENGTH || text.includes('\0') || ![ShellQuoting.Escape, ShellQuoting.Strong, ShellQuoting.Weak].includes(quoting as ShellQuoting)) throw new TypeError(`${owner} requires a bounded value and a valid quoting style`);
	return Object.freeze({ value: text, quoting: quoting as ShellQuoting });
}

function unsupportedVariables(value: string, resolvableVariables?: ReadonlySet<string>): boolean {
	return [...value.matchAll(/\$\{([^}]+)\}/g)].some(match => !isExecutionVariable(match[1]!) && !resolvableVariables?.has(match[1]!));
}

function freezeConfiguration<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		for (const child of Object.values(value)) freezeConfiguration(child);
		Object.freeze(value);
	}
	return value;
}

function task(id: string, label: string, command: string, source: WorkspaceTaskSource, group: WorkspaceTaskGroup, detail: string): IWorkspaceTask {
	return Object.freeze({ id, label, command, source, group, detail });
}

function packageTaskGroup(name: string): WorkspaceTaskGroup {
	const normalized = name.toLowerCase();
	if (normalized === "test" || normalized.startsWith("test:")) return "test";
	if (normalized === "start" || normalized === "dev" || normalized === "serve" || normalized.startsWith("start:") || normalized.startsWith("dev:")) return "run";
	if (normalized === "build" || normalized === "compile" || normalized === "check" || normalized.startsWith("build:")) return "build";
	return "other";
}

function taskGroup(value: unknown): WorkspaceTaskGroup {
	const candidate = typeof value === "string" ? value : typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).kind : undefined;
	return candidate === "build" || candidate === "test" || candidate === "clean" || candidate === "rebuild" ? candidate : "other";
}

function shellArgument(value: unknown, path: string): string {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") throw new TypeError(`${path} must be a string or finite number`);
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `"${value.replaceAll('"', '\\"')}"`;
}

function stableId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "task";
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
	return value;
}
