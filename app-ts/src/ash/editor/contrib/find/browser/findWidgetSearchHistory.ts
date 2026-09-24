import { Emitter, type Event } from '../../../../base/common/event.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** Workspace search terms shared by editor find widgets. */
export class FindWidgetSearchHistory {
	public static readonly FIND_HISTORY_KEY = 'workbench.find.history';
	private static instance: FindWidgetSearchHistory | null = null;
	private values = new Set<string>();
	private readonly changeEmitter = new Emitter<string[]>();
	public readonly onDidChange: Event<string[]> = this.changeEmitter.event;

	public static getOrCreate(storageService: IStorageService): FindWidgetSearchHistory {
		return this.instance ??= new FindWidgetSearchHistory(storageService);
	}

	constructor(private readonly storageService: IStorageService) { this.load(); }

	public add(value: string): this { this.values.add(value); void this.save(); return this; }
	public delete(value: string): boolean { const removed = this.values.delete(value); if (removed) void this.save(); return removed; }
	public has(value: string): boolean { return this.values.has(value); }
	public clear(): void { this.values.clear(); void this.save(); }
	public forEach(callback: (value: string, value2: string, set: Set<string>) => void, thisArg?: unknown): void {
		this.load();
		this.values.forEach(callback, thisArg);
	}
	public replace(values: string[]): void { this.values = new Set(values); void this.save(); }

	public load(): void {
		const raw = this.storageService.get(FindWidgetSearchHistory.FIND_HISTORY_KEY, StorageScope.WORKSPACE);
		if (!raw) { this.values.clear(); return; }
		try {
			const parsed: unknown = JSON.parse(raw);
			this.values = new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
		} catch {
			this.values.clear();
		}
	}

	public async save(): Promise<void> {
		const values = [...this.values];
		this.storageService.store(FindWidgetSearchHistory.FIND_HISTORY_KEY, JSON.stringify(values), StorageScope.WORKSPACE, StorageTarget.USER);
		this.changeEmitter.fire(values);
	}
}
