import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import { Orientation } from '../../base/browser/ui/sash/sash.js';
import { validateSerializedGridViewDescriptor } from '../../base/browser/ui/grid/gridview.js';
import { h, type IDimension } from '../../base/browser/dom.js';
import { SerializableGrid, type Direction, type ISerializableView, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import type { SessionsPartId } from '../common/layoutConstants.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { AGENTS_FLOATING_PANEL_GAP } from '../common/sizes.js';
import { localize } from '../../nls.js';

export type CodeCardId = 'terminal' | 'files' | 'info';
export type CodeCardTarget = CodeCardId | 'sessions';

/** Card chrome consumes a retained content host, independently of the Workbench Part that supplies it. */
export interface ICodeCardPresentation {
	readonly title: string;
	readonly domNode: HTMLElement;
	readonly header: HTMLElement | undefined;
	layout(dimension: IDimension): void;
}

/** Window-local presentation of retained content. The desktop Grid owns topology and geometry. */
export interface ICodeCardLayout {
	readonly active: boolean;
	readonly onDidChangeCards: Event<void>;
	readonly information: CodeInformationView;
	readonly files: CodeFilesView;
	readonly expandedCard: CodeCardId | undefined;
	isCardVisible(id: CodeCardId): boolean;
	setInformation(element: HTMLElement | undefined): void;
	toggleInformation(): void;
	closeCard(id: CodeCardId): void;
	resizeCard(id: CodeCardId, widthDelta: number, heightDelta: number): void;
	moveCard(id: CodeCardId, target: CodeCardTarget, direction: Direction): void;
	expandCard(id: CodeCardId): void;
	detachCard(id: CodeCardId, detached: boolean): void;
}

const filesCardHeaderHeight = 36;
const filesCardBorderSize = 2;
const filesCardFrameSize = 2 * AGENTS_FLOATING_PANEL_GAP;

/** One movable Files card hosts the retained explorer and shared document editor Parts. */
export class CodeFilesView extends Disposable implements ISerializableView {
	public readonly element: HTMLElement;
	public readonly card: HTMLElement;
	public readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly gridHandle = this._register(new MutableDisposable<SerializableGrid<WorkbenchPartView<SessionsPartId>>>());
	private readonly gridChangeHandle = this._register(new MutableDisposable<IDisposable>());
	private readonly constraintsChanged = this._register(new Emitter<void>());
	public get onDidChange(): Event<void> {
		return Event.any(this.constraintsChanged.event, this.editor?.onDidChange ?? Event.None);
	}
	public get minimumWidth(): number {
		return Math.max(300, (this.editor?.minimumWidth ?? 0) + filesCardFrameSize + filesCardBorderSize);
	}
	public get minimumHeight(): number {
		return Math.max(240, (this.grid?.minimumHeight ?? 0) + filesCardFrameSize + filesCardBorderSize + filesCardHeaderHeight);
	}
	public readonly maximumWidth = Infinity;
	public readonly maximumHeight = Infinity;
	private treeWidth: number;
	private restoreTreeSize = true;
	private editor: WorkbenchPartView<SessionsPartId> | undefined;
	private tree: WorkbenchPartView<SessionsPartId> | undefined;
	public get grid(): SerializableGrid<WorkbenchPartView<SessionsPartId>> | undefined { return this.gridHandle.value; }

	constructor(document: Document, private readonly storage: IStorageService, private readonly isDetached: () => boolean) {
		super();
		const storedWidth = storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, 220);
		this.treeWidth = Number.isFinite(storedWidth) && storedWidth >= 160 && storedWidth <= 800 ? storedWidth : 220;
		this.element = h(document, 'div', { className: 'ash-workbench-part-frame ash-code-files-frame' });
		this.card = h(document, 'section', { className: 'ash-code-files-card ash-sessions-tool-card' });
		this.card.dataset.codeCard = 'files';
		this.card.setAttribute('role', 'region');
		this.card.setAttribute('aria-label', localize('sessions.files.title', 'Files'));
		this.header = h(document, 'header', { className: 'ash-code-card-header' });
		const title = h(document, 'span', { className: 'ash-code-card-title' });
		title.textContent = localize('sessions.files.title', 'Files');
		this.header.append(title);
		this.body = h(document, 'div', { className: 'ash-code-files-body' });
		this.card.append(this.header, this.body);
		this.element.append(this.card);
	}

	/** Only the Sessions composition mounts these Parts here; product pages keep their original hosts. */
	public mount(editor: WorkbenchPartView<SessionsPartId>, tree: WorkbenchPartView<SessionsPartId>): void {
		if (this.grid) { return; }
		this.editor = editor;
		this.tree = tree;
		this.createGrid();
	}

	public unmount(): void {
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		this.editor = undefined;
		this.tree = undefined;
	}

	private createGrid(): void {
		const editor = this.editor!;
		const tree = this.tree!;
		this.restoreTreeSize = true;
		const grid = SerializableGrid.deserialize(this.body, {
			type: 'branch', orientation: Orientation.HORIZONTAL, size: 1, priority: LayoutPriority.Normal, children: [
				{ type: 'leaf', data: 'auxiliarybar', visible: true, size: this.treeWidth, priority: LayoutPriority.Normal },
				{ type: 'leaf', data: 'editor', visible: true, size: 600, priority: LayoutPriority.High },
			],
		}, { fromJSON: id => id === 'editor' ? editor : tree });
		this.gridHandle.value = grid;
		this.gridChangeHandle.value = Event.any(grid.onDidSashChange, grid.onDidSashReset)(() => {
			this.rememberTreeWidth();
		});
	}

	public setVisible(visible: boolean): void {
		visible ||= this.isDetached();
		this.card.hidden = !visible;
		if (this.grid) {
			this.tree!.setVisible(visible);
			this.editor!.setVisible(visible && this.grid.isViewVisible(this.editor!));
		}
	}

	public layout(dimension: IDimension): void {
		if (this.isDetached()) { return; }
		this.layoutCard({
			width: Math.max(0, dimension.width - filesCardFrameSize),
			height: Math.max(0, dimension.height - filesCardFrameSize),
		});
	}

	public layoutCard(dimension: IDimension): void {
		if (!this.grid) { return; }
		// Stack the tree above the editor when a narrow card cannot fit both minimum widths.
		const orientation = dimension.width >= this.tree!.minimumWidth + this.editor!.minimumWidth ? Orientation.HORIZONTAL : Orientation.VERTICAL;
		const orientationChanged = orientation !== this.grid.orientation;
		if (orientationChanged) {
			this.grid.orientation = orientation;
			this.restoreTreeSize = true;
		}
		this.grid.layout(
			Math.max(0, dimension.width - filesCardBorderSize),
			Math.max(0, dimension.height - filesCardBorderSize - filesCardHeaderHeight),
		);
		if (this.grid.isViewVisible(this.editor!)) {
			const treeSize = this.grid.getViewSize(this.tree!);
			// Keep the user's width separate from temporary clamps while resizing the card.
			const width = orientation === Orientation.HORIZONTAL
				? Math.max(this.tree!.minimumWidth, Math.min(this.treeWidth, this.grid.width - this.editor!.minimumWidth))
				: treeSize.width;
			const height = orientation === Orientation.VERTICAL && this.restoreTreeSize ? 180 : treeSize.height;
			this.restoreTreeSize = false;
			if (width !== treeSize.width || height !== treeSize.height) {
				this.grid.resizeView(this.tree!, { width, height });
			}
		}
		if (orientationChanged) { this.constraintsChanged.fire(); }
	}

	/** Capture a user gesture or an explicit editor resize; ordinary layout must retain the preferred width. */
	public rememberTreeWidth(): void {
		if (this.grid && this.grid.orientation === Orientation.HORIZONTAL && this.grid.isViewVisible(this.editor!)) {
			this.treeWidth = this.grid.getViewSize(this.tree!).width;
			this.storage.store('sessions.code.filesTreeWidth', this.treeWidth, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	public toJSON(): string { return 'files'; }
}

/** A Grid leaf, not a second session model or a shared Workbench Part. */
export class CodeInformationView implements ISerializableView {
	readonly element: HTMLElement;
	readonly card: HTMLElement;
	readonly header: HTMLElement;
	readonly body: HTMLElement;
	readonly minimumWidth = 236;
	readonly minimumHeight = 140;
	readonly maximumWidth = Infinity;
	readonly maximumHeight = Infinity;
	constructor(document: Document) {
		this.element = h(document, 'div', { className: 'ash-workbench-part-frame' });
		this.element.style.padding = '4px';
		this.card = h(document, 'section', { className: 'ash-code-information-card ash-sessions-tool-card' });
		this.card.dataset.codeCard = 'info';
		this.header = h(document, 'header', { className: 'ash-code-card-header' });
		const title = h(document, 'span', { className: 'ash-code-card-title' });
		title.textContent = localize('sessions.cards.information', 'Session information');
		this.card.setAttribute('aria-label', title.textContent);
		this.header.append(title);
		this.body = h(document, 'div', { className: 'ash-code-information-body' });
		this.card.append(this.header, this.body);
		this.element.append(this.card);
	}
	layout(): void { }
	toJSON(): string {
		return 'info';
	}
}

/** Validate the persisted tree once, at the storage boundary, before attaching retained views. */
export function readCodeCardLayout(
	value: string | undefined,
	partIds: readonly string[],
): SerializedGridDescriptor | undefined {
	if (!value) return undefined;
	try {
		const tree = validateSerializedGridViewDescriptor(JSON.parse(value));
		const ids = new Set<string>();
		let nodes = 0;
		const visit = (node: unknown): boolean => {
			if (++nodes > 40 || !node || typeof node !== 'object') return false;
			const item = node as Record<string, unknown>;
			if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0 || item.size > 100000)
				return false;
			if (item.priority !== LayoutPriority.High && item.priority !== LayoutPriority.Normal) return false;
			if (item.type === 'branch')
				return (
					(item.orientation === Orientation.VERTICAL || item.orientation === Orientation.HORIZONTAL) &&
					Array.isArray(item.children) &&
					item.children.length > 0 &&
					item.children.every(visit)
				);
			if (
				item.type !== 'leaf' ||
				typeof item.data !== 'string' ||
				typeof item.visible !== 'boolean' ||
				ids.has(item.data) ||
				!partIds.includes(item.data)
			)
				return false;
			ids.add(item.data);
			return true;
		};
		if (!visit(tree) || ids.size !== partIds.length) return undefined;
		return tree;
	} catch {
		return undefined;
	}
}
