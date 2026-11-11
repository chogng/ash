import type { IDimension } from '../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../base/browser/ui/sash/sash.js';
import { Disposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { Part } from '../../workbench/browser/part.js';

interface IDockedAuxiliaryBarHost {
	getTabsHeight(): number;
	setEditorContentRightInset(width: number): void;
	setEditorContentVisible(visible: boolean): void;
	setWidth(width: number): void;
	commitWidth(width: number): void;
	resetWidth(): void;
}

interface DockedAuxiliaryBarLayout {
	readonly part: Part | undefined;
	readonly requestedWidth: number | undefined;
	readonly minimumWidth: number;
	readonly minimumEditorWidth: number;
	readonly editorVisible: boolean;
	readonly hideWhenConstrained?: boolean;
	readonly collapse?: () => void;
}

/** Positions a retained AuxiliaryBarPart below the editor tabs and owns its resize sash. */
export class DockedAuxiliaryBarController extends Disposable {
	static readonly MIN_WIDTH = 220;
	private static readonly COLLAPSE_WIDTH = 4;

	private readonly sash: Sash;
	private width = 0;
	private editorWidth = 0;
	private top = 0;
	private height = 0;
	private layingOut = false;
	private collapse: (() => void) | undefined;

	constructor(private readonly editor: HTMLElement, private readonly host: IDockedAuxiliaryBarHost) {
		super();
		this.sash = this._register(new Sash(editor, {
			getVerticalSashLeft: () => this.editorWidth - this.width,
			getVerticalSashTop: () => this.top,
			getVerticalSashHeight: () => this.height,
		}, { orientation: Orientation.VERTICAL }));
		this.sash.state = SashState.Disabled;
		let startWidth = 0;
		let collapsed = false;
		this._register(this.sash.onDidStart(() => {
			startWidth = this.width;
			collapsed = false;
		}));
		this._register(this.sash.onDidChange(event => {
			if (collapsed) return;
			const requestedWidth = startWidth + event.startX - event.currentX;
			if (this.collapse && requestedWidth < DockedAuxiliaryBarController.COLLAPSE_WIDTH) {
				collapsed = true;
				this.collapse();
			} else {
				this.host.setWidth(requestedWidth);
			}
		}));
		this._register(this.sash.onDidEnd(() => {
			if (!collapsed && this.width > 0) this.host.commitWidth(this.width);
		}));
		this._register(this.sash.onDidReset(() => this.host.resetWidth()));
	}

	public get size(): IDimension { return { width: this.width, height: this.height }; }

	public dock(part: Part, home: HTMLElement): IDisposable {
		const { domNode } = part;
		domNode.classList.add('ash-editor-docked-auxiliarybar');
		this.editor.append(domNode);
		return toDisposable(() => {
			domNode.classList.remove('ash-editor-docked-auxiliarybar');
			for (const property of ['top', 'right', 'width', 'height']) domNode.style.removeProperty(property);
			home.append(domNode);
		});
	}

	public layout(dimension: IDimension, options: DockedAuxiliaryBarLayout): void {
		// Applying the content inset can synchronously cause another editor layout.
		if (this.layingOut) return;
		this.layingOut = true;
		try {
			const { part, requestedWidth, editorVisible, minimumWidth, minimumEditorWidth, hideWhenConstrained } = options;
			this.collapse = options.collapse;
			this.editorWidth = dimension.width;
			this.top = this.host.getTabsHeight();
			this.height = Math.max(0, dimension.height - this.top);
			const available = Math.max(0, dimension.width - minimumEditorWidth);
			this.width = 0;
			if (part && requestedWidth !== undefined) {
				if (!editorVisible) this.width = dimension.width;
				else if (!hideWhenConstrained || available >= minimumWidth) {
					this.width = Math.min(Math.max(minimumWidth, requestedWidth), available);
				}
			}
			const visible = this.width > 0;
			if (part) {
				Object.assign(part.domNode.style, {
					top: `${this.top}px`, right: '0px', width: `${this.width}px`, height: `${this.height}px`,
				});
				part.setVisible(visible);
				if (visible) part.layout(this.size);
			}
			this.host.setEditorContentRightInset(this.width);
			this.host.setEditorContentVisible(!visible || editorVisible);
			this.sash.state = visible && editorVisible ? SashState.Enabled : SashState.Disabled;
			this.sash.layout();
		} finally {
			this.layingOut = false;
		}
	}
}
