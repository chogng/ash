import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ExplorerItem } from '../common/explorerModel.js';

export interface IExplorerView {
	getContext(): readonly ExplorerItem[];
	getAccessibleContent(): string;
	focus(): void;
}

export interface IExplorerService {
	readonly _serviceBrand: undefined;
	getContext(): readonly ExplorerItem[];
	getAccessibleContent(): string | undefined;
	focus(): void;
	registerView(view: IExplorerView): IDisposable;
}

export const IExplorerService = createDecorator<IExplorerService>('explorerService');
export const ExplorerFocusedContext = new RawContextKey<boolean>('filesExplorerFocus', false);
