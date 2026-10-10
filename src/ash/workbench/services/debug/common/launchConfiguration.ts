import { normalizeDebugAdapterDescriptor } from './debugAdapterFactory.js';
import { parseJsonc } from "../../../../base/common/jsonc.js";
import { type IDebugCompound, type IDebugConfiguration, type IResolvedDebugConfiguration } from "./debugService.js";

const MAX_CONFIGURATIONS = 64;

/** Parses Ash's explicit generic-adapter extension of VS Code launch.json. */
export function parseLaunchConfigurations(source: string, resolveAdapter?: DebugAdapterResolver): readonly IDebugConfiguration[] {
	return parseLaunchConfigurationDocument(source, resolveAdapter).configurations;
}

/** null admits a registered dynamic type whose descriptor is resolved only at dispatch. */
export type DebugAdapterResolver = (type: string) => IResolvedDebugConfiguration["adapter"] | null | undefined;

export interface ParsedLaunchConfigurationDocument {
	readonly configurations: readonly IDebugConfiguration[];
	readonly compounds: readonly IDebugCompound[];
}

/** Parses launch configurations and compound orchestration owned by the Workbench. */
export function parseLaunchConfigurationDocument(source: string, resolveAdapter?: DebugAdapterResolver): ParsedLaunchConfigurationDocument {
	const document = record(parseJsonc(source, ".vscode/launch.json"), ".vscode/launch.json");
	if (document.version !== "0.2.0") throw new TypeError(".vscode/launch.json version must be '0.2.0'");
	if (!Array.isArray(document.configurations)) throw new TypeError(".vscode/launch.json configurations must be an array");
	if (document.configurations.length > MAX_CONFIGURATIONS) throw new RangeError(`.vscode/launch.json cannot contain more than ${MAX_CONFIGURATIONS} configurations`);
	const configurations = Object.freeze(document.configurations.map((value, index) => parseConfiguration(value, index, resolveAdapter)));
	const compoundsInput = document.compounds === undefined ? [] : array(document.compounds, ".vscode/launch.json compounds");
	if (compoundsInput.length > MAX_CONFIGURATIONS) throw new RangeError(`.vscode/launch.json cannot contain more than ${MAX_CONFIGURATIONS} compounds`);
	const compounds = Object.freeze(compoundsInput.map((value, index) => parseCompound(value, index)));
	return Object.freeze({ configurations, compounds });
}

function parseConfiguration(value: unknown, index: number, resolveAdapter: DebugAdapterResolver | undefined): IDebugConfiguration {
	const input = record(value, `configurations[${index}]`);
	const name = boundedString(input.name, `configurations[${index}].name`, 256);
	const type = boundedString(input.type, `configurations[${index}].type`, 128);
	const request = input.request;
	if (request !== "launch" && request !== "attach") throw new TypeError(`configurations[${index}].request must be 'launch' or 'attach'`);
	const adapter = input.debugServer !== undefined
		? normalizeDebugAdapterDescriptor({ connection: { type: 'server', port: input.debugServer } }, `configurations[${index}].debugServer`)
		: input.debugAdapter === undefined ? resolveAdapter?.(type) : parseAdapter(input.debugAdapter, index);
	// A dormant type registers its descriptor after onDebugResolve activation.
	// Discovery validates configuration data; DebugService checks its factory at launch.
	const preLaunchTask = optionalBoundedString(input.preLaunchTask, `configurations[${index}].preLaunchTask`, 256);
	const postDebugTask = optionalBoundedString(input.postDebugTask, `configurations[${index}].postDebugTask`, 256);
	const launchArguments = Object.fromEntries(Object.entries(input).filter(([key]) => !["name", "type", "request", "debugAdapter", "preLaunchTask", "postDebugTask"].includes(key)));
	ensureJsonCompatible(launchArguments, `configurations[${index}]`, 0);
	const frozenAdapter = adapter && adapter.connection === undefined && adapter.inline === undefined
		? Object.freeze({ ...adapter, arguments: Object.freeze([...adapter.arguments]), ...(adapter.env === undefined ? {} : { env: Object.freeze({ ...adapter.env }) }) })
		: adapter;
	return Object.freeze({ id: `launch:${index}:${stableId(name)}`, name, type, request, adapterExplicit: input.debugAdapter !== undefined || input.debugServer !== undefined, ...(frozenAdapter ? { adapter: frozenAdapter } : {}), arguments: Object.freeze(launchArguments), ...(preLaunchTask ? { preLaunchTask } : {}), ...(postDebugTask ? { postDebugTask } : {}) });
}

