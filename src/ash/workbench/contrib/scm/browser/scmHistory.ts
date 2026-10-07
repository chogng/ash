import { svg as createSvgElement } from "../../../../base/browser/dom.js";
import { findLastIdx } from "../../../../base/common/arraysFind.js";
import type { ISCMHistoryItem, ISCMHistoryItemRef, ISCMHistoryItemViewModel } from '../common/history.js';

const LaneHeight = 22;
const LaneWidth = 11;
const CurveRadius = 5;
const ColorCount = 8;

interface Lane {
	readonly id: string;
	readonly colorIndex: number;
}

interface GraphRow {
	readonly historyItem: ISCMHistoryItem;
	readonly inputSwimlanes: readonly Lane[];
	readonly outputSwimlanes: readonly Lane[];
}

type GraphNodeKind = "commit" | "head" | "merge";

export const SWIMLANE_HEIGHT = LaneHeight;
export const SWIMLANE_WIDTH = LaneWidth;

/** Projects ordered SCM history into stable, color-carrying swimlanes. */
export function toISCMHistoryItemViewModelArray(historyItems: readonly ISCMHistoryItem[], colorMap = new Map<string, number>(), currentHistoryItemRef?: ISCMHistoryItemRef): ISCMHistoryItemViewModel[] {
	const rows = createRows(historyItems, colorMap);
	return rows.map(row => ({
		historyItem: row.historyItem,
		inputSwimlanes: row.inputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		outputSwimlanes: row.outputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		kind: row.historyItem.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node',
	}));
}

function createRows(historyItems: readonly ISCMHistoryItem[], colorMap: ReadonlyMap<string, number>): GraphRow[] {
	const rows: GraphRow[] = [];
	const historyById = new Map(historyItems.map(item => [item.id, item]));
	let lanes: readonly Lane[] = [];
	let nextColorIndex = 0;
	const referenceColor = (item: ISCMHistoryItem): number | undefined => {
		for (const reference of item.references ?? []) {
			const color = colorMap.get(reference.id) ?? reference.color;
			if (color !== undefined) return color;
		}
		return undefined;
	};
	const allocateColor = (): number => {
		const colorIndex = nextColorIndex;
		nextColorIndex = (nextColorIndex + 1) % ColorCount;
		return colorIndex;
	};

	for (const historyItem of historyItems) {
		const inputSwimlanes = lanes.map((lane) => ({ ...lane }));
		const outputSwimlanes: Lane[] = [];
		let firstParentAdded = false;

		for (const lane of inputSwimlanes) {
			if (lane.id === historyItem.id) {
				if (!firstParentAdded && historyItem.parentIds.length > 0) {
					outputSwimlanes.push({ id: historyItem.parentIds[0], colorIndex: referenceColor(historyItem) ?? lane.colorIndex });
					firstParentAdded = true;
				}
				continue;
			}
			outputSwimlanes.push({ ...lane });
		}

		for (let index = firstParentAdded ? 1 : 0; index < historyItem.parentIds.length; index += 1) {
			const parent = historyById.get(historyItem.parentIds[index]);
			const colorIndex = index === 0 ? referenceColor(historyItem) : parent ? referenceColor(parent) : undefined;
			outputSwimlanes.push({ id: historyItem.parentIds[index], colorIndex: colorIndex ?? allocateColor() });
		}
		rows.push({ historyItem, inputSwimlanes, outputSwimlanes });
		lanes = outputSwimlanes;
	}
	return rows;
}

