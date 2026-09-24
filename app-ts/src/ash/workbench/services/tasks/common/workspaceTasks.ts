import { parseJsonc } from "../../../../base/common/jsonc.js";
import { type IWorkspaceTask, type WorkspaceTaskGroup, type WorkspaceTaskSource } from "./taskService.js";

const MAX_TASKS = 256;
const MAX_COMMAND_LENGTH = 32_768;

/** Parses the supported shell/process subset of VS Code's tasks.json format. */
export function parseWorkspaceTasks(source: string): readonly IWorkspaceTask[] {
	const document = record(parseJsonc(source, ".vscode/tasks.json"), ".vscode/tasks.json");
	if (document.version !== "2.0.0") throw new TypeError(".vscode/tasks.json version must be '2.0.0'");
	if (!Array.isArray(document.tasks)) throw new TypeError(".vscode/tasks.json tasks must be an array");
	if (document.tasks.length > MAX_TASKS) throw new RangeError(`.vscode/tasks.json cannot contain more than ${MAX_TASKS} tasks`);
	return Object.freeze(document.tasks.map((value, index) => parseWorkspaceTask(value, index)));
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

function parseWorkspaceTask(value: unknown, index: number): IWorkspaceTask {
	const input = record(value, `.vscode/tasks.json tasks[${index}]`);
	const type = input.type === undefined ? "shell" : string(input.type, `tasks[${index}].type`);
	if (type !== "shell" && type !== "process") throw new TypeError(`tasks[${index}].type must be 'shell' or 'process'`);
	const label = string(input.label, `tasks[${index}].label`).trim();
	if (!label || label.length > 256) throw new TypeError(`tasks[${index}].label must contain 1 to 256 characters`);
	const baseCommand = string(input.command, `tasks[${index}].command`).trim();
	const args = input.args === undefined ? [] : array(input.args, `tasks[${index}].args`).map((argument, argumentIndex) => shellArgument(argument, `tasks[${index}].args[${argumentIndex}]`));
	const command = [baseCommand, ...args].filter(Boolean).join(" ");
	if (!command || command.length > MAX_COMMAND_LENGTH) throw new TypeError(`tasks[${index}].command must contain 1 to ${MAX_COMMAND_LENGTH} characters`);
	return task(`vscode:${index}:${stableId(label)}`, label, command, "vscode", taskGroup(input.group), type === "process" ? "Process task" : "Shell task");
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
