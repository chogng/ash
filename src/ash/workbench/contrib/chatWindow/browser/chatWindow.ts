import type { IDimension } from '../../../../base/browser/dom.js';
import type { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { AuxiliaryWindowOpenOptions, IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { ChatWindowEdge, ChatWindowLayoutMode, ChatWindowTerminalPosition } from '../common/chatWindowLayout.js';

export const IChatWindowService = createDecorator<IChatWindowService>('chatWindowService');

/** A retained chat supplied by its host. The view survives a draft becoming a session. */
export interface IChatWindowContent {
	readonly element: HTMLElement;
	readonly title: string;
	isAvailable(): boolean;
	focus(window: IAuxiliaryWindow): void;
	setVisible(visible: boolean): void;
	layout?(dimension: IDimension): void;
	getResource(): URI;
	mount(mount: IChatWindowMount): void;
	/** Selects the destination conversation before the host receives its editors. */
	didReturn?(): void;
}

/** Lets the host swap in its placeholder and register reattachment before the window closes. */
export interface IChatWindowMount {
	readonly window: IAuxiliaryWindow;
	readonly titleId: string;
	readonly resources: DisposableStore;
	/** Ends this chat's tab without ending the other tabs in the window. */
	close(): void;
	setTitle(title: string): void;
	focus(): Promise<void>;
}

export interface IChatWindowProvider {
	/** Resolves the retained view synchronously so a browser can open the popup in the user gesture. */
	resolveContent(chat: URI): IChatWindowContent | undefined;
	/** Waits for the host's catalog before preparing a saved tab. */
	prepareChat?(chat: URI): Promise<void>;
	createChat?(chat: URI): URI | undefined;
	getChats?(): readonly { readonly resource: URI; readonly title: string; readonly description?: string; }[];
}

export interface IChatWindow {
	readonly windowId: number;
	readonly chatPart: IEditorPart;
	readonly mainPart: IEditorPart;
	readonly chats: IObservable<readonly URI[]>;
	readonly chat: IObservable<URI>;
	readonly terminalsPart: IEditorPart;
	focus(): Promise<void>;
	showEditor(): void;
	readonly layoutMode: ChatWindowLayoutMode;
	setLayoutMode(mode: ChatWindowLayoutMode): void;
	readonly terminalPosition: ChatWindowTerminalPosition;
	setTerminalPosition(position: ChatWindowTerminalPosition): void;
	toggleConversation(): void;
	moveEditorToEdge(edge: ChatWindowEdge): Promise<void>;
	/** Releases the popup when its retained view or host is being disposed. */
	close(): boolean;
}

export interface IChatWindowOpenOptions {
	readonly window?: IChatWindow;
	readonly preserveFocus?: boolean;
	readonly bounds?: AuxiliaryWindowOpenOptions;
}

export interface IChatWindowService {
	readonly _serviceBrand: undefined;
	registerProvider(provider: IChatWindowProvider): IDisposable;
	/** Opens a window for the chat, or focuses the window that already shows it. */
	open(chat: URI, options?: IChatWindowOpenOptions): Promise<IChatWindow | undefined>;
	readonly activeWindow: IChatWindow | undefined;
	readonly hasWindowsToRestore: boolean;
	openNewChat(window: IChatWindow): Promise<void>;
	pickChat(window: IChatWindow): void;
	restoreWindows(): Promise<void>;
	getWindow(windowId: number): IChatWindow | undefined;
	/** Requests a return through the runtime's window-close lifecycle. */
	moveToMainWindow(window: IChatWindow): Promise<void>;
}
