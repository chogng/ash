import { Dimension, h, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { Orientation, SplitView, type IView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { decideStackedChatInputOnly, stackedChatExpandedSize } from '../common/chatWindowInputOnly.js';
import { ChatWindowLayoutMode, ChatWindowTerminalPosition, type ChatWindowEdge } from '../common/chatWindowLayout.js';

interface LayoutCell {
	readonly element: HTMLElement;
	readonly minimumWidth: number;
	readonly minimumHeight: number;
	readonly onDidChange?: Event<number | undefined>;
	layout(dimension: IDimension): void;
}

interface EdgeCell {
	readonly edge: ChatWindowEdge;
	readonly cell: LayoutCell;
	size: number;
}

/** Owns window geometry while the existing Parts retain their editor groups and focus. */
export class ChatWindowGrid extends Disposable {
	readonly element: HTMLElement;
	private readonly topology = this._register(new DisposableStore());
	private readonly composerObserver = this._register(new MutableDisposable());
	private readonly composerChanged = this._register(new Emitter<number | undefined>());
	private readonly edges = new Map<IEditorPart, EdgeCell>();
	private readonly layoutChanged = this._register(new Emitter<void>());
	readonly onDidChangeLayout = this.layoutChanged.event;

	private root!: LayoutCell;
	private body!: SplitView;
	private terminalSplit!: SplitView;
	private dimension = new Dimension(0, 0);
	private stacked = false;
	private mainVisible = false;
	private terminalsVisible = false;
	private _terminalPosition = ChatWindowTerminalPosition.FullWidth;
	private _inputOnly = false;
	private composerHeight = 0;
	private expandedHeight = 0;

	constructor(container: HTMLElement, private readonly chat: IEditorPart, private readonly main: IEditorPart, private readonly terminal: IEditorPart) {
		super();
		this.element = h(container.ownerDocument, 'div', { className: 'ash-chat-window-grid' });
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.rebuild();
	}

	get mode(): ChatWindowLayoutMode { return this.stacked ? ChatWindowLayoutMode.Stacked : ChatWindowLayoutMode.SideBySide; }
	get terminalPosition(): ChatWindowTerminalPosition { return this._terminalPosition; }
	get inputOnly(): boolean { return this._inputOnly; }
	get canToggleConversation(): boolean { return this.stacked && this.mainVisible && this.composerHeight > 0; }
	private get mainIndex(): number { return this.stacked ? 0 : 1; }
	private get chatIndex(): number { return 1 - this.mainIndex; }
	private get collapsedHeight(): number { return Math.max(119, this.composerHeight); }
	get sizes(): { readonly main: number; readonly terminals: number; } {
		return { main: this.body.getViewLayoutSize(this.mainIndex), terminals: this.terminalSplit.getViewLayoutSize(1) };
	}

	setLayoutMode(mode: ChatWindowLayoutMode): void {
		if (this.mode === mode) return;
		this.stacked = mode === ChatWindowLayoutMode.Stacked;
		this.rebuild();
		this.layoutChanged.fire();
	}

	setTerminalPosition(position: ChatWindowTerminalPosition): void {
		if (this.terminalPosition === position) return;
		const sizes = this.sizes;
		this._terminalPosition = position;
		this.rebuild(sizes);
		this.layoutChanged.fire();
	}

	toggleConversation(): void {
		if (this.canToggleConversation) this.setInputOnly(!this.inputOnly);
	}

	setInputOnly(inputOnly: boolean): void {
		if (this.inputOnly === inputOnly) return;
		if (this.canToggleConversation && inputOnly) this.expandedHeight = this.body.getViewLayoutSize(this.chatIndex);
		this._inputOnly = inputOnly;
		this.updateConversation();
		if (this.canToggleConversation) {
			const size = inputOnly ? this.collapsedHeight : stackedChatExpandedSize(this.collapsedHeight, this.expandedHeight);
			this.body.resizeView(this.chatIndex, size);
		}
		this.layoutChanged.fire();
	}

	observeComposer(): void {
		this.composerObserver.clear();
		const input = this.chat.domNode.querySelector<HTMLElement>('.ash-chat-window-editor:not([hidden]) .ash-chat:not([hidden]) > .ash-chat-input-part');
		const measure = () => {
			const chrome = this.chat.domNode.offsetHeight - (input?.closest<HTMLElement>('.ash-chat-window-editor')?.offsetHeight ?? 0);
			const height = input?.offsetHeight ? input.offsetHeight + Math.max(0, chrome) : 0;
			if (this.composerHeight === height) return;
			this.composerHeight = height;
			this.composerChanged.fire(undefined);
			this.updateConversation();
			this.fitComposer();
			this.layoutChanged.fire();
		};
		measure();
		if (input) this.composerObserver.value = observeElementSize(input, measure);
	}

	addEdgePart(part: IEditorPart, edge: ChatWindowEdge, size: number): void {
		this.edges.set(part, { edge, cell: this.partCell(part), size });
		this.rebuild(this.sizes);
	}

	removeEdgePart(part: IEditorPart): void {
		if (this.edges.delete(part)) this.rebuild(this.sizes);
	}

	getEdgePartSize(part: IEditorPart): number { return this.edges.get(part)!.size; }

	showMain(): void { this.setMainVisible(true); }
	hideMain(): void { this.setMainVisible(false); }

	private setMainVisible(visible: boolean): void {
		if (this.mainVisible === visible) return;
		const sizes = this.sizes;
		this.mainVisible = visible;
		this.rebuild({ ...sizes, main: 0 });
		this.layoutChanged.fire();
	}

	setTerminalsVisible(visible: boolean): void {
		if (this.terminalsVisible === visible) return;
		this.terminalsVisible = visible;
		this.terminalSplit.setViewVisible(1, visible);
		this.fitComposer();
	}

	restoreSizes(sizes: { readonly main: number; readonly terminals: number; }): void {
		if (this.mainVisible && sizes.main > 0) this.body.resizeView(this.mainIndex, sizes.main);
		if (this.terminalsVisible && sizes.terminals > 0) this.terminalSplit.resizeView(1, sizes.terminals);
		this.fitComposer();
	}

	layout(dimension: IDimension): void {
		this.dimension = new Dimension(dimension.width, dimension.height);
		this.root.layout(dimension);
		this.fitComposer();
	}

	private updateConversation(): void {
		this.element.classList.toggle('input-only', this.canToggleConversation && this.inputOnly);
	}

	private fitComposer(): void {
		if (this.canToggleConversation && this.inputOnly && this.body.getViewLayoutSize(this.chatIndex) !== this.collapsedHeight) {
			this.body.resizeView(this.chatIndex, this.collapsedHeight);
		}
	}

	private partCell(part: IEditorPart): LayoutCell {
		return { element: part.domNode, minimumWidth: 120, minimumHeight: 119, layout: size => part.layout(size) };
	}

	private rebuild(sizes?: { readonly main: number; readonly terminals: number; }): void {
		const focused = this.element.ownerDocument.activeElement;
		const restoreFocus = isHTMLElement(focused) && this.element.contains(focused);
		this.topology.clear();
		this.element.replaceChildren();
		const chat = this.partCell(this.chat);
		const main = this.partCell(this.main);
		const terminal = { ...this.partCell(this.terminal), minimumHeight: 100 };
		const dock = !this.stacked && this.mainVisible ? this.terminalPosition : ChatWindowTerminalPosition.FullWidth;
		const terminalBelow = (cell: LayoutCell) => {
			const branch = this.branch(Orientation.VERTICAL, cell, terminal, 'ash-chat-window-terminal-split');
			this.terminalSplit = branch.split;
			branch.split.setViewVisible(1, this.terminalsVisible);
			branch.split.resizeView(1, sizes?.terminals || 180);
			return branch.cell;
		};
		const chatCell = dock === ChatWindowTerminalPosition.UnderChat ? terminalBelow(chat) : chat;
		const mainCell = dock === ChatWindowTerminalPosition.UnderEditor ? terminalBelow(main) : main;
		const grid = this;
		const stackedChat: LayoutCell = {
			...chat,
			get minimumHeight() { return grid.collapsedHeight; },
			onDidChange: this.composerChanged.event,
		};
		const body = this.stacked
			? this.branch(Orientation.VERTICAL, mainCell, stackedChat, 'ash-chat-window-body')
			: this.branch(Orientation.HORIZONTAL, chatCell, mainCell, 'ash-chat-window-body');
		this.body = body.split;
		this.body.setViewVisible(this.mainIndex, this.mainVisible);
		if (this.stacked) {
			this.body.getSash(0)?.element.setAttribute('aria-label',
				localize({ bundle: 'ash.workbench', key: 'chatWindow.conversationSash' }, 'Resize Chat Conversation'));
			this.topology.add(this.body.onDidSashChange(() => {
				if (!this.canToggleConversation) return;
				const size = this.body.getViewLayoutSize(this.chatIndex);
				this.setInputOnly(decideStackedChatInputOnly(size, this.collapsedHeight, this.inputOnly));
				this.fitComposer();
			}));
			this.topology.add(this.body.onDidSashReset(() => this.toggleConversation()));
		}
		let root = dock === ChatWindowTerminalPosition.FullWidth ? terminalBelow(body.cell) : body.cell;
		const edgeLayouts: { readonly split: SplitView; readonly index: number; readonly entry: EdgeCell; }[] = [];
		for (const entry of this.edges.values()) {
			const leading = entry.edge === 'left' || entry.edge === 'top';
			const orientation = entry.edge === 'left' || entry.edge === 'right' ? Orientation.HORIZONTAL : Orientation.VERTICAL;
			const branch = this.branch(orientation, leading ? entry.cell : root, leading ? root : entry.cell, 'ash-chat-window-edge-split');
			const index = leading ? 0 : 1;
			this.topology.add(branch.split.onDidSashChange(() => { entry.size = branch.split.getViewLayoutSize(index); }));
			edgeLayouts.unshift({ split: branch.split, index, entry });
			root = branch.cell;
		}
		this.root = root;
		this.element.append(root.element);
		this.updateConversation();
		this.layout(this.dimension);
		for (const { split, index, entry } of edgeLayouts) split.resizeView(index, entry.size);
		if (this.mainVisible && !sizes?.main) this.body.distributeViewSizes();
		this.restoreSizes(sizes ?? { main: 0, terminals: 180 });
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}

	private branch(orientation: Orientation, leading: LayoutCell, trailing: LayoutCell, className: string) {
		const horizontal = orientation === Orientation.HORIZONTAL;
		const element = h(this.element.ownerDocument, 'div', { className });
		const split = this.topology.add(new SplitView(element, { orientation, styles: { separatorBorder: 'var(--ash-border)' } }));
		for (const cell of [leading, trailing]) {
			const view: IView = {
				element: cell.element,
				get minimumSize() { return horizontal ? cell.minimumWidth : cell.minimumHeight; },
				maximumSize: Infinity,
				onDidChange: cell.onDidChange ?? Event.None,
				layout: (size, _offset, cross) => cell.layout(horizontal ? new Dimension(size, cross) : new Dimension(cross, size)),
			};
			split.addView(view, { type: 'distribute' });
		}
		const cell = {
			element,
			get minimumWidth() { return horizontal ? split.minimumSize : Math.max(leading.minimumWidth, trailing.minimumWidth); },
			get minimumHeight() { return horizontal ? Math.max(leading.minimumHeight, trailing.minimumHeight) : split.minimumSize; },
			layout: ({ width, height }: IDimension) => split.layout(horizontal ? width : height, horizontal ? height : width),
		};
		return { split, cell };
	}
}