function parseAdapter(value: unknown, index: number): IResolvedDebugConfiguration["adapter"] {
	const adapter = record(value, `configurations[${index}].debugAdapter`);
	if (adapter.connection !== undefined) {
		if (Object.keys(adapter).some(key => !['connection', 'args'].includes(key))) { throw new TypeError('Debug Adapter connection cannot include executable options'); }
		return normalizeDebugAdapterDescriptor({ connection: adapter.connection, arguments: adapter.args }, `configurations[${index}].debugAdapter`);
	}
	const program = boundedString(adapter.program, `configurations[${index}].debugAdapter.program`, 4096);
	const argumentsList = adapter.args === undefined ? [] : array(adapter.args, `configurations[${index}].debugAdapter.args`).map((argument, argumentIndex) => {
		if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new TypeError(`configurations[${index}].debugAdapter.args[${argumentIndex}] must be a bounded string without NUL`);
		return argument;
	});
	if (argumentsList.length > 128) throw new RangeError(`configurations[${index}].debugAdapter.args cannot contain more than 128 values`);
	const cwd = optionalBoundedString(adapter.cwd, `configurations[${index}].debugAdapter.cwd`, 32768);
	const env: Record<string, string | null> | undefined = adapter.env === undefined ? undefined : {};
	if (env) {
		const input = record(adapter.env, `configurations[${index}].debugAdapter.env`);
		if (Object.keys(input).length > 128) throw new RangeError('Debug adapter environment has too many entries');
		for (const [key, value] of Object.entries(input)) {
			if (!key || key.length > 256 || /[=\0]/.test(key) || value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))) throw new TypeError('Invalid debug adapter environment');
			env[key] = value as string | null;
		}
	}
	return Object.freeze({ program, arguments: Object.freeze(argumentsList), ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env: Object.freeze(env) }) });
}

function parseCompound(value: unknown, index: number): IDebugCompound {
	const input = record(value, `compounds[${index}]`);
	const name = boundedString(input.name, `compounds[${index}].name`, 256);
	const configurations = array(input.configurations, `compounds[${index}].configurations`).map((configuration, configurationIndex) => {
		const path = `compounds[${index}].configurations[${configurationIndex}]`;
		if (typeof configuration === "string") return boundedString(configuration, path, 256);
		const reference = record(configuration, path);
		return Object.freeze({ name: boundedString(reference.name, `${path}.name`, 256), folder: boundedString(reference.folder, `${path}.folder`, 256) });
	});
	if (configurations.length === 0) throw new TypeError(`compounds[${index}].configurations must not be empty`);
	if (configurations.length > MAX_CONFIGURATIONS) throw new RangeError(`compounds[${index}].configurations cannot contain more than ${MAX_CONFIGURATIONS} values`);
	const preLaunchTask = optionalBoundedString(input.preLaunchTask, `compounds[${index}].preLaunchTask`, 256);
	if (input.stopAll !== undefined && typeof input.stopAll !== "boolean") throw new TypeError(`compounds[${index}].stopAll must be a boolean`);
	return Object.freeze({ id: `compound:${index}:${stableId(name)}`, name, configurations: Object.freeze(configurations), stopAll: input.stopAll === true, ...(preLaunchTask ? { preLaunchTask } : {}) });
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	return value;
}

function boundedString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new TypeError(`${path} must contain 1 to ${maximum} characters`);
	return value.trim();
}

function optionalBoundedString(value: unknown, path: string, maximum: number): string | undefined {
	return value === undefined ? undefined : boundedString(value, path, maximum);
}

function ensureJsonCompatible(value: unknown, path: string, depth: number): void {
	if (depth > 64) throw new RangeError(`${path} exceeds the supported nesting depth`);
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
	if (Array.isArray(value)) { value.forEach((item, index) => ensureJsonCompatible(item, `${path}[${index}]`, depth + 1)); return; }
	if (typeof value === "object") { Object.entries(value as Record<string, unknown>).forEach(([key, item]) => ensureJsonCompatible(item, `${path}.${key}`, depth + 1)); return; }
	throw new TypeError(`${path} must be JSON-compatible`);
}

function stableId(value: string): string {
	return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "configuration";
}