/** Renders one SCM history swimlane row with a stable color for each branch lane. */
export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel, expandedHeight = LaneHeight, document: Document = globalThis.document): SVGSVGElement {
	const row = historyItemViewModel;
	const kind: GraphNodeKind = row.kind === 'HEAD' ? 'head' : row.historyItem.parentIds.length > 1 ? 'merge' : 'commit';
	const svg = createSvgElement(document, "svg");
	svg.classList.add("ash-scm-graph-graph", kind);
	svg.setAttribute("aria-hidden", "true");
	const inputIndex = row.inputSwimlanes.findIndex((lane) => lane.id === row.historyItem.id);
	const circleIndex = inputIndex === -1 ? row.inputSwimlanes.length : inputIndex;
	const circleColorIndex = row.historyItem.parentIds.length > 0 ? row.outputSwimlanes[circleIndex]?.color ?? 0 : row.inputSwimlanes[circleIndex]?.color ?? 0;
	let outputSwimlaneIndex = 0;

	for (let index = 0; index < row.inputSwimlanes.length; index += 1) {
		const inputLane = row.inputSwimlanes[index];
		if (inputLane.id === row.historyItem.id) {
			if (index !== circleIndex) {
				appendPath(svg, `M ${LaneWidth * (index + 1)} 0 A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * index} ${LaneWidth} H ${LaneWidth * (circleIndex + 1)}`, inputLane.color);
			} else if (row.historyItem.parentIds.length > 0) {
				outputSwimlaneIndex += 1;
			}
			continue;
		}

		if (outputSwimlaneIndex >= row.outputSwimlanes.length || inputLane.id !== row.outputSwimlanes[outputSwimlaneIndex].id) continue;
		if (index === outputSwimlaneIndex) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V ${LaneHeight}`, inputLane.color);
		} else {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V 6 A ${CurveRadius} ${CurveRadius} 0 0 1 ${(LaneWidth * (index + 1)) - CurveRadius} ${LaneHeight / 2} H ${(LaneWidth * (outputSwimlaneIndex + 1)) + CurveRadius} A ${CurveRadius} ${CurveRadius} 0 0 0 ${LaneWidth * (outputSwimlaneIndex + 1)} ${(LaneHeight / 2) + CurveRadius} V ${LaneHeight}`, inputLane.color);
		}
		outputSwimlaneIndex += 1;
	}

	for (let index = 1; index < row.historyItem.parentIds.length; index += 1) {
		// Repeated parent IDs keep separate branch lanes until that commit is reached.
		const parentOutputIndex = findLastIdx(row.outputSwimlanes, lane => lane.id === row.historyItem.parentIds[index]);
		if (parentOutputIndex === -1) continue;
		const parentColorIndex = row.outputSwimlanes[parentOutputIndex].color;
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * (parentOutputIndex + 1)} ${LaneHeight}`, parentColorIndex);
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} H ${LaneWidth * (circleIndex + 1)}`, parentColorIndex);
	}

	if (inputIndex !== -1) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} 0 V ${LaneHeight / 2}`, row.inputSwimlanes[inputIndex].color);
	if (row.historyItem.parentIds.length > 0) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} ${LaneHeight / 2} V ${LaneHeight}`, circleColorIndex);
	if (expandedHeight > LaneHeight) {
		for (let index = 0; index < row.outputSwimlanes.length; index += 1) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} ${LaneHeight} V ${expandedHeight}`, row.outputSwimlanes[index].color);
		}
	}
	appendNode(svg, circleIndex, kind, circleColorIndex);
	svg.dataset.nodeX = String(LaneWidth * (circleIndex + 1));
	svg.style.width = `${LaneWidth * (Math.max(row.inputSwimlanes.length, row.outputSwimlanes.length, 1) + 1)}px`;
	svg.style.height = `${LaneHeight}px`;
	return svg;
}

function appendPath(svg: SVGSVGElement, data: string, colorIndex: number): void {
	const path = createSvgElement(svg.ownerDocument, "path");
	path.classList.add("ash-scm-graph-path");
	path.dataset.laneColor = String(colorIndex);
	path.setAttribute("d", data);
	svg.append(path);
}

function appendNode(svg: SVGSVGElement, index: number, kind: GraphNodeKind, colorIndex: number): void {
	if (kind === "head") {
		appendCircle(svg, index, 7, "outer", colorIndex);
		appendCircle(svg, index, 2, "inner", colorIndex);
		return;
	}
	if (kind === "merge") {
		appendCircle(svg, index, 6, "outer", colorIndex);
		appendCircle(svg, index, 3, "inner", colorIndex);
		return;
	}
	appendCircle(svg, index, 5, "single", colorIndex);
}

function appendCircle(svg: SVGSVGElement, index: number, radius: number, part: "inner" | "outer" | "single", colorIndex: number): void {
	const circle = createSvgElement(svg.ownerDocument, "circle");
	circle.classList.add("ash-scm-graph-node", part);
	circle.dataset.laneColor = String(colorIndex);
	circle.setAttribute("cx", `${LaneWidth * (index + 1)}`);
	circle.setAttribute("cy", `${LaneHeight / 2}`);
	circle.setAttribute("r", `${radius}`);
	svg.append(circle);
}
