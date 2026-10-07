import type { FastDomNode } from '../../fastDomNode.js';
import { AbstractDisposable } from '../../../common/lifecycle.js';
import { ScrollbarVisibility } from '../../../common/scrollable.js';

/** Combines axis availability, the configured policy, and interaction intent. */
export class ScrollbarVisibilityController extends AbstractDisposable {
	private domNode: FastDomNode<HTMLElement> | undefined;
	private needed = false;
	private shouldBeVisible = false;

	constructor(
		private visibility: ScrollbarVisibility,
		private readonly visibleClassName: string,
		private readonly invisibleClassName: string,
	) { super(); }

	public setDomNode(domNode: FastDomNode<HTMLElement>): void {
		this.domNode = domNode;
		this.ensureVisibility();
	}

	public setVisibility(visibility: ScrollbarVisibility): void {
		this.visibility = visibility;
		this.ensureVisibility();
	}

	public setIsNeeded(needed: boolean): void {
		this.needed = needed;
		this.ensureVisibility();
	}

	public setShouldBeVisible(shouldBeVisible: boolean): void {
		this.shouldBeVisible = shouldBeVisible;
		this.ensureVisibility();
	}

	public ensureVisibility(): void {
		if (!this.domNode) return;
		const hidden = !this.needed || this.visibility === ScrollbarVisibility.Hidden;
		const visible = !hidden && (this.visibility === ScrollbarVisibility.Visible || this.shouldBeVisible);
		this.domNode.domNode.hidden = hidden;
		this.domNode.domNode.dataset.visibility = visible ? 'visible' : 'auto';
		this.domNode.toggleClassName(this.visibleClassName, visible);
		this.domNode.toggleClassName(this.invisibleClassName, !visible);
	}

	protected override disposeCore(): void {
		this.domNode = undefined;
	}
}
