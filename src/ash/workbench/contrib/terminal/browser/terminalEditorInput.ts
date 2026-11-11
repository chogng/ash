import { terminalStrings } from '../common/terminalStrings.js';
import { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { ITerminalInstance } from './terminal.js';
import { parseTerminalUri } from './terminalUri.js';
import type { IEditorCloseHandler } from '../../../common/editor/editorInput.js';
import { derived, observableSignalFromEvent, observableValue, transaction, type IObservable } from '../../../../base/common/observable.js';
import { Direction, Orientation } from '../../../../base/browser/ui/grid/grid.js';

export interface TerminalEditorPaneState {
	readonly resource: URI;
	readonly size: number;
}

export type TerminalEditorPaneLayout = TerminalEditorPaneState | {
	readonly orientation: Orientation;
	readonly size: number;
	readonly children: readonly TerminalEditorPaneLayout[];
};

function leaves(layout: TerminalEditorPaneLayout | undefined): TerminalEditorPaneState[] {
	return !layout ? [] : 'children' in layout ? layout.children.flatMap(leaves) : [layout];
}

export function filterTerminalEditorLayout(layout: TerminalEditorPaneLayout | undefined, keep: (resource: URI) => boolean): TerminalEditorPaneLayout | undefined {
	if (!layout) return undefined;
	if ('resource' in layout) return keep(layout.resource) ? layout : undefined;
	const children = layout.children.map(child => filterTerminalEditorLayout(child, keep)).filter(child => child !== undefined);
	if (!children.length) return undefined;
	if (children.length === 1) return { ...children[0]!, size: layout.size };
	return {
		...layout, children: children.flatMap(child => {
			if (!('children' in child) || child.orientation !== layout.orientation) return [child];
			const total = child.children.reduce((sum, pane) => sum + pane.size, 0);
			return child.children.map(pane => ({ ...pane, size: child.size * pane.size / total }));
		})
	};
}

function insertSplit(layout: TerminalEditorPaneLayout, source: URI, resource: URI, orientation: Orientation, before: boolean): TerminalEditorPaneLayout {
	if ('resource' in layout) {
		if (layout.resource.path !== source.path) return layout;
		const original = { ...layout, size: 0.5 };
		const added = { resource, size: 0.5 };
		return { orientation, size: layout.size, children: before ? [added, original] : [original, added] };
	}
	const index = layout.children.findIndex(child => 'resource' in child && child.resource.path === source.path);
	if (index >= 0 && layout.orientation === orientation) {
		const children = [...layout.children];
		const target = children[index]!;
		const size = target.size / 2;
		children[index] = { ...target, size };
		children.splice(before ? index : index + 1, 0, { resource, size });
		return { ...layout, children };
	}
	return { ...layout, children: layout.children.map(child => insertSplit(child, source, resource, orientation, before)) };
}

function adjacentPane(layout: TerminalEditorPaneLayout | undefined, resource: URI): URI | undefined {
	if (!layout || !('children' in layout)) return undefined;
	const index = layout.children.findIndex(child => 'resource' in child && child.resource.path === resource.path);
	if (index < 0) {
		for (const child of layout.children) {
			const adjacent = adjacentPane(child, resource);
			if (adjacent) return adjacent;
		}
		return undefined;
	}
	const next = layout.children[index + 1];
	return (next ? leaves(next)[0] : leaves(layout.children[index - 1]).at(-1))?.resource;
}

/** The editor owns a resource value; the terminal service retains the process and screen. */
export class TerminalEditorInput implements IResourceEditorInput {
	static readonly ID = 'workbench.editor.terminal';
	readonly typeId = TerminalEditorInput.ID;
	readonly editorId = TerminalEditorInput.ID;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	closeHandler: IEditorCloseHandler | undefined;
	private readonly layoutState;
	private readonly titleSource;
	readonly layout: IObservable<TerminalEditorPaneLayout | undefined>;
	readonly panes = derived(reader => leaves(this.layout.read(reader)));
	readonly onDidChangeLabel = Event.map(derived(reader => {
		const source = this.titleSource.read(reader);
		source.changed?.read(reader);
		return { title: source.instance?.title, icon: source.instance?.profile.icon };
	}).onDidChange, () => undefined);
	activeResource: URI | undefined;

	constructor(readonly resource: URI, terminalInstance?: ITerminalInstance, onDidChangeLabel?: Event<void>,
		layout: TerminalEditorPaneLayout = { resource, size: 1 },
	) {
		parseTerminalUri(resource);
		this.titleSource = observableValue('terminal editor title source', {
			instance: terminalInstance,
			changed: onDidChangeLabel && observableSignalFromEvent(this, onDidChangeLabel),
		});
		this.layoutState = observableValue<TerminalEditorPaneLayout | undefined>('terminal editor pane layout', layout);
		this.layout = this.layoutState;
	}

	get terminalInstance(): ITerminalInstance | undefined { return this.titleSource.get().instance; }

	/** Keep the editor identity when its saved pane resources have no process. */
	restoreShell(instance: ITerminalInstance, onDidChangeLabel: Event<void>): void {
		const resource = instance.resource;
		if (!resource) throw new TypeError('Terminal instance has no editor resource');
		this.activeResource = resource;
		transaction(tx => {
			this.layoutState.set({ resource, size: 1 }, tx);
			this.titleSource.set({ instance, changed: observableSignalFromEvent(this, onDidChangeLabel) }, tx);
		});
	}

	contains(resource: URI): boolean { return this.panes.get().some(pane => pane.resource.path === resource.path); }

	addPane(resource: URI, direction: Direction, source = this.activeResource, keep?: (resource: URI) => boolean): void {
		const layout = keep ? filterTerminalEditorLayout(this.layout.get(), keep) : this.layout.get();
		const panes = leaves(layout);
		const target = panes.find(pane => pane.resource.path === source?.path) ?? panes.at(-1);
		const orientation = direction === Direction.Left || direction === Direction.Right ? Orientation.HORIZONTAL : Orientation.VERTICAL;
		const before = direction === Direction.Up || direction === Direction.Left;
		this.layoutState.set(layout && target ? insertSplit(layout, target.resource, resource, orientation, before) : { resource, size: 1 }, undefined);
	}

	removePane(resource: URI): void {
		const layout = this.layout.get();
		if (this.activeResource?.path === resource.path) this.activeResource = adjacentPane(layout, resource);
		this.layoutState.set(filterTerminalEditorLayout(layout, candidate => candidate.path !== resource.path), undefined);
	}

	setPaneLayout(layout: TerminalEditorPaneLayout): void {
		this.layoutState.set(layout, undefined);
	}

	get label(): string { return this.terminalInstance?.title ?? (this.resource.fragment || terminalStrings.terminal); }
	getIcon(): ITerminalInstance['profile']['icon'] { return this.terminalInstance?.profile.icon; }
}
