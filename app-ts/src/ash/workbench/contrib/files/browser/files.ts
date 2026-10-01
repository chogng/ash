import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { FileKind } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ExplorerItem } from '../common/explorerModel.js';

export interface IExplorerView {
	selectResource(resource: URI | undefined, reveal?: boolean | string): Promise<void>;
	getContext(): readonly ExplorerItem[];
	getAccessibleContent(): string;
	focus(): void;
}

export interface IExplorerClipboardItem {
	readonly resource: URI;
	readonly name: string;
	readonly kind: FileKind;
}

export interface IExplorerClipboard {
	readonly items: readonly IExplorerClipboardItem[];
	readonly cut: boolean;
}

export interface IExplorerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRoot: Event<void>;
	readonly onDidChangeResources: Event<readonly URI[] | undefined>;
	getRoot(): ExplorerItem | undefined;
	getContext(): readonly ExplorerItem[];
	/** The caller opens the Explorer view before requesting selection. */
	select(resource: URI, reveal?: boolean | string): Promise<void>;
	getAccessibleContent(): string | undefined;
	focus(): void;
	registerView(view: IExplorerView): IDisposable;
	readonly onDidChangeClipboard: Event<void>;
	getToCopy(): IExplorerClipboard;
	setToCopy(items: readonly IExplorerClipboardItem[], cut: boolean): void;
}

export const IExplorerService = createDecorator<IExplorerService>('explorerService');
export const ExplorerFocusedContext = new RawContextKey<boolean>('filesExplorerFocus', false);
