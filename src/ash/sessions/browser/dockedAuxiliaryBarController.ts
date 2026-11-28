import type { IDimension } from '../../base/browser/dom.js';
import { Orientation, Sash, SashState, type IHorizontalSashLayoutProvider, type IVerticalSashLayoutProvider } from '../../base/browser/ui/sash/sash.js';
import { Disposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { Part } from '../../workbench/browser/part.js';
import { NoWorkbenchPartFrameInsets, type WorkbenchPartFrameInsets } from '../../workbench/browser/workbenchPartView.js';
import type { SessionsDetailsPosition } from '../common/configuration.js';

interface IDockedAuxiliaryBarHost {
	getTopInset(): number;
	setEditorContentInsets(insets: WorkbenchPartFrameInsets): void;
	setEditorContentVisible(visible: boolean): void;
	setSize(size: number, vertical: boolean): void;
	commitSize(size: number, vertical: boolean): void;
	resetSize(vertical: boolean): void;
}

interface DockedAuxiliaryBarLayout {
	readonly part: Part | undefined;
	readonly requestedSize: number | undefined;
	readonly minimumSize: number;
	readonly minimumEditorSize: number;
	readonly position: SessionsDetailsPosition;
	readonly editorVisible: boolean;
	readonly hideWhenConstrained?: boolean;
	readonly collapse?: () => void;
}

/** Positions a retained AuxiliaryBarPart below the editor group's header and owns its resize sashes. */
export class DockedAuxiliaryBarController extends Disposable {
	static readonly MIN_WIDTH = 220;
	private static readonly COLLAPSE_WIDTH = 4;
	private static readonly FLOATING_INSET = 8;
	private static readonly FLOATING_HEIGHT = 400;

	private readonly sideSash: Sash;
	private readonly horizontalSash: Sash;
	private width = 0;
	private top = 0;
	private left = 0;
	private height = 0;
	private topInset = 0;
	private position: SessionsDetailsPosition = 'right';
	private layingOut = false;
	private collapse: (() => void) | undefined;

	constructor(private readonly editor: HTMLElement, private readonly host: IDockedAuxiliaryBarHost) {
		super();
		this.sideSash = this.createSash(Orientation.VERTICAL, {
			getVerticalSashLeft: () => this.position === 'left' ? this.width : this.left,
			getVerticalSashTop: () => this.topInset,
			getVerticalSashHeight: () => this.height,
		});
		this.horizontalSash = this.createSash(Orientation.HORIZONTAL, {
			getHorizontalSashTop: () => this.position === 'top' ? this.top + this.height : this.top,
			getHorizontalSashWidth: () => this.width,
		});
	}

	private createSash(orientation: Orientation, provider: IVerticalSashLayoutProvider | IHorizontalSashLayoutProvider): Sash {
		const sash = this._register(new Sash(this.editor, provider, { orientation }));
		sash.element.classList.add('ash-editor-docked-auxiliarybar-sash');
		sash.state = SashState.Disabled;
		sash.element.hidden = true;
		const vertical = orientation === Orientation.HORIZONTAL;
		let startSize = 0;
		let collapsed = false;
		let startPosition = this.position;
		this._register(sash.onDidStart(() => {
			startSize = vertical ? this.height : this.width;
			startPosition = this.position;
			collapsed = false;
		}));
		this._register(sash.onDidChange(event => {
			if (collapsed || startPosition !== this.position) return;
			const delta = vertical ? event.currentY - event.startY : event.currentX - event.startX;
			const requestedSize = startSize + (startPosition === 'top' || startPosition === 'left' ? delta : -delta);
			if (this.collapse && requestedSize < DockedAuxiliaryBarController.COLLAPSE_WIDTH) {
				collapsed = true;
				this.collapse();
			} else {
				this.host.setSize(requestedSize, vertical);
			}
		}));
		this._register(sash.onDidEnd(() => {
			const size = vertical ? this.height : this.width;
			if (!collapsed && startPosition === this.position && !sash.element.hidden && size > 0) this.host.commitSize(size, vertical);
		}));
		this._register(sash.onDidReset(() => this.host.resetSize(vertical)));
		return sash;
	}

	public get size(): IDimension { return { width: this.width, height: this.height }; }

	public dock(part: Part, home: HTMLElement): IDisposable {
		const { domNode } = part;
		this.editor.append(domNode);
		return toDisposable(() => {
			domNode.classList.remove('ash-editor-docked-auxiliarybar');
			delete domNode.dataset.detailsPosition;
			for (const property of ['top', 'left', 'width', 'height']) domNode.style.removeProperty(property);
			home.append(domNode);
		});
	}

	public layout(dimension: IDimension, options: DockedAuxiliaryBarLayout): void {
		// Applying the content inset can synchronously cause another editor layout.
		if (this.layingOut) return;
		this.layingOut = true;
		try {
			const { part, requestedSize, editorVisible, minimumSize, minimumEditorSize, hideWhenConstrained, position } = options;
			this.collapse = options.collapse;
			this.position = position;
			const floating = editorVisible && position === 'floating';
			this.topInset = Math.min(this.host.getTopInset(), dimension.height);
			const bodyHeight = dimension.height - this.topInset;
			const vertical = position === 'top' || position === 'bottom';
			const bodySize = vertical ? bodyHeight : dimension.width;
			const gap = floating ? DockedAuxiliaryBarController.FLOATING_INSET : 0;
			const available = Math.max(0, bodySize - (floating ? 2 * gap : minimumEditorSize));
			let size = 0;
			if (part && requestedSize !== undefined) {
				if (!editorVisible) size = bodySize;
				else if (!hideWhenConstrained || available >= minimumSize) size = Math.min(Math.max(minimumSize, requestedSize), available);
			}
			this.width = vertical ? dimension.width : size;
			this.height = vertical ? size : bodyHeight;
			if (floating) this.height = Math.max(0, Math.min(DockedAuxiliaryBarController.FLOATING_HEIGHT, this.height - 2 * gap));
			this.left = position === 'right' || position === 'floating' ? dimension.width - this.width - gap : 0;
			this.top = position === 'bottom' ? dimension.height - this.height : this.topInset + gap;
			const visible = this.width > 0 && this.height > 0;
			const split = visible && editorVisible && position !== 'floating';
			if (part) {
				part.domNode.classList.add('ash-editor-docked-auxiliarybar');
				if (visible && editorVisible) part.domNode.dataset.detailsPosition = position;
				else delete part.domNode.dataset.detailsPosition;
				Object.assign(part.domNode.style, {
					top: `${this.top}px`, left: `${this.left}px`, width: `${this.width}px`, height: `${this.height}px`,
				});
				part.setVisible(visible);
				if (visible) part.layout(this.size);
			}
			this.host.setEditorContentInsets(split ? { ...NoWorkbenchPartFrameInsets, [position]: size } : NoWorkbenchPartFrameInsets);
			this.host.setEditorContentVisible(!visible || editorVisible);
			for (const [sash, enabled] of [[this.sideSash, split && !vertical], [this.horizontalSash, split && vertical]] as const) {
				sash.element.hidden = !enabled;
				sash.state = enabled ? SashState.Enabled : SashState.Disabled;
				if (enabled) {
					sash.element.dataset.detailsPosition = position;
					sash.layout();
				}
			}
		} finally {
			this.layingOut = false;
		}
	}
}
