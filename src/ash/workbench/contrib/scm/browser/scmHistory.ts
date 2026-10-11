import { localize } from '../../../../nls.js';
import { svg as createSvgElement } from "../../../../base/browser/dom.js";
import { findLastIdx } from "../../../../base/common/arraysFind.js";
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId, type ISCMHistoryItem, type ISCMHistoryItemRef, type ISCMHistoryItemViewModel } from '../common/history.js';

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

type GraphNodeKind = "commit" | "head" | "merge" | "incoming-changes" | "outgoing-changes";

export const SWIMLANE_HEIGHT = LaneHeight;
export const SWIMLANE_WIDTH = LaneWidth;

/** Projects ordered SCM history into stable, color-carrying swimlanes. */
export function toISCMHistoryItemViewModelArray(historyItems: readonly ISCMHistoryItem[], colorMap = new Map<string, number>(), currentHistoryItemRef?: ISCMHistoryItemRef, comparison?: { readonly remote: ISCMHistoryItemRef; readonly base: string; readonly incoming: boolean; readonly outgoing: boolean; }): ISCMHistoryItemViewModel[] {
	let items = [...historyItems];
	const parentOverrides = new Map<string, readonly string[]>();
	const local = currentHistoryItemRef?.revision;
	const remote = comparison?.remote.revision;
	const base = comparison?.base;
	if (comparison && local && remote && base && local !== remote) {
		if (comparison.incoming && remote !== base) {
			const baseIndex = items.findIndex(item => item.id === base);
			if (baseIndex >= 0 && items.some(item => item.id === remote)) {
				const reachable = new Set<string>();
				const byId = new Map(items.map(item => [item.id, item]));
				const pending = [remote];
				while (pending.length > 0) {
					const id = pending.pop()!;
					if (id === base || reachable.has(id)) { continue; }
					reachable.add(id);
					pending.push(...(byId.get(id)?.parentIds ?? []));
				}
				for (const item of items) {
					if (reachable.has(item.id)) { parentOverrides.set(item.id, item.parentIds.map(id => id === base ? SCMIncomingHistoryItemId : id)); }
				}
				items.splice(baseIndex, 0, { id: SCMIncomingHistoryItemId, subject: localize('scm.history.incoming', 'Incoming Changes'), message: '', parentIds: [base], comparison: { revision: remote, baseRevision: base } });
			}
		}
		if (comparison.outgoing && local !== base) {
			const localIndex = items.findIndex(item => item.id === local);
			if (localIndex >= 0) { items.splice(localIndex, 0, { id: SCMOutgoingHistoryItemId, subject: localize('scm.history.outgoing', 'Outgoing Changes'), message: '', parentIds: [local], comparison: { revision: local, baseRevision: base } }); }
		}
	}
	const rows = createRows(items, colorMap, parentOverrides);
	return rows.map(row => ({
		historyItem: row.historyItem,
		inputSwimlanes: row.inputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		outputSwimlanes: row.outputSwimlanes.map(lane => ({ id: lane.id, color: lane.colorIndex })),
		kind: row.historyItem.id === SCMIncomingHistoryItemId ? 'incoming-changes' : row.historyItem.id === SCMOutgoingHistoryItemId ? 'outgoing-changes' : row.historyItem.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node',
	}));
}

function createRows(historyItems: readonly ISCMHistoryItem[], colorMap: ReadonlyMap<string, number>, parentOverrides: ReadonlyMap<string, readonly string[]>): GraphRow[] {
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
		const parentIds = parentOverrides.get(historyItem.id) ?? historyItem.parentIds;
		const inputSwimlanes = lanes.map((lane) => ({ ...lane }));
		const outputSwimlanes: Lane[] = [];
		let firstParentAdded = false;

		for (const lane of inputSwimlanes) {
			if (lane.id === historyItem.id) {
				if (!firstParentAdded && parentIds.length > 0) {
					outputSwimlanes.push({ id: parentIds[0], colorIndex: referenceColor(historyItem) ?? lane.colorIndex });
					firstParentAdded = true;
				}
				continue;
			}
			outputSwimlanes.push({ ...lane });
		}

		for (let index = firstParentAdded ? 1 : 0; index < parentIds.length; index += 1) {
			const parent = historyById.get(parentIds[index]);
			const colorIndex = index === 0 ? referenceColor(historyItem) : parent ? referenceColor(parent) : undefined;
			outputSwimlanes.push({ id: parentIds[index], colorIndex: colorIndex ?? allocateColor() });
		}
		rows.push({ historyItem, inputSwimlanes, outputSwimlanes });
		lanes = outputSwimlanes;
	}
	return rows;
}

/** Renders one SCM history swimlane row with a stable color for each branch lane. */
export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel, expandedHeight = LaneHeight, document: Document = globalThis.document): SVGSVGElement {
	const row = historyItemViewModel;
	const kind: GraphNodeKind = row.kind === 'incoming-changes' || row.kind === 'outgoing-changes' ? row.kind : row.kind === 'HEAD' ? 'head' : row.historyItem.parentIds.length > 1 ? 'merge' : 'commit';
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
		let parentOutputIndex = findLastIdx(row.outputSwimlanes, lane => lane.id === row.historyItem.parentIds[index]);
		if (parentOutputIndex < 0) { parentOutputIndex = findLastIdx(row.outputSwimlanes, lane => lane.id === SCMIncomingHistoryItemId); }
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
	if (kind === 'incoming-changes' || kind === 'outgoing-changes') {
		appendCircle(svg, index, 7, 'outer', colorIndex);
		const x = LaneWidth * (index + 1);
		const y = LaneHeight / 2;
		const direction = kind === 'incoming-changes' ? 1 : -1;
		appendPath(svg, `M ${x} ${y - direction * 4} V ${y + direction * 4} M ${x - 3} ${y + direction} L ${x} ${y + direction * 4} L ${x + 3} ${y + direction}`, colorIndex);
		return;
	}
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
