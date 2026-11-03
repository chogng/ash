import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableValue, type IObservable, type ITransaction } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ICustomViewDescriptor } from './customView.js';

export interface ICustomViewOpenRequest {
	readonly descriptor: ICustomViewDescriptor;
	readonly source: 'explicit' | 'history' | 'restore';
	readonly state?: string;
	readonly restorable?: false;
}

export interface ICustomViewService {
	readonly activeCustomView: IObservable<ICustomViewDescriptor | undefined>;
	readonly activeCustomViewOpen: IObservable<ICustomViewOpenRequest | undefined>;
	registerCustomView(descriptor: ICustomViewDescriptor, options?: { readonly restore?: boolean; }): IDisposable;
	showCustomView(id: string, options?: { readonly source?: 'history'; readonly state?: string; }): void;
	hideCustomView(tx?: ITransaction): void;
}

export const ICustomViewService = createServiceIdentifier<ICustomViewService>('customViewService');

const activeViewKey = 'sessions.activeCustomView';

export class CustomViewService extends Disposable implements ICustomViewService {
	private readonly descriptors = new Map<string, { descriptor: ICustomViewDescriptor; restorable?: false; }>();
	private readonly opening = observableValue<ICustomViewOpenRequest | undefined>(this, undefined);
	readonly activeCustomViewOpen = this.opening;
	readonly activeCustomView = derived(reader => this.opening.read(reader)?.descriptor);
	private desired: string | undefined;

	constructor(@ILogService private readonly log: ILogService, @IStorageService private readonly storage: IStorageService) {
		super();
		this.desired = storage.get(activeViewKey, StorageScope.WORKSPACE);
	}

	registerCustomView(descriptor: ICustomViewDescriptor, options?: { readonly restore?: boolean; }): IDisposable {
		if (!descriptor.id.trim() || this.descriptors.has(descriptor.id)) throw new Error(`Invalid or duplicate custom view: ${descriptor.id}`);
		const registered = { descriptor, ...(options?.restore === false ? { restorable: false as const } : {}) };
		this.descriptors.set(descriptor.id, registered);
		if (this.desired === descriptor.id) {
			if (registered.restorable === false) this.hideCustomView();
			else this.opening.set({ descriptor, source: 'restore' }, undefined);
		}
		return toDisposable(() => {
			if (this.descriptors.get(descriptor.id) !== registered) return;
			this.descriptors.delete(descriptor.id);
			if (this.activeCustomView.get() === descriptor) this.opening.set(undefined, undefined);
		});
	}

	showCustomView(id: string, options?: { readonly source?: 'history'; readonly state?: string; }): void {
		const registered = this.descriptors.get(id);
		if (!registered) {
			this.log.warn(`Custom view is not registered: ${id}`);
			return;
		}
		const { descriptor, restorable } = registered;
		if (descriptor.acceptsState && (options?.state === undefined || !descriptor.acceptsState(options.state))) { return; }
		this.desired = id;
		this.storage.store(activeViewKey, id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.opening.set({ descriptor, restorable, source: options?.source ?? 'explicit', ...(options?.state !== undefined ? { state: options.state } : {}) }, undefined);
	}

	hideCustomView(tx?: ITransaction): void {
		this.desired = undefined;
		this.storage.remove(activeViewKey, StorageScope.WORKSPACE);
		this.opening.set(undefined, tx);
	}
}

registerSingleton(ICustomViewService, CustomViewService, InstantiationType.Delayed);
