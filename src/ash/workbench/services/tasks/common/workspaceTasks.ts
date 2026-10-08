import { parseJsonc } from "../../../../base/common/jsonc.js";
import { type IWorkspaceTask, type WorkspaceTaskGroup, type WorkspaceTaskSource } from "./taskService.js";

const MAX_TASKS = 256;
const MAX_COMMAND_LENGTH = 32_768;

/** Preserves VS Code task configuration and identifies execution settings Ash cannot honor. */
export function parseWorkspaceTasks(source: string): readonly IWorkspaceTask[] {
	const document = record(parseJsonc(source, ".vscode/tasks.json"), ".vscode/tasks.json");
	if (document.version !== "2.0.0") throw new TypeError(".vscode/tasks.json version must be '2.0.0'");
	if (!Array.isArray(document.tasks)) throw new TypeError(".vscode/tasks.json tasks must be an array");
	if (document.tasks.length > MAX_TASKS) throw new RangeError(`.vscode/tasks.json cannot contain more than ${MAX_TASKS} tasks`);
	const { tasks, version, ...defaults } = document;
	freezeConfiguration(defaults);
	return Object.freeze(tasks.map((value, index) => parseWorkspaceTask(value, index, String(version), defaults)));
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

function parseWorkspaceTask(value: unknown, index: number, version: string, defaults: Readonly<Record<string, unknown>>): IWorkspaceTask {
	const input = record(value, `.vscode/tasks.json tasks[${index}]`);
	const effective = { ...defaults, ...input };
	if (defaults.options !== undefined || input.options !== undefined) {
		const defaultOptions = defaults.options === undefined ? {} : record(defaults.options, 'options');
		const taskOptions = input.options === undefined ? {} : record(input.options, `tasks[${index}].options`);
		const options = { ...defaultOptions, ...taskOptions };
		// An empty task environment does not remove inherited variables.
		if (defaultOptions.env !== undefined || taskOptions.env !== undefined) {
			options.env = { ...(defaultOptions.env === undefined ? {} : record(defaultOptions.env, 'options.env')), ...(taskOptions.env === undefined ? {} : record(taskOptions.env, `tasks[${index}].options.env`)) };
		}
		effective.options = options;
	}
	for (const key of ['windows', 'osx', 'linux', 'presentation', 'runOptions']) {
		if (defaults[key] !== undefined || input[key] !== undefined) {
			effective[key] = { ...(defaults[key] === undefined ? {} : record(defaults[key], key)), ...(input[key] === undefined ? {} : record(input[key], `tasks[${index}].${key}`)) };
		}
	}
	const type = effective.type === undefined ? "shell" : string(effective.type, `tasks[${index}].type`);
	// Provider-defined tasks may omit their label until the provider resolves them.
	const label = input.label === undefined && type !== 'shell' && type !== 'process' ? type : string(input.label, `tasks[${index}].label`).trim();
	if (!label || label.length > 256) throw new TypeError(`tasks[${index}].label must contain 1 to 256 characters`);
	const unsupported = unsupportedExecution(effective, type);
	const baseCommand = typeof effective.command === 'string' ? effective.command.trim() : '';
	if (effective.command !== undefined && typeof effective.command !== 'string') unsupported.push('command');
	if (!baseCommand && unsupported.length === 0) throw new TypeError(`tasks[${index}].command must contain 1 to ${MAX_COMMAND_LENGTH} characters without NUL`);
	const args = effective.args === undefined ? [] : array(effective.args, `tasks[${index}].args`).map((argument, argumentIndex) => {
		// Quoting objects and expansion-sensitive arguments need the actual shell's quoting contract.
		if (typeof argument !== 'string' && typeof argument !== 'number' || typeof argument === 'string' && (/[\\"$`%!\r\n\0]/.test(argument) || unsupportedVariables(argument))) {
			unsupported.push(`args[${argumentIndex}]`);
			return typeof argument === 'string' ? argument : '';
		}
		return shellArgument(argument, `tasks[${index}].args[${argumentIndex}]`);
	});
	if (unsupportedVariables(baseCommand)) unsupported.push('command');
	const command = [baseCommand, ...args].filter(Boolean).join(" ");
	if ((!command && unsupported.length === 0) || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) throw new TypeError(`tasks[${index}].command must contain 1 to ${MAX_COMMAND_LENGTH} characters without NUL`);
	return Object.freeze({
		...task(`vscode:${index}:${stableId(label)}`, label, command, "vscode", taskGroup(effective.group), typeof effective.detail === 'string' ? effective.detail : type === "shell" ? "Shell task" : type === "process" ? "Process task" : type),
		configuration: Object.freeze({ version, defaults, task: freezeConfiguration(input) }),
		unsupportedFeatures: Object.freeze([...new Set(unsupported)]),
	});
}

function unsupportedExecution(input: Readonly<Record<string, unknown>>, type: string): string[] {
	const unsupported = type === 'shell' ? [] : [`type:${type}`];
	if (input.options !== undefined) {
		const options = record(input.options, 'options');
		if (options.cwd !== undefined) unsupported.push('options.cwd');
		if (options.env !== undefined && Object.keys(record(options.env, 'options.env')).length > 0) unsupported.push('options.env');
		if (options.shell !== undefined) unsupported.push('options.shell');
	}
	for (const key of ['dependsOn', 'problemMatcher']) {
		if (input[key] !== undefined && !(Array.isArray(input[key]) && input[key].length === 0)) unsupported.push(key);
	}
	if (input.isBackground !== undefined && input.isBackground !== false) unsupported.push('isBackground');
	if (input.dependsOrder !== undefined && unsupported.includes('dependsOn')) unsupported.push('dependsOrder');
	if (input.runOptions !== undefined) {
		const options = record(input.runOptions, 'runOptions');
		if (options.runOn !== undefined && options.runOn !== 'default') unsupported.push('runOptions.runOn');
		if (options.reevaluateOnRerun !== undefined && options.reevaluateOnRerun !== true) unsupported.push('runOptions.reevaluateOnRerun');
		if (options.instanceLimit !== undefined) unsupported.push('runOptions.instanceLimit');
	}
	for (const key of ['windows', 'osx', 'linux']) {
		if (input[key] !== undefined && Object.keys(record(input[key], key)).length > 0) unsupported.push(key);
	}
	if (input.presentation !== undefined) {
		const presentation = record(input.presentation, 'presentation');
		if (['reveal', 'revealProblems', 'echo', 'focus', 'panel', 'showReuseMessage', 'clear', 'group', 'close'].some(key => presentation[key] !== undefined)) unsupported.push('presentation');
	}
	return unsupported;
}

function unsupportedVariables(value: string): boolean {
	return [...value.matchAll(/\$\{([^}]+)\}/g)].some(match => match[1] !== 'workspaceFolder' && match[1] !== 'workspaceFolderBasename');
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
	return candidate === "build" || candidate === "test" ? candidate : "other";
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
