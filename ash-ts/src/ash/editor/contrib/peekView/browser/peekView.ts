import "./media/peekViewWidget.css";
import { type Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { type IOptions, ZoneWidget } from "../../zoneWidget/browser/zoneWidget.js";

import { Emitter } from '../../../../base/common/event.js';

const DEFAULT_PEEK_HEIGHT_IN_LINES = 18;

/** A preview surface anchored in reserved editor space. */
export class PeekViewWidget extends ZoneWidget {
	private readonly closed = new Emitter<PeekViewWidget>();
	readonly onDidClose = this.closed.event;
	private heading: HTMLElement | undefined;
	private body: HTMLDivElement | undefined;

	constructor(editor: ICodeEditor, options: IOptions = {}) {
		super(editor, {
			className: "stanza-editor-peek-view",
			isAccessible: true,
			isResizeable: true,
			keepEditorSelection: true,
			...options,
		});
		this.create();
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') {
				stopEvent(event);
				this.dispose();
				editor.focus();
			}
		}));
	}

	public get element(): HTMLElement {
		return this.domNode;
	}

	public setTitle(primaryHeading: string, secondaryHeading?: string): void {
		this.heading!.textContent = secondaryHeading ? `${primaryHeading} - ${secondaryHeading}` : primaryHeading;
		this.heading!.title = this.heading!.textContent;
	}

	public override dispose(): void {
		if (this.isDisposed) return;
		super.dispose();
		this.closed.fire(this);
		this.closed.dispose();
	}

	public setBody(content: Node): void {
		this.body!.replaceChildren(content);
	}

	public override show(rangeOrPosition: Range | Position, heightInLines = DEFAULT_PEEK_HEIGHT_IN_LINES): void {
		super.show(rangeOrPosition, heightInLines);
	}

	protected override _fillContainer(container: HTMLElement): void {
		const header = h(container.ownerDocument, "header");
		header.className = "stanza-editor-peek-view-header";
		header.textContent = "Preview";
		this.heading = header;
		this.body = h(container.ownerDocument, "div");
		this.body.className = "stanza-editor-peek-view-body";
		container.append(header, this.body);
	}

	protected override _doLayout(_heightInPixels: number, _widthInPixels: number): void {}
}
