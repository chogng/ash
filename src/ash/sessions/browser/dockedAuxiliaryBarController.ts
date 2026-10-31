import { Dimension, h, type IDimension } from '../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../base/browser/ui/sash/sash.js';
import type { ISerializableView } from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import type { SessionsPartId } from '../common/layoutConstants.js';
import { AGENTS_FLOATING_PANEL_GAP } from '../common/sizes.js';

/** The editor owns its groups; docking only reserves their content area below the title. */
export interface IDockedEditorLayout {
	readonly domNode: HTMLElement;
	readonly minimumWidth: number;
	readonly minimumHeight: number;
	readonly onDidChangeConstraints: Event<void>;
	getTabsHeight(): number;
	setContentRightInset(width: number): void;
	setEditorContentVisible(visible: boolean): void;
	layoutEditor(dimension: IDimension): void;
	setVisible(visible: boolean): void;
}

/** Retains the auxiliary bar inside its editor without relocating group titles or actions. */
export class DockedAuxiliaryBarController extends Disposable implements ISerializableView {
	public readonly element: HTMLElement;
	public readonly card: HTMLElement;
	public readonly header: HTMLElement;
	public readonly maximumWidth = Infinity;
	public readonly maximumHeight = Infinity;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange: Event<void>;
	private readonly sash: Sash;
	private auxiliary: WorkbenchPartView<SessionsPartId> | undefined;
	private editorFrame: HTMLElement | undefined;
	private isDetached: () => boolean = () => false;
	private dimension: IDimension = Dimension.Zero;
	private preferredTreeWidth: number;
	private treeWidth = 0;
	private dragWidth = 0;
	private visible = true;
	public editorVisible = false;
	public auxiliaryBarVisible = true;

