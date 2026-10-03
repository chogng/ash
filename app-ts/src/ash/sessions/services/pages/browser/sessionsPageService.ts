import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SessionsPageRegistry, type ISessionsPageContribution } from '../../../browser/pages.js';
import type { ISessionsPageDescriptor, ISessionsPageService } from '../../../common/pages.js';

const pageOrderKey = 'sessions.activityBar.pageOrder';
const activePageKey = 'sessions.activityBar.activePage';

/** Window-local page activation; user order is shared by the profile across placements. */
export class SessionsPageService extends Disposable implements ISessionsPageService {
	public readonly activePage = observableValue<string>(this, 'chat');
	public readonly pages = observableValue<readonly ISessionsPageDescriptor[]>(this, []);
	private order: string[];

	constructor(@IStorageService private readonly storage: IStorageService) {
		super();
		this.order = this.readOrder();
		this.updatePages();
		const savedPage = storage.get(activePageKey, StorageScope.WORKSPACE);
		if (savedPage !== undefined && SessionsPageRegistry.getPages().has(savedPage)) {
			this.activePage.set(savedPage);
		}
		this._register(SessionsPageRegistry.onDidChange(() => this.updatePages()));
		this._register(storage.onDidChangeValue(event => {
			if (event.external && event.scope === StorageScope.PROFILE && event.key === pageOrderKey) {
				this.order = this.readOrder();
				this.updatePages();
			}
		}));
	}

	public getPage(id: string): ISessionsPageContribution {
		const page = SessionsPageRegistry.getPages().get(id);
		if (!page) {
			throw new Error(`Sessions page is not registered: ${id}`);
		}
		return page;
	}

	public openPage(id: string): void {
		this.getPage(id);
		if (this.activePage.get() === id) {
			return;
		}
		this.activePage.set(id);
		this.storage.store(activePageKey, id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	public movePage(id: string, targetId: string | undefined, position: 'before' | 'after'): void {
		this.getPage(id);
		if (targetId !== undefined) {
			this.getPage(targetId);
		}
		if (id === targetId) {
			return;
		}
		const order = this.pages.get().map(page => page.id).filter(pageId => pageId !== id);
		const index = targetId === undefined ? order.length : order.indexOf(targetId) + (position === 'after' ? 1 : 0);
		order.splice(index, 0, id);
		this.order = order;
		this.storage.store(pageOrderKey, JSON.stringify(order), StorageScope.PROFILE, StorageTarget.USER);
		this.updatePages();
	}

	private readOrder(): string[] {
		const raw = this.storage.get(pageOrderKey, StorageScope.PROFILE);
		if (raw === undefined) {
			return [];
		}
		const order: unknown = JSON.parse(raw);
		if (!Array.isArray(order) || !order.every(id => typeof id === 'string') || new Set(order).size !== order.length) {
			throw new TypeError(localize('sessions.activity.invalidOrder', 'Saved page order is invalid.'));
		}
		return order;
	}

	private updatePages(): void {
		const registered = [...SessionsPageRegistry.getPages().values()].sort((left, right) => left.order - right.order);
		const byId = new Map(registered.map(page => [page.id, page]));
		const ordered = this.order.filter(id => byId.has(id)).map(id => byId.get(id)!);
		this.pages.set([...ordered, ...registered.filter(page => !this.order.includes(page.id))]);
	}
}
