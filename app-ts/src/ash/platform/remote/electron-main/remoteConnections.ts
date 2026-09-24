import { canonicalRemoteConnectionDefinition } from "../common/remoteConnectionService.js";
import { canonicalRemoteConnectionName } from "../common/remoteConnectionService.js";
import type { IRemoteConnectionService } from "../common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../common/remoteConnectionService.js";
import type { RunRemoteCommand } from "./remoteCommand.js";
import { runRemoteCommand } from "./remoteCommand.js";
import { validLocalCommand } from "./remoteCommand.js";

const MAX_CONNECTIONS = 1024;

export interface RemoteConnectionsOptions {
	readonly remoteExecutable: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly scheduleConnect: (connection: RemoteConnectionDefinition) => void | Promise<void>;
	readonly runCommand?: RunRemoteCommand;
}

/** Uses the shared Rust catalog while keeping connection startup in Electron Main. */
export class RemoteConnections implements IRemoteConnectionService {
	readonly available = true;
	private readonly runCommand: RunRemoteCommand;
	private connectScheduled = false;

	constructor(readonly options: RemoteConnectionsOptions) {
		if (!validLocalCommand(options.remoteExecutable)) throw new Error("Remote connection command executable must be non-empty and contain no control characters");
		this.runCommand = options.runCommand ?? runRemoteCommand;
	}

	async list(): Promise<readonly RemoteConnectionDefinition[]> {
		const output = await this.invoke(["connections", "list"]);
		return parseConnectionList(output);
	}

	async save(connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> {
		const expected = canonicalRemoteConnectionDefinition(connection);
		const output = await this.invoke([
			"connections",
			"save",
			"--name",
			expected.name,
			"--host",
			expected.host,
			"--workspace",
			expected.workspace,
			"--mode",
			"create",
		]);
		return exactMutationResult(output, expected);
	}

	async update(originalName: string, connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> {
		const normalizedOriginalName = canonicalRemoteConnectionName(originalName);
		const expected = canonicalRemoteConnectionDefinition(connection);
		const output = await this.invoke([
			"connections",
			"update",
			"--name",
			normalizedOriginalName,
			"--new-name",
			expected.name,
			"--host",
			expected.host,
			"--workspace",
			expected.workspace,
		]);
		return exactMutationResult(output, expected);
	}

	async remove(name: string): Promise<RemoteConnectionDefinition | undefined> {
		const normalizedName = canonicalRemoteConnectionName(name);
		const output = await this.invoke(["connections", "remove", "--name", normalizedName]);
		const removed = parseConnection(output);
		if (removed && removed.name !== normalizedName) throw new Error("Remote connection removal returned a different named target");
		return removed;
	}

	async connect(name: string): Promise<void> {
		if (this.connectScheduled) throw new Error("A Remote connection window is already being opened");
		this.connectScheduled = true;
		try {
			const normalizedName = canonicalRemoteConnectionName(name);
			const output = await this.invoke(["connections", "get", "--name", normalizedName]);
			const connection = parseConnection(output);
			if (!connection) throw new Error(`Remote connection '${normalizedName}' no longer exists`);
			if (connection.name !== normalizedName) throw new Error("Remote connection lookup returned a different named target");
			await this.options.scheduleConnect(connection);
		} finally {
			this.connectScheduled = false;
		}
	}

	private async invoke(args: readonly string[]): Promise<string> {
		const result = await this.runCommand(this.options.remoteExecutable, args, this.options.environment);
		if (result.exitCode !== 0) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
			throw new Error(`Remote connection catalog command failed: ${diagnostic.slice(0, 8_000)}`);
		}
		return result.stdout;
	}
}

function parseConnectionList(output: string): readonly RemoteConnectionDefinition[] {
	const value = parseJson(output);
	if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) throw new Error("Remote connection catalog command returned an invalid list");
	const connections = value.map(connectionRecord);
	for (let index = 1; index < connections.length; index += 1) {
		if (connections[index - 1]!.name >= connections[index]!.name) throw new Error("Remote connection catalog command returned duplicate or unsorted names");
	}
	return Object.freeze(connections);
}

function parseConnection(output: string): RemoteConnectionDefinition | undefined {
	const value = parseJson(output);
	return value === null ? undefined : connectionRecord(value);
}

function connectionRecord(value: unknown): RemoteConnectionDefinition {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Remote connection catalog command returned an invalid record");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "host,name,workspace") throw new Error("Remote connection catalog command returned an invalid record");
	if (typeof record.name !== "string" || typeof record.host !== "string" || typeof record.workspace !== "string") {
		throw new Error("Remote connection catalog command returned an invalid record");
	}
	const connection = canonicalRemoteConnectionDefinition({ name: record.name, host: record.host, workspace: record.workspace });
	if (connection.name !== record.name || connection.host !== record.host || connection.workspace !== record.workspace) {
		throw new Error("Remote connection catalog command returned a non-canonical record");
	}
	return connection;
}

function exactMutationResult(output: string, expected: RemoteConnectionDefinition): RemoteConnectionDefinition {
	const actual = parseConnection(output);
	if (!actual || actual.name !== expected.name || actual.host !== expected.host || actual.workspace !== expected.workspace) {
		throw new Error("Remote connection mutation returned a different target");
	}
	return actual;
}

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		throw new Error("Remote connection catalog command returned invalid JSON");
	}
}
