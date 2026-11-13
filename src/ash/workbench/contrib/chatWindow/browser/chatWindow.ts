import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';

export const IChatWindowService = createServiceIdentifier<IChatWindowService>('chatWindowService');

/** A retained chat supplied by its host. The element keeps its identity when a draft becomes a session. */
export interface IChatWindowContent {
	readonly element: HTMLElement;
	readonly title: string;
	isAvailable(): boolean;
	focus(window: IAuxiliaryWindow): void;
	/** Swaps in the host's placeholder before mounting and registers the return of the view on close. */
	mount(window: IAuxiliaryWindow, header: HTMLElement, mountView: () => void, resources: DisposableStore): void;
}

export interface IChatWindow {
	focus(): Promise<void>;
	setTitle(title: string): void;
	close(): void;
}

export interface IChatWindowService {
	/** Opens a window for the retained view, or focuses the window that already shows it. */
	open(content: IChatWindowContent): Promise<void>;
	getWindowForChat(element: HTMLElement): IChatWindow | undefined;
}