	constructor(
		private readonly editor: IDockedEditorLayout,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.card = this.header = editor.domNode;
		this.element = h(editor.domNode.ownerDocument, 'div', { className: 'ash-workbench-part-frame ash-desktop-editor-frame' });
		const width = storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, 220);
		this.preferredTreeWidth = Number.isFinite(width) && width >= 160 && width <= 800 ? width : 220;
		this.onDidChange = Event.any(this.changed.event, editor.onDidChangeConstraints);
		this.sash = this._register(new Sash(editor.domNode, {
			getVerticalSashLeft: () => this.dimension.width - this.treeWidth,
			getVerticalSashTop: () => editor.getTabsHeight(),
			getVerticalSashHeight: () => Math.max(0, this.dimension.height - editor.getTabsHeight()),
		}, { orientation: Orientation.VERTICAL }));
		this.sash.state = SashState.Disabled;
		this._register(this.sash.onDidStart(() => { this.dragWidth = this.treeWidth; }));
		this._register(this.sash.onDidChange(event => {
			this.preferredTreeWidth = this.dragWidth + event.startX - event.currentX;
			this.layoutCard(this.dimension);
			this.preferredTreeWidth = this.treeWidth;
		}));
		this._register(this.sash.onDidEnd(() => this.rememberTreeWidth()));
		this._register(this.sash.onDidReset(() => {
			this.preferredTreeWidth = 220;
			this.layoutCard(this.dimension);
			this.rememberTreeWidth();
		}));
	}

	public get isMounted(): boolean { return !!this.auxiliary; }
	public get minimumWidth(): number {
		return Math.max(300, (this.editorVisible ? this.editor.minimumWidth : 0) + (this.auxiliaryBarVisible ? (this.auxiliary?.minimumWidth ?? 180) : 0) + 2 * AGENTS_FLOATING_PANEL_GAP);
	}
	public get minimumHeight(): number { return Math.max(240, this.editor.minimumHeight); }
	public get editorSize(): IDimension {
		return new Dimension(Math.max(0, this.dimension.width - this.treeWidth), this.dimension.height);
	}

	public mount(editorFrame: HTMLElement, auxiliary: WorkbenchPartView<SessionsPartId>, editorVisible: boolean, isDetached: () => boolean): void {
		if (this.isMounted) { return; }
		this.editorFrame = editorFrame;
		this.auxiliary = auxiliary;
		this.isDetached = isDetached;
		this.editorVisible = editorVisible;
		this.element.append(this.card);
		this.card.append(auxiliary.part.domNode);
		this.card.classList.add('ash-desktop-editor-docked');
		auxiliary.part.domNode.classList.add('ash-desktop-editor-auxiliary');
	}

	public unmount(): void {
		if (!this.auxiliary) { return; }
		this.auxiliary.part.domNode.classList.remove('ash-desktop-editor-auxiliary');
		for (const property of ['top', 'right', 'width', 'height']) {
			this.auxiliary.part.domNode.style.removeProperty(property);
		}
		this.auxiliary.frame.append(this.auxiliary.part.domNode);
		this.editorFrame!.append(this.card);
		this.card.classList.remove('ash-desktop-editor-docked');
		this.sash.state = SashState.Disabled;
		this.auxiliary = undefined;
		this.editor.setContentRightInset(0);
		this.editor.setEditorContentVisible(true);
	}

	public setEditorVisible(visible: boolean): void {
		if (this.editorVisible === visible) { return; }
		this.editorVisible = visible;
		this.layoutCard(this.dimension);
		this.changed.fire();
	}

	public setAuxiliaryBarVisible(visible: boolean): void {
		if (this.auxiliaryBarVisible === visible) { return; }
		this.auxiliaryBarVisible = visible;
		this.auxiliary?.part.setVisible(this.visible && visible);
		this.layoutCard(this.dimension);
		this.changed.fire();
	}

	public setVisible(visible: boolean): void {
		this.visible = visible || this.isDetached();
		this.editor.setVisible(this.visible);
		this.editor.setEditorContentVisible(this.visible && this.editorVisible);
		this.auxiliary?.part.setVisible(this.visible && this.auxiliaryBarVisible);
	}

	public layout(dimension: IDimension): void {
		if (this.isDetached()) { return; }
		this.layoutCard(new Dimension(Math.max(0, dimension.width - 2 * AGENTS_FLOATING_PANEL_GAP), Math.max(0, dimension.height - 2 * AGENTS_FLOATING_PANEL_GAP)));
	}

	public layoutCard(dimension: IDimension): void {
		if (!this.auxiliary) { return; }
		this.dimension = dimension;
		const available = Math.max(0, dimension.width - 2);
		if (!this.auxiliaryBarVisible) { this.treeWidth = 0; }
		else if (this.editorVisible) {
			this.treeWidth = Math.max(this.auxiliary.minimumWidth, Math.min(this.preferredTreeWidth, available - this.editor.minimumWidth));
		} else { this.treeWidth = available; }
		this.editor.setContentRightInset(this.treeWidth);
		this.editor.layoutEditor(new Dimension(available, Math.max(0, dimension.height - 2)));
		this.editor.setEditorContentVisible(this.visible && this.editorVisible);
		this.layoutAuxiliaryBar();
	}

	public layoutAuxiliaryBar(): void {
		if (!this.auxiliary) { return; }
		const top = this.editor.getTabsHeight();
		const height = Math.max(0, this.dimension.height - top - 2);
		Object.assign(this.auxiliary.part.domNode.style, { top: `${top}px`, right: '0px', width: `${this.treeWidth}px`, height: `${height}px` });
		this.auxiliary.part.layout(new Dimension(this.treeWidth, height));
		this.sash.state = this.editorVisible && this.auxiliaryBarVisible ? SashState.Enabled : SashState.Disabled;
		if (this.editorVisible && this.auxiliaryBarVisible) {
			this.sash.element.setAttribute('aria-valuemin', String(this.editor.minimumWidth));
			this.sash.element.setAttribute('aria-valuemax', String(this.dimension.width - this.auxiliary.minimumWidth));
			this.sash.element.setAttribute('aria-valuenow', String(this.editorSize.width));
		}
		this.sash.layout();
	}

	public resizeEditor(dimension: IDimension): void {
		if (!this.auxiliaryBarVisible) { return; }
		this.preferredTreeWidth = Math.max(0, this.dimension.width - dimension.width);
		this.layoutCard(this.dimension);
		this.rememberTreeWidth();
	}

	public rememberTreeWidth(): void {
		if (!this.editorVisible || !this.auxiliaryBarVisible) { return; }
		this.preferredTreeWidth = this.treeWidth;
		this.storage.store('sessions.code.filesTreeWidth', this.preferredTreeWidth, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	public toJSON(): string { return 'files'; }
}
