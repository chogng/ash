import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { StorageScope, StorageTarget, WillSaveStateReason, type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, type StorageValue } from '../../../../../platform/storage/common/storage.js';
import { NotificationService } from '../../common/notificationService.js';

/** Real notification behavior with an isolated state store and no browser lifetime. */
export class TestNotificationService extends NotificationService {
	constructor() {
		const storage = new NotificationTestStorage();
		super(storage);
		this._register(storage);
	}
}

class NotificationTestStorage extends Disposable implements IStorageService {
	private readonly entries = new Map<string, { value: string; target: StorageTarget; }>();
	private readonly changes = this._register(new Emitter<IStorageValueChangeEvent>());
	readonly onDidChangeValue = this.changes.event;
	private readonly saves = this._register(new Emitter<IWillSaveStateEvent>());
	readonly onWillSaveState = this.saves.event;

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined { return this.entries.get(`${scope}/${key}`)?.value ?? fallbackValue; }
	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.get(key, scope);
		return value === undefined ? fallbackValue : value === 'true';
	}
	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.get(key, scope);
		return value === undefined ? fallbackValue : Number(value);
	}
	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
		if (value === undefined || value === null) { this.remove(key, scope); return; }
		this.entries.set(`${scope}/${key}`, { value: String(value), target });
		this.changes.fire({ key, scope, target, external: false });
	}
	remove(key: string, scope: StorageScope): void {
		if (this.entries.delete(`${scope}/${key}`)) this.changes.fire({ key, scope, target: undefined, external: false });
	}
	keys(scope: StorageScope, target: StorageTarget): readonly string[] {
		return [...this.entries].filter(([key, entry]) => key.startsWith(`${scope}/`) && entry.target === target).map(([key]) => key.slice(scope.length + 1));
	}
	isNew(): boolean { return true; }
	async flush(reason = WillSaveStateReason.PERIODIC): Promise<void> { this.saves.fire({ reason }); }
}
