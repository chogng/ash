import './media/dockedAuxiliaryBar.css';
import { h, type IDimension } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { Sash } from '../../base/browser/ui/sash/sash.js';
import { localize } from '../../nls.js';
import type { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import type { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import type { AuxiliaryBarPart } from './parts/auxiliarybar/auxiliaryBarPart.js';

/** Geometry stays with the window layout; this host mounts Details below the shared editor tabs. */
export class DockedAuxiliaryBarController extends Disposable {
	private readonly dockDomNode: HTMLDivElement;
	private readonly sash: Sash;
	private readonly originalParent: HTMLElement;
	private dragWidth = 0;

	constructor(
		private readonly editor: EditorPart,
		private readonly details: WorkbenchPartView<string>,
		private readonly getWidth: () => number,
		private readonly setWidth: (width: number) => void,
	) {
		super();
		this.originalParent = details.frame.parentElement!;
		this.dockDomNode = h(editor.domNode.ownerDocument, 'div', { className: 'ash-sessions-docked-details' });
		editor.domNode.append(this.dockDomNode);
		this.sash = this._register(new Sash(editor.domNode, 'vertical'));
		this.sash.element.setAttribute('aria-label', localize('sessions.layout.resizeDetails', 'Resize details'));
		this._register(this.sash.onDidStart(() => { this.dragWidth = getWidth(); }));
		this._register(this.sash.onDidChange(event => setWidth(this.dragWidth - event.delta)));
		this._register(this.sash.onDidReset(() => setWidth(300)));
		this._register(toDisposable(() => {
			this.originalParent.append(details.frame);
			this.dockDomNode.remove();
		}));
	}

	public layout(dimension: IDimension, docked: boolean, editorVisible: boolean, detailsVisible: boolean): void {
		(this.details.part as AuxiliaryBarPart).setCompositeBarVisible(!docked);
		this.dockDomNode.hidden = !docked || !detailsVisible;
		this.sash.element.hidden = !docked || !editorVisible || !detailsVisible;
		if (!docked) {
			this.originalParent.append(this.details.frame);
			this.editor.setContentRightInset(0);
			this.editor.setEditorContentVisible(true);
			return;
		}
		this.dockDomNode.append(this.details.frame);
		this.details.setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		const maximumWidth = Math.max(0, dimension.width - (editorVisible ? this.editor.minimumWidth : 0));
		const width = detailsVisible ? Math.min(this.getWidth(), maximumWidth) : 0;
		const top = this.editor.getTabsHeight();
		const height = Math.max(0, dimension.height - top);
		this.dockDomNode.style.top = `${top}px`;
		this.dockDomNode.style.width = `${width}px`;
		this.sash.element.style.left = `${dimension.width - width}px`;
		this.sash.element.style.top = `${top}px`;
		this.sash.element.style.height = `${height}px`;
		this.sash.element.setAttribute('aria-valuenow', String(Math.round(width)));
		this.sash.element.setAttribute('aria-valuemin', String(this.details.minimumWidth));
		this.sash.element.setAttribute('aria-valuemax', String(Math.min(this.details.maximumWidth, maximumWidth)));
		this.editor.setContentRightInset(width);
		this.editor.setEditorContentVisible(editorVisible);
		this.details.frame.style.width = '100%';
		this.details.frame.style.height = '100%';
		this.details.setVisible(detailsVisible);
		if (detailsVisible) {
			this.details.layout({ left: 0, top: 0, width, height });
		}
	}
}
