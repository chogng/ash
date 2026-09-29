import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import type { ExplorerItem } from '../common/explorerModel.js';
import type { IExplorerClipboard, IExplorerClipboardItem, IExplorerService, IExplorerView } from './files.js';

/** Exposes the active Explorer selection to file commands. */
export class ExplorerService implements IExplorerService {
	declare readonly _serviceBrand: undefined;
	private view: IExplorerView | undefined;
	private readonly clipboardChanged = new Emitter<void>();
	readonly onDidChangeClipboard = this.clipboardChanged.event;
	private clipboard: IExplorerClipboard = { items: [], cut: false };

	public getToCopy(): IExplorerClipboard { return this.clipboard; }
	public setToCopy(items: readonly IExplorerClipboardItem[], cut: boolean): void {
		this.clipboard = { items: items.map(({ resource, name, kind }) => ({ resource, name, kind })), cut };
		this.clipboardChanged.fire();
	}

	public getContext(): readonly ExplorerItem[] {
		return this.view?.getContext() ?? [];
	}

	public getAccessibleContent(): string | undefined {
		return this.view?.getAccessibleContent();
	}

	public focus(): void {
		this.view?.focus();
	}

	public registerView(view: IExplorerView): IDisposable {
		if (this.view) {
			throw new Error('An Explorer view is already registered.');
		}
		this.view = view;
		return toDisposable(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}
}
