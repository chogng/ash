import { h } from '../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { diffRemoveIcon } from '../../registrations.contribution.js';
import { appendRemoveOnDispose } from '../../utils.js';

/** Owns one decorative deletion indicator per display line in an inline view zone. */
export class InlineDiffDeletedCodeMargin extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly markers: HTMLElement | undefined;

	constructor(document: Document, private readonly decorationsWidth: number, renderIndicators: boolean, lineHeight: number, displayLineCount: number) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-diff-inline-original-margin stanza-diff-gutter-removed';
		this.domNode.setAttribute('aria-hidden', 'true');
		if (!renderIndicators) return;
		// ViewZones controls the root's visibility; this child owns marker layout.
		const markers = this.markers = h(document, 'div');
		markers.className = 'ash-diff-inline-original-markers';
		markers.style.gridAutoRows = `${lineHeight}px`;
		this._register(appendRemoveOnDispose(this.domNode, markers));
		this.setDisplayLineCount(displayLineCount);
	}

	public setDisplayLineCount(displayLineCount: number): void {
		const markers = this.markers;
		if (!markers) return;
		while (markers.childElementCount > displayLineCount) markers.lastElementChild!.remove();
		while (markers.childElementCount < displayLineCount) {
			const marker = h(markers.ownerDocument, 'div');
			marker.className = 'stanza-diff-remove-sign';
			marker.style.width = `${this.decorationsWidth}px`;
			appendIcon(diffRemoveIcon, marker);
			markers.appendChild(marker);
		}
	}
}
