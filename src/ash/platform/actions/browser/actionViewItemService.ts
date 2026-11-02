import type { ActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { ActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../base/common/actions.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator, type IInstantiationService } from '../../instantiation/common/instantiation.js';
import type { MenuId } from '../common/actions.js';

export interface IActionViewItemFactory {
	(action: IAction, options: ActionViewItemOptions, instantiationService: IInstantiationService, windowId: number): ActionViewItem | undefined;
}

export const IActionViewItemService = createDecorator<IActionViewItemService>('actionViewItemService');

/** Window-owned presentations keyed by the menu and command or submenu they render. */
export interface IActionViewItemService {
	readonly onDidChange: Event<MenuId>;
	register(menu: MenuId, item: MenuId | string, provider: IActionViewItemFactory, event?: Event<unknown>): IDisposable;
	lookUp(menu: MenuId, item: MenuId | string): IActionViewItemFactory | undefined;
}

class ActionViewItemService extends Disposable implements IActionViewItemService {
	private readonly presentations = new Map<MenuId, Map<MenuId | string, IActionViewItemFactory>>();
	private readonly changed = this._register(new Emitter<MenuId>());
	readonly onDidChange = this.changed.event;
	private readonly lifetimes = this._register(new DisposableStore());

	register(menu: MenuId, item: MenuId | string, provider: IActionViewItemFactory, event?: Event<unknown>): IDisposable {
		this.assertNotDisposed();
		let entries = this.presentations.get(menu);
		if (!entries) this.presentations.set(menu, entries = new Map());
		if (entries.has(item)) throw new Error(`Action presentation is already registered in ${menu.id}`);
		entries.set(item, provider);
		const lifetime = this.lifetimes.add(new DisposableStore());
		if (event) lifetime.add(event(() => this.changed.fire(menu)));
		lifetime.add(toDisposable(() => {
			entries.delete(item);
			if (!entries.size) this.presentations.delete(menu);
			this.changed.fire(menu);
		}));
		this.changed.fire(menu);
		return toDisposable(() => { this.lifetimes.delete(lifetime); lifetime.dispose(); });
	}

	lookUp(menu: MenuId, item: MenuId | string): IActionViewItemFactory | undefined {
		return this.presentations.get(menu)?.get(item);
	}
}

registerSingleton(IActionViewItemService, ActionViewItemService, InstantiationType.Delayed);
