import { VSBuffer } from '../../../../../base/common/buffer.js';
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
