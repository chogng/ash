import { type ITerminalProfile, type ITerminalService } from "../../terminal/common/terminal.js";

interface RunInTerminalArguments {
	readonly kind: "integrated" | "external";
	readonly title: string | undefined;
	readonly cwd: string | undefined;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string | null>>;
	readonly argsCanBeInterpretedByShell: boolean;
}

/** Launches a DAP-requested debuggee through the existing integrated terminal boundary. */
export async function runDebuggeeInTerminal(terminalService: ITerminalService, value: unknown, dirId?: string): Promise<Readonly<Record<string, never>>> {
	const request = parseRunInTerminalArguments(value);
	if (request.kind === "external") throw new Error("External debug terminals are not supported; use an integrated terminal");
	const profiles = await terminalService.getProfiles();
	const profile = preferredProfile(profiles);
	const terminal = await terminalService.createTerminal({ dirId, dimensions: { rows: 30, cols: 120 }, profile: { type: "profile", profileId: profile.profileId }, title: request.title ?? "Debug" });
	terminal.write(`${terminalCommand(request, profile)}\r`);
	return Object.freeze({});
}

function parseRunInTerminalArguments(value: unknown): RunInTerminalArguments {
	const input = record(value, "runInTerminal arguments");
	const kind = input.kind === undefined ? "integrated" : input.kind;
	if (kind !== "integrated" && kind !== "external") throw new TypeError("runInTerminal kind must be 'integrated' or 'external'");
	const args = stringArray(input.args, "runInTerminal args", 256, 4096);
	if (args.length === 0) throw new TypeError("runInTerminal args must contain the executable");
	const env = input.env === undefined ? {} : environment(input.env);
	return Object.freeze({ kind, title: optionalString(input.title, "runInTerminal title", 256), cwd: optionalString(input.cwd, "runInTerminal cwd", 4096), args, env, argsCanBeInterpretedByShell: input.argsCanBeInterpretedByShell === true });
}

function terminalCommand(request: RunInTerminalArguments, profile: ITerminalProfile): string {
	const shell = shellKind(profile.profileId);
	const command = request.argsCanBeInterpretedByShell ? request.args.join(" ") : request.args.map(argument => quote(argument, shell)).join(" ");
	const prefix = shell === "powershell" ? powershellPrefix(request) : shell === "cmd" ? cmdPrefix(request) : posixPrefix(request);
	return prefix ? `${prefix}${command}` : command;
}

function powershellPrefix(request: RunInTerminalArguments): string {
	const parts = Object.entries(request.env).map(([key, value]) => value === null ? `Remove-Item -LiteralPath ${quote(`Env:${key}`, "powershell")} -ErrorAction SilentlyContinue` : `$env:${key}=${quote(value, "powershell")}`);
	if (request.cwd) parts.push(`Set-Location -LiteralPath ${quote(request.cwd, "powershell")}`);
	return parts.length > 0 ? `${parts.join("; ")}; & ` : "& ";
}

function cmdPrefix(request: RunInTerminalArguments): string {
	const parts = Object.entries(request.env).map(([key, value]) => `set "${key}=${value === null ? "" : escapeCmdEnvironmentValue(value)}"`);
	if (request.cwd) parts.push(`cd /d ${quote(request.cwd, "cmd")}`);
	return parts.length > 0 ? `${parts.join(" && ")} && ` : "";
}

function posixPrefix(request: RunInTerminalArguments): string {
	const environmentArguments = Object.entries(request.env).flatMap(([key, value]) => value === null ? ["-u", key] : [`${key}=${value}`]);
	const environmentPrefix = environmentArguments.length > 0 ? `env ${environmentArguments.map(value => quote(value, "posix")).join(" ")} ` : "";
	const directoryPrefix = request.cwd ? `cd -- ${quote(request.cwd, "posix")} && ` : "";
	return `${directoryPrefix}${environmentPrefix}`;
}

function quote(value: string, shell: "powershell" | "cmd" | "posix"): string {
	if (shell === "powershell") return `'${value.replaceAll("'", "''")}'`;
	if (shell === "cmd") {
		if (/[\r\n]/.test(value)) throw new TypeError("cmd debug terminal arguments cannot contain line breaks");
		return `"${value.replaceAll("%", "%%").replaceAll("\"", "\\\"")}"`;
	}
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function preferredProfile(profiles: readonly ITerminalProfile[]): ITerminalProfile {
	const profile = profiles.find(candidate => /^(?:powershell|pwsh)$/i.test(candidate.profileId)) ?? profiles.find(candidate => candidate.isDefault) ?? profiles[0];
	if (!profile) throw new Error("No terminal profile is available for the debuggee");
	return profile;
}

function shellKind(profileId: string): "powershell" | "cmd" | "posix" {
	if (/^(?:powershell|pwsh)$/i.test(profileId)) return "powershell";
	if (/^(?:cmd|command-prompt)$/i.test(profileId)) return "cmd";
	return "posix";
}

function environment(value: unknown): Readonly<Record<string, string | null>> {
	const input = record(value, "runInTerminal env");
	if (Object.keys(input).length > 256) throw new RangeError("runInTerminal env cannot contain more than 256 entries");
	return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, item]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new TypeError(`runInTerminal env key '${key}' is invalid`);
		if (item !== null && (typeof item !== "string" || item.length > 32_768 || item.includes("\0"))) throw new TypeError(`runInTerminal env '${key}' must be a bounded string or null`);
		return [key, item as string | null];
	})));
}

function stringArray(value: unknown, path: string, maximumItems: number, maximumLength: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${path} must be an array with at most ${maximumItems} items`);
	return Object.freeze(value.map((item, index) => {
		if (typeof item !== "string" || item.length > maximumLength || item.includes("\0")) throw new TypeError(`${path}[${index}] must be a bounded string`);
		return item;
	}));
}

function optionalString(value: unknown, path: string, maximumLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) throw new TypeError(`${path} must be a bounded string`);
	return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function escapeCmdEnvironmentValue(value: string): string { if (/[\r\n]/.test(value)) throw new TypeError("cmd debug terminal environment values cannot contain line breaks"); return value.replaceAll("%", "%%").replaceAll("\"", "\"\""); }
