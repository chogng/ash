import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { INativeMenubarData, INativeMenubarSelection } from '../common/nativeMenubar.js';

export const IMenubarService = createDecorator<IMenubarService>('menubarService');

/** Native menu transport for the current renderer window. Main owns the installed menu. */
export interface IMenubarService {
	readonly _serviceBrand: undefined;
	readonly onDidSelect: Event<INativeMenubarSelection>;
	/** IPC derives the target window from the sender, never from renderer-supplied data. */
	updateMenubar(menuData: INativeMenubarData): Promise<void>;
}
