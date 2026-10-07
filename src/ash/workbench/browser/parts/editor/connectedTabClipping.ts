/** Geometry used to keep the selected tab's connection visible while its row scrolls. */
export interface IConnectedTabBounds {
	readonly tab: HTMLElement;
	readonly overflowEdge: HTMLElement;
	readonly fillLeft: number;
	readonly fillRight: number;
	readonly viewportLeft: number;
	readonly viewportRight: number;
	readonly shoulderExtent: number;
}

const tabStateClasses = [
	"connected-tab-left-edge",
	"connected-tab-right-edge",
	"connected-tab-left-clipped",
	"connected-tab-right-clipped",
	"connected-tab-hidden",
];

export function clearConnectedTabClipping(tab: HTMLElement | undefined, overflowEdge: HTMLElement | undefined): void {
	if (tab) tab.classList.remove(...tabStateClasses);
	if (overflowEdge) {
		overflowEdge.classList.remove("connected-tab-left-clipped", "connected-tab-right-clipped");
	}
}

export function updateConnectedTabClipping(bounds: IConnectedTabBounds, scrollLeft: number): void {
	const visibleLeft = scrollLeft + bounds.viewportLeft;
	const visibleRight = scrollLeft + bounds.viewportRight;
	const leftClipped = bounds.fillLeft < visibleLeft;
	const rightClipped = bounds.fillRight > visibleRight;
	const hidden = bounds.fillRight <= visibleLeft || bounds.fillLeft >= visibleRight;
	bounds.tab.classList.toggle("connected-tab-left-edge", bounds.fillLeft - bounds.shoulderExtent < visibleLeft);
	bounds.tab.classList.toggle("connected-tab-right-edge", bounds.fillRight + bounds.shoulderExtent > visibleRight);
	bounds.tab.classList.toggle("connected-tab-left-clipped", leftClipped);
	bounds.tab.classList.toggle("connected-tab-right-clipped", rightClipped);
	bounds.tab.classList.toggle("connected-tab-hidden", hidden);
	bounds.overflowEdge.classList.toggle("connected-tab-left-clipped", leftClipped && !hidden);
	bounds.overflowEdge.classList.toggle("connected-tab-right-clipped", rightClipped && !hidden);
}
