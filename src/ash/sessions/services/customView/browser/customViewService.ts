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
}

export interface ICustomViewService {
	readonly activeCustomView: IObservable<ICustomViewDescriptor | undefined>;
	readonly activeCustomViewOpen: IObservable<ICustomViewOpenRequest | undefined>;
	registerCustomView(descriptor: ICustomViewDescriptor, options?: { readonly restore?: boolean }): IDisposable;
	showCustomView(id: string, options?: { readonly source: 'history' }): void;
	hideCustomView(tx?: ITransaction): void;
}

export const ICustomViewService = createServiceIdentifier<ICustomViewService>('customViewService');

const activeViewKey = 'sessions.activeCustomView';

export class CustomViewService extends Disposable implements ICustomViewService {
	private readonly descriptors = new Map<string, ICustomViewDescriptor>();
	private readonly opening = observableValue<ICustomViewOpenRequest | undefined>(this, undefined);
	readonly activeCustomViewOpen = this.opening;
	readonly activeCustomView = derived(reader => this.opening.read(reader)?.descriptor);
	private desired: string | undefined;

	constructor(
		@ILogService private readonly log: ILogService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.desired = storage.get(activeViewKey, StorageScope.WORKSPACE);
	}

	registerCustomView(descriptor: ICustomViewDescriptor, options?: { readonly restore?: boolean }): IDisposable {
		if (!descriptor.id.trim() || this.descriptors.has(descriptor.id)) throw new Error(`Invalid or duplicate custom view: ${descriptor.id}`);
		this.descriptors.set(descriptor.id, descriptor);
		if (this.desired === descriptor.id) {
			if (options?.restore === false) this.hideCustomView();
			else this.opening.set({ descriptor, source: 'restore' }, undefined);
		}
		return toDisposable(() => {
			if (this.descriptors.get(descriptor.id) !== descriptor) return;
			this.descriptors.delete(descriptor.id);
			if (this.activeCustomView.get() === descriptor) this.opening.set(undefined, undefined);
		});
	}

	showCustomView(id: string, options?: { readonly source: 'history' }): void {
		const descriptor = this.descriptors.get(id);
		if (!descriptor) {
			this.log.warn(`Custom view is not registered: ${id}`);
			return;
		}
		this.desired = id;
		this.storage.store(activeViewKey, id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.opening.set({ descriptor, source: options?.source ?? 'explicit' }, undefined);
	}

	hideCustomView(tx?: ITransaction): void {
		this.desired = undefined;
		this.storage.remove(activeViewKey, StorageScope.WORKSPACE);
		this.opening.set(undefined, tx);
	}
}

registerSingleton(ICustomViewService, CustomViewService, InstantiationType.Delayed);
