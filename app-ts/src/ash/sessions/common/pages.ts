import type { Icon } from '../../base/common/icon.js';
import type { IObservable } from '../../base/common/observable.js';
import type { URI } from '../../base/common/uri.js';
import { createServiceIdentifier } from '../../platform/instantiation/common/instantiation.js';

/** A page composes existing Parts; it does not own their session or editor models. */
export interface ISessionsPageDescriptor {
	readonly id: string;
	readonly title: string;
	readonly titleKey: string;
	readonly icon: Icon;
	readonly activeIcon?: Icon;
	readonly order: number;
	readonly layout: {
		readonly conversation?: 'chat' | 'code';
		readonly sidebar: 'sessions' | 'hidden' | { readonly containerId: string };
		readonly primary: 'sessions' | 'editor';
		readonly editor: 'hidden' | 'session' | { readonly resource: URI };
		readonly auxiliaryBar: 'hidden' | 'session' | { readonly containerId: string };
		readonly panel: boolean;
	};
}

export interface ISessionsPageService {
	readonly activePage: IObservable<string>;
	readonly pages: IObservable<readonly ISessionsPageDescriptor[]>;
	getPage(id: string): ISessionsPageDescriptor;
	openPage(id: string): void;
	movePage(id: string, targetId: string | undefined, position: 'before' | 'after'): void;
}

export const ISessionsPageService = createServiceIdentifier<ISessionsPageService>('sessionsPageService');
