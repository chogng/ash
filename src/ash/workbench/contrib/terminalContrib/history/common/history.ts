import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { Event } from '../../../../../base/common/event.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TerminalHistorySettingId } from './terminal.history.js';

const STORAGE_KEY = 'terminal.shellIntegration.commandHistory.v1';
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_COMMAND_CHARACTERS = 32768;
const MAX_HISTORY_BYTES = 512 * 1024;

export interface ITerminalHistoryCommand {
	readonly shellId: string;
	readonly command: string;
}

interface ISerializedHistory {
	readonly entries: readonly ITerminalHistoryCommand[];
}

/** Owns the bounded, application-local history of explicitly completed Shell commands. */
export class TerminalCommandHistory {
	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly storageService: IStorageService,
	) { }

	getCommands(shellId: string): readonly ITerminalHistoryCommand[] {
		const limit = this.historyLimit();
		if (limit === 0 || !isValidShellId(shellId)) return [];
		return this.readEntries().filter(entry => entry.shellId === shellId).slice(-limit).reverse();
	}

	record(
		shellId: string,
		status: 'running' | 'completed' | 'succeeded' | 'failed' | 'canceled',
		command: string | undefined,
		isTrusted: boolean | undefined,
		storageDisabled: boolean,
	): void {
		const historyLimit = this.historyLimit();
		if (status === 'running' || historyLimit === 0 || storageDisabled || isTrusted !== true || !isValidShellId(shellId)
			|| typeof command !== 'string' || command.trim().length === 0 || command.length > MAX_COMMAND_CHARACTERS || command.includes('\0')) {
			return;
		}

		const entry = { shellId, command };
		const existingEntries = this.readEntries().filter(candidate => candidate.shellId !== shellId || candidate.command !== command);
		existingEntries.push(entry);
		const entries = retainLatestPerProfile(existingEntries, historyLimit);

		let serialized = JSON.stringify({ entries } satisfies ISerializedHistory);
		while (entries.length > 0 && VSBuffer.fromString(serialized).byteLength > MAX_HISTORY_BYTES) {
			entries.shift();
			serialized = JSON.stringify({ entries } satisfies ISerializedHistory);
		}
		this.storageService.store(STORAGE_KEY, serialized, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	clear(): void {
		this.storageService.remove(STORAGE_KEY, StorageScope.APPLICATION);
	}

	private readEntries(): ITerminalHistoryCommand[] {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw || raw.length > MAX_HISTORY_BYTES || VSBuffer.fromString(raw).byteLength > MAX_HISTORY_BYTES) return [];
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return [];
		}
		if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries)) return [];
		const entries: ITerminalHistoryCommand[] = [];
		for (const candidate of value.entries) {
			if (!candidate || typeof candidate !== 'object' || !('shellId' in candidate) || !('command' in candidate)) continue;
			const { shellId, command } = candidate;
			if (isValidShellId(shellId) && typeof command === 'string' && command.length > 0
				&& command.length <= MAX_COMMAND_CHARACTERS && !command.includes('\0')) {
				entries.push({ shellId, command });
			}
		}
		return entries;
	}

	private historyLimit(): number {
		const value = this.configurationService.getValue<number>(TerminalHistorySettingId.ShellIntegrationCommandHistory);
		return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_HISTORY_LIMIT;
	}
}

function retainLatestPerProfile(entries: ITerminalHistoryCommand[], limit: number): ITerminalHistoryCommand[] {
	const counts = new Map<string, number>();
	const retained: ITerminalHistoryCommand[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		const count = counts.get(entry.shellId) ?? 0;
		if (count >= limit) continue;
		counts.set(entry.shellId, count + 1);
		retained.push(entry);
	}
	return retained.reverse();
}

function isValidShellId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0-\x1f\x7f]/.test(value);
}

/** Bounded directory history within this workspace and execution host. */
export class TerminalDirectoryHistory {
	private readonly key = 'terminal.shellIntegration.directoryHistory.v1';
	readonly onDidChange: Event<void>;
	constructor(private readonly configuration: IConfigurationService, private readonly storage: IStorageService) {
		this.onDidChange = (listener, thisArgs, disposables) => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.WORKSPACE && event.key === this.key) listener.call(thisArgs);
		}, undefined, disposables);
	}

	getDirectories(scope: string): readonly string[] {
		return this.read().filter(entry => entry.scope === scope).slice(-this.limit()).reverse().map(entry => entry.path);
	}

	record(scope: string, path: string, isTrusted: boolean, disabled: boolean): void {
		const limit = this.limit();
		if (!limit || disabled || !isTrusted || !isValidShellId(scope) || !this.validPath(path)) return;
		const entries = this.read().filter(entry => entry.scope !== scope || entry.path !== path);
		entries.push({ scope, path });
		const counts = new Map<string, number>();
		const retained = entries.reverse().filter(entry => {
			const count = (counts.get(entry.scope) ?? 0) + 1;
			counts.set(entry.scope, count);
			return count <= limit;
		}).reverse();
		while (retained.length && VSBuffer.fromString(JSON.stringify(retained)).byteLength > MAX_HISTORY_BYTES) retained.shift();
		this.storage.store(this.key, JSON.stringify(retained), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	clear(): void { this.storage.remove(this.key, StorageScope.WORKSPACE); }

	private limit(): number {
		const value = this.configuration.getValue<number>(TerminalHistorySettingId.ShellIntegrationCommandHistory);
		return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10000) : DEFAULT_HISTORY_LIMIT;
	}

	private validPath(value: unknown): value is string {
		return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\x00-\x1f\x7f]/.test(value)
			&& (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value));
	}

	private read(): { scope: string; path: string; }[] {
		if (!this.limit()) return [];
		const raw = this.storage.get(this.key, StorageScope.WORKSPACE);
		if (!raw || raw.length > MAX_HISTORY_BYTES || VSBuffer.fromString(raw).byteLength > MAX_HISTORY_BYTES) return [];
		try {
			const value: unknown = JSON.parse(raw);
			if (!Array.isArray(value)) return [];
			return value.filter((entry): entry is { scope: string; path: string; } => !!entry && typeof entry === 'object' && isValidShellId(entry.scope) && this.validPath(entry.path));
		} catch { return []; }
	}
}
