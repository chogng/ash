import type { Event } from '../../base/common/event.js';
import type { DisposableStore } from '../../base/common/lifecycle.js';
import type { IStorageService, IStorageValueChangeEvent, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { Themable, type IThemeService } from '../../platform/theme/common/themeService.js';
import { Memento } from './memento.js';

/** Owns the save boundary and theme subscription shared by Workbench components. */
export class Component<MementoType extends object = object> extends Themable {
	private readonly componentState: Memento<MementoType>;

	constructor(
		private readonly componentId: string,
		themeService: IThemeService,
		storageService: IStorageService,
	) {
		const state = new Memento<MementoType>(componentId, storageService);
		super(themeService);
		this.componentState = state;
		this._register(storageService.onWillSaveState(() => {
			// Collect live control state before serializing; the storage owner flushes afterwards.
			this.saveState();
			this.componentState.saveMemento();
		}));
	}

	public getId(): string {
		return this.componentId;
	}

	protected getMemento(scope: StorageScope, target: StorageTarget): Partial<MementoType> {
		return this.componentState.getMemento(scope, target);
	}

	protected reloadMemento(scope: StorageScope): void {
		this.componentState.reloadMemento(scope);
	}

	protected onDidChangeMementoValue(scope: StorageScope, disposables: DisposableStore): Event<IStorageValueChangeEvent> {
		return this.componentState.onDidChangeValue(scope, disposables);
	}

	protected saveState(): void { }
}
