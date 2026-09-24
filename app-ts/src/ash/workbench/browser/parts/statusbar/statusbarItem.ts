import "./statusbarItem.css";
import { addDisposableListener, h, text as createText } from "../../../../base/browser/dom.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { getHoverDelegate, type IManagedHover } from "../../../../base/browser/ui/hover/hoverDelegate.js";
import { appendIcon } from "../../../../base/browser/ui/icon/icon.js";
import type { IStatusbarEntry, IStatusbarEntrySegment } from "../../../services/statusbar/browser/statusbar.js";

const StatusbarHoverGroupId = "statusbar";
type CompactHoverState = "none" | "group" | "entry";

/** Owns the DOM and interaction presentation for one status bar entry. */
export class StatusbarEntryItem extends Disposable {
	readonly id: string;
	readonly domNode: HTMLDivElement;
	private readonly labelDomNode: HTMLAnchorElement;
	private readonly hover = this._register(new MutableDisposable<IManagedHover>());
	private iconDomNode: SVGElement | undefined;
	private textNode: Text | undefined;
	private segmentDomNodes: HTMLElement[] = [];
	private entry: IStatusbarEntry | undefined;

	constructor(
		container: HTMLElement,
		id: string,
		entry: IStatusbarEntry,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.id = id;
		const domNode = h(ownerDocument, "div");
		domNode.className = "ash-statusbar-item";
		domNode.dataset.statusbarItemId = id;
		this.domNode = domNode;
		container.append(domNode);
		this._register(toDisposable(() => domNode.remove()));

		const labelDomNode = h(ownerDocument, "a");
		labelDomNode.className = "ash-statusbar-item-label";
		labelDomNode.setAttribute("role", "button");
		labelDomNode.tabIndex = -1;
		this.labelDomNode = labelDomNode;
		domNode.append(labelDomNode);

		this._register(addDisposableListener(labelDomNode, "click", (event) => {
			if (!this.isFocusable()) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			this.entry?.run?.();
		}));
		this._register(addDisposableListener(labelDomNode, "keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			if (!this.isFocusable()) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.entry?.run?.();
		}));

		this.update(entry);
	}

	/** Applies new content while retaining the item shell and its event handlers. */
	update(entry: IStatusbarEntry): void {
		const previousEntry = this.entry;
		this.entry = entry;
		const accessibleLabel = entry.ariaLabel || entry.text;
		const previousAccessibleLabel = previousEntry?.ariaLabel || previousEntry?.text;
		if (!previousEntry || previousAccessibleLabel !== accessibleLabel) {
			setOptionalAttribute(this.domNode, "aria-label", accessibleLabel);
			setOptionalAttribute(this.labelDomNode, "aria-label", accessibleLabel);
		}
		const focusable = this.isFocusable();
		const previouslyFocusable = previousEntry?.run !== undefined;
		if (!previousEntry || previouslyFocusable !== focusable) {
			this.labelDomNode.classList.toggle("disabled", !focusable);
			if (focusable) this.labelDomNode.removeAttribute("aria-disabled");
			else this.labelDomNode.setAttribute("aria-disabled", "true");
		}
		if (!previousEntry || previousEntry.kind !== entry.kind) {
			this.domNode.classList.toggle("remote-kind", entry.kind === "remote");
		}
		// The part is the single Tab stop. Items are focused by the part's
		// navigation commands, matching VS Code's composite statusbar behavior.
		this.labelDomNode.tabIndex = -1;

		this.updateContent(previousEntry, entry);

		if (!previousEntry || previousEntry.tooltip !== entry.tooltip) {
			this.hover.value = entry.tooltip
				? getHoverDelegate().setupHover({
					target: this.labelDomNode,
					content: entry.tooltip,
					groupId: StatusbarHoverGroupId,
				})
			: undefined;
		}
	}

	isFocusable(): boolean {
		return this.entry?.run !== undefined;
	}

	isFocused(): boolean {
		const activeElement = this.domNode.ownerDocument.activeElement;
		return activeElement !== null && this.domNode.contains(activeElement);
	}

	focus(): void {
		if (this.isFocusable()) this.labelDomNode.focus();
	}

	hideHover(): void {
		this.hover.value?.hide();
	}

	setCompactNeighbors(neighbors: { readonly left: boolean; readonly right: boolean }): void {
		this.domNode.classList.toggle("compact-left", neighbors.left);
		this.domNode.classList.toggle("compact-right", neighbors.right);
	}

	setCompactHoverState(state: CompactHoverState): void {
		this.domNode.classList.toggle("compact-group-hover", state !== "none");
		this.domNode.classList.toggle("compact-entry-hover", state === "entry");
	}

	private updateContent(previousEntry: IStatusbarEntry | undefined, entry: IStatusbarEntry): void {
		this.domNode.classList.toggle("icon-only", entry.icon !== undefined && !entry.text && entry.segments === undefined);
		this.labelDomNode.classList.toggle("has-segments", entry.segments !== undefined);
		if (entry.segments) {
			this.iconDomNode?.remove();
			this.iconDomNode = undefined;
			this.textNode?.remove();
			this.textNode = undefined;
			this.updateSegments(previousEntry?.segments, entry.segments);
			return;
		}

		this.clearSegments();
		this.updateIcon(previousEntry?.segments ? undefined : previousEntry?.icon?.id, entry.icon);
		this.updateText(previousEntry?.segments ? undefined : previousEntry?.text, entry.text);
	}

	private updateSegments(previousSegments: readonly IStatusbarEntrySegment[] | undefined, segments: readonly IStatusbarEntrySegment[]): void {
		if (segmentsEqual(previousSegments, segments)) return;
		this.clearSegments();
		for (const segment of segments) {
			const segmentElement = h(this.labelDomNode.ownerDocument, "span");
			segmentElement.className = "ash-statusbar-item-segment";
			if (segment.icon) appendIcon(segment.icon, segmentElement);
			if (segment.text) segmentElement.append(segment.text);
			this.labelDomNode.append(segmentElement);
			this.segmentDomNodes.push(segmentElement);
		}
	}

	private clearSegments(): void {
		for (const element of this.segmentDomNodes) element.remove();
		this.segmentDomNodes = [];
	}

	private updateIcon(previousIconId: string | undefined, icon: IStatusbarEntry["icon"]): void {
		if (previousIconId === icon?.id) return;
		this.iconDomNode?.remove();
		this.iconDomNode = undefined;
		if (!icon) return;

		const iconDomNode = appendIcon(icon, this.labelDomNode);
		if (this.textNode) this.labelDomNode.insertBefore(iconDomNode, this.textNode);
		this.iconDomNode = iconDomNode;
	}

	private updateText(previousText: string | undefined, text: string): void {
		if (previousText === text) return;
		if (!text) {
			this.textNode?.remove();
			this.textNode = undefined;
			return;
		}
		if (this.textNode) {
			this.textNode.data = text;
			return;
		}
		this.textNode = createText(this.labelDomNode.ownerDocument, text);
		this.labelDomNode.append(this.textNode);
	}
}

function segmentsEqual(first: readonly IStatusbarEntrySegment[] | undefined, second: readonly IStatusbarEntrySegment[]): boolean {
	return first?.length === second.length && first.every((segment, index) => segment.icon?.id === second[index]?.icon?.id && segment.text === second[index]?.text);
}

function setOptionalAttribute(
	element: HTMLElement,
	name: string,
	value: string,
): void {
	if (value) element.setAttribute(name, value);
	else element.removeAttribute(name);
}
