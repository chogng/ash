import { Disposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';

/** Profile-scoped command recency, shared through the window's storage service. */
export class CommandsHistory extends Disposable {
	public static readonly DEFAULT_COMMANDS_HISTORY_LENGTH = 50;
	private static readonly storageKey = 'commandPalette.mru.cache';
	private entries: string[];

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.entries = this.readEntries();
		this._register(
			storageService.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === CommandsHistory.storageKey) {
					this.entries = this.readEntries();
				}
			}),
		);
		this._register(
			configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('workbench.commandPalette.history')) this.saveEntries();
			}),
		);
	}

	public peek(commandId: string): number | undefined {
		const entries = this.entries.slice(-this.limit);
		if (this.limit === 0) return undefined;
		const index = entries.indexOf(commandId);
		return index < 0 ? undefined : index + 1;
	}

	public push(commandId: string): void {
		if (this.limit === 0) return;
		this.entries = this.entries.filter(id => id !== commandId);
		this.entries.push(commandId);
		this.saveEntries();
	}

	public remove(commandId: string): void {
		this.entries = this.entries.filter(id => id !== commandId);
		this.saveEntries();
	}

	public static getConfiguredCommandHistoryLength(configurationService: IConfigurationService): number {
		return configurationService.getValue<number>('workbench.commandPalette.history') ?? CommandsHistory.DEFAULT_COMMANDS_HISTORY_LENGTH;
	}

	public static clearHistory(_configurationService: IConfigurationService, storageService: IStorageService): void {
		storageService.remove(CommandsHistory.storageKey, StorageScope.PROFILE);
	}

	private get limit(): number {
		return Math.floor(CommandsHistory.getConfiguredCommandHistoryLength(this.configurationService));
	}

	private saveEntries(): void {
		this.entries = this.limit === 0 ? [] : this.entries.slice(-this.limit);
		this.storageService.store(CommandsHistory.storageKey, JSON.stringify({ version: 1, entries: this.entries }), StorageScope.PROFILE, StorageTarget.USER);
	}

	private readEntries(): string[] {
		const stored = this.storageService.get(CommandsHistory.storageKey, StorageScope.PROFILE);
		if (!stored) return [];
		try {
			const value: unknown = JSON.parse(stored);
			if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.some(id => typeof id !== 'string' || !id)) return [];
			if (new Set(value.entries).size !== value.entries.length) return [];
			return this.limit === 0 ? [] : value.entries.slice(-this.limit);
		} catch {
			// Recency is reconstructable; corrupt persisted state must not block commands.
			return [];
		}
	}
}
