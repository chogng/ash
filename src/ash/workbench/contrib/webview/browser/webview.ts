import type { CodeWindow } from '../../../../base/browser/window.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWebviewService = createDecorator<IWebviewService>('webviewService');

/** Tracks live views; the consumer that creates a view owns its disposal. */
export interface IWebviewService {
	readonly _serviceBrand: undefined;
	readonly activeWebview: IWebview | undefined;
	readonly webviews: Iterable<IWebview>;
	readonly onDidChangeActiveWebview: Event<IWebview | undefined>;
	createWebviewElement(initInfo: WebviewInitInfo): IWebviewElement;
}

export interface WebviewInitInfo {
	readonly title: string | undefined;
	readonly options: WebviewOptions;
}

export interface WebviewOptions {
	/** Ash forwards sandbox keyboard events to the owning editor group. */
	readonly forwardKeyboardEvents?: boolean;
}

export interface WebviewMessageReceivedEvent {
	readonly message: unknown;
}

/** Hosts controlled HTML with no access to the Workbench document or host APIs. */
export interface IWebview extends IDisposable {
	readonly isFocused: boolean;
	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;
	readonly onDidDispose: Event<void>;
	readonly onMessage: Event<WebviewMessageReceivedEvent>;
	setHtml(html: string): void;
	setTitle(title: string): void;
	/** Resolves after sending; replacement or disposal discards unsent messages. */
	postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): Promise<boolean>;
	focus(): void;
}

export interface IWebviewElement extends IWebview {
	readonly element: HTMLIFrameElement;
	readonly onDidKeyboardEvent: Event<KeyboardEvent>;
	/** Reparenting reloads iframe content. Mount once in the owning pane. */
	mountTo(parent: HTMLElement, targetWindow: CodeWindow): void;
}
