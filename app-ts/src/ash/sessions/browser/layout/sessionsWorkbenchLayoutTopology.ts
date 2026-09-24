import { Dimension, type IDimension } from "../../../base/browser/dom.js";
import type { SerializedGridDescriptor } from "../../../base/browser/ui/grid/grid.js";
import type { WorkbenchPartView } from "../../../workbench/browser/workbenchPartView.js";
import type { SessionsPartId } from "../../services/layout/common/sessionsLayoutService.js";
import type { SessionsWorkbenchLayoutState } from "./sessionsWorkbenchLayoutState.js";

const SESSIONS_LAYOUT_PRIORITY = "high" as const;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;

export function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
): SerializedGridDescriptor {
	const leaf = (partId: SessionsPartId, size: number, visible = true, priority: "normal" | "high" = "normal"): SerializedGridDescriptor => ({
		type: "leaf",
		data: partId,
		size,
		visible,
		priority,
	});
	const titlebarHeight = requiredView(views, "titlebar").minimumHeight;
	const bodyHeight = Math.max(0, dimension.height - titlebarHeight);
	const sessionsWidth = Math.max(0, dimension.width - state.sidebar.width - (state.auxiliarybar.visible ? state.auxiliarybar.width : 0));
	return {
		type: "branch",
		orientation: "vertical",
		size: dimension.height,
		priority: "normal",
		children: [
			leaf("titlebar", titlebarHeight),
			{
				type: "branch",
				orientation: "horizontal",
				size: bodyHeight,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: [
					leaf("sidebar", state.sidebar.width),
					leaf("sessions", sessionsWidth, true, SESSIONS_LAYOUT_PRIORITY),
					leaf("auxiliarybar", state.auxiliarybar.width, state.auxiliarybar.visible),
				],
			},
		],
	};
}

export function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	return new Dimension(container.clientWidth > 0 ? container.clientWidth : DEFAULT_LAYOUT_WIDTH, container.clientHeight > 0 ? container.clientHeight : DEFAULT_LAYOUT_HEIGHT);
}

export function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === "titlebar" || value === "sidebar" || value === "sessions" || value === "auxiliarybar") return value;
	throw new TypeError("Sessions Grid contains an unknown Part");
}

export function requiredView(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	partId: SessionsPartId,
): WorkbenchPartView<SessionsPartId> {
	const view = views.get(partId);
	if (!view) throw new Error(`Sessions Part view is not registered: ${partId}`);
	return view;
}

export function assertDimension(dimension: IDimension): void {
	if (!Number.isFinite(dimension.width) || dimension.width < 0 || !Number.isFinite(dimension.height) || dimension.height < 0) {
		throw new RangeError("Sessions layout dimensions must be non-negative and finite");
	}
}
