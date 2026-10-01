import type { IDimension } from '../../base/browser/dom.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';

/** The host retains each page until disposal, preserving its state across navigation. */
export interface ISessionsPageView extends IDisposable {
	readonly domNode: HTMLElement;
	focus(): void;
	layout(dimension: IDimension): void;
}

class SessionsPageContributionRegistry {
	private readonly pages = new Map<string, SyncDescriptor<ISessionsPageView>>();

	public registerPage(id: string, descriptor: SyncDescriptor<ISessionsPageView>): void {
		if (this.pages.has(id)) {
			throw new Error(`Sessions page already registered: ${id}`);
		}
		this.pages.set(id, descriptor);
	}

	public getPages(): ReadonlyMap<string, SyncDescriptor<ISessionsPageView>> {
		return this.pages;
	}
}

export const SessionsPageRegistry = new SessionsPageContributionRegistry();
