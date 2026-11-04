import { terminalStrings } from '../common/terminalStrings.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { ITerminalInstance } from './terminal.js';
import { parseTerminalUri } from './terminalUri.js';
import type { IEditorCloseHandler } from '../../../common/editor/editorInput.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';

export interface TerminalEditorPaneState {
	readonly resource: URI;
	readonly size: number;
}

/** The editor owns a resource value; the terminal service retains the process and screen. */
export class TerminalEditorInput implements IResourceEditorInput {
	static readonly ID = 'workbench.editor.terminal';
	readonly typeId = TerminalEditorInput.ID;
	readonly editorId = TerminalEditorInput.ID;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	closeHandler: IEditorCloseHandler | undefined;
	private readonly paneState;
	readonly panes: IObservable<readonly TerminalEditorPaneState[]>;
	activeResource: URI | undefined;

	constructor(readonly resource: URI, readonly terminalInstance?: ITerminalInstance, readonly onDidChangeLabel?: Event<void>,
		panes: readonly TerminalEditorPaneState[] = [{ resource, size: 1 }],
	) {
		parseTerminalUri(resource);
		this.paneState = observableValue('terminal editor panes', panes.map(pane => ({ ...pane })));
		this.panes = this.paneState;
	}

	contains(resource: URI): boolean { return this.panes.get().some(pane => pane.resource.path === resource.path); }

	addPane(resource: URI, livePanes: readonly TerminalEditorPaneState[]): void {
		const activeIndex = livePanes.findIndex(pane => pane.resource.path === this.activeResource?.path);
		const index = activeIndex < 0 ? livePanes.length - 1 : activeIndex;
		const panes = livePanes.map(pane => ({ ...pane }));
		const size = index < 0 ? 1 : panes[index]!.size / 2;
		if (index >= 0) panes[index]!.size = size;
		panes.splice(index + 1, 0, { resource, size });
		this.paneState.set(panes, undefined);
	}

	removePane(resource: URI): void {
		if (this.activeResource?.path === resource.path) this.activeResource = undefined;
		this.paneState.set(this.panes.get().filter(pane => pane.resource.path !== resource.path), undefined);
	}

	resizePanes(sizes: ReadonlyMap<URI, number>): void {
		const panes = this.paneState.get();
		const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
		if (total <= 0) return;
		for (const pane of panes) {
			const size = sizes.get(pane.resource);
			if (size !== undefined) pane.size = size / total;
		}
	}

	get label(): string { return this.terminalInstance?.title ?? (this.resource.fragment || terminalStrings.terminal); }
	getIcon(): ITerminalInstance['profile']['icon'] { return this.terminalInstance?.profile.icon; }
}
