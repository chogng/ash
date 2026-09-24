import type { GitCommitSummary } from "../../../services/git/common/gitService.js";
import { svg as createSvgElement } from "../../../../base/browser/dom.js";

const SvgNamespace = "http://www.w3.org/2000/svg";
const LaneHeight = 22;
const LaneWidth = 11;
const CurveRadius = 5;
const ColorCount = 8;

interface Lane {
	readonly objectId: string;
	readonly colorIndex: number;
}

export interface GraphRow {
	readonly commit: GitCommitSummary;
	readonly inputSwimlanes: readonly Lane[];
	readonly outputSwimlanes: readonly Lane[];
}

export interface GraphState {
	readonly lanes: readonly Lane[];
	readonly nextColor: number;
}

export interface GraphRows {
	readonly rows: readonly GraphRow[];
	readonly state: GraphState;
}

export type GraphNodeKind = "commit" | "head" | "merge";

export const GraphRowHeight = LaneHeight;

/** Projects ordered Git history into stable, color-carrying swimlanes. */
export function createRows(commits: readonly GitCommitSummary[], state: GraphState = { lanes: [], nextColor: 0 }): GraphRows {
	const rows: GraphRow[] = [];
	let lanes = state.lanes;
	let nextColorIndex = state.nextColor;
	const allocateColor = (): number => {
		const colorIndex = nextColorIndex;
		nextColorIndex = (nextColorIndex + 1) % ColorCount;
		return colorIndex;
	};

	for (const commit of commits) {
		const inputSwimlanes = lanes.map((lane) => ({ ...lane }));
		const outputSwimlanes: Lane[] = [];
		let firstParentAdded = false;
		const inputIndex = inputSwimlanes.findIndex((lane) => lane.objectId === commit.objectId);

		if (commit.parentObjectIds.length > 0) {
			for (const lane of inputSwimlanes) {
				if (lane.objectId === commit.objectId) {
					if (!firstParentAdded) {
						outputSwimlanes.push({ objectId: commit.parentObjectIds[0], colorIndex: lane.colorIndex });
						firstParentAdded = true;
					}
					continue;
				}
				outputSwimlanes.push({ ...lane });
			}
		}

		for (let index = firstParentAdded ? 1 : 0; index < commit.parentObjectIds.length; index += 1) {
			outputSwimlanes.push({ objectId: commit.parentObjectIds[index], colorIndex: allocateColor() });
		}
		rows.push({ commit, inputSwimlanes, outputSwimlanes });
		lanes = outputSwimlanes;
	}
	return { rows, state: { lanes, nextColor: nextColorIndex } };
}

/** Renders one SCM history swimlane row with a stable color for each branch lane. */
export function renderRow(document: Document, row: GraphRow, kind: GraphNodeKind, expandedHeight = LaneHeight): SVGSVGElement {
	const svg = createSvgElement(document, "svg");
	svg.classList.add("ash-scm-graph-graph", kind);
	svg.setAttribute("aria-hidden", "true");
	const inputIndex = row.inputSwimlanes.findIndex((lane) => lane.objectId === row.commit.objectId);
	const circleIndex = inputIndex === -1 ? row.inputSwimlanes.length : inputIndex;
	const circleColorIndex = inputIndex === -1 ? row.outputSwimlanes[0]?.colorIndex ?? 0 : row.inputSwimlanes[inputIndex].colorIndex;
	let outputSwimlaneIndex = 0;

	for (let index = 0; index < row.inputSwimlanes.length; index += 1) {
		const inputLane = row.inputSwimlanes[index];
		if (inputLane.objectId === row.commit.objectId) {
			if (index !== circleIndex) {
				appendPath(svg, `M ${LaneWidth * (index + 1)} 0 A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * index} ${LaneWidth} H ${LaneWidth * (circleIndex + 1)}`, inputLane.colorIndex);
			} else {
				outputSwimlaneIndex += 1;
			}
			continue;
		}

		if (outputSwimlaneIndex >= row.outputSwimlanes.length || inputLane.objectId !== row.outputSwimlanes[outputSwimlaneIndex].objectId) continue;
		if (index === outputSwimlaneIndex) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V ${LaneHeight}`, inputLane.colorIndex);
		} else {
			appendPath(svg, `M ${LaneWidth * (index + 1)} 0 V 6 A ${CurveRadius} ${CurveRadius} 0 0 1 ${(LaneWidth * (index + 1)) - CurveRadius} ${LaneHeight / 2} H ${(LaneWidth * (outputSwimlaneIndex + 1)) + CurveRadius} A ${CurveRadius} ${CurveRadius} 0 0 0 ${LaneWidth * (outputSwimlaneIndex + 1)} ${(LaneHeight / 2) + CurveRadius} V ${LaneHeight}`, inputLane.colorIndex);
		}
		outputSwimlaneIndex += 1;
	}

	for (let index = 1; index < row.commit.parentObjectIds.length; index += 1) {
		const parentOutputIndex = row.outputSwimlanes.findIndex((lane) => lane.objectId === row.commit.parentObjectIds[index]);
		if (parentOutputIndex === -1) continue;
		const parentColorIndex = row.outputSwimlanes[parentOutputIndex].colorIndex;
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} A ${LaneWidth} ${LaneWidth} 0 0 1 ${LaneWidth * (parentOutputIndex + 1)} ${LaneHeight}`, parentColorIndex);
		appendPath(svg, `M ${LaneWidth * parentOutputIndex} ${LaneHeight / 2} H ${LaneWidth * (circleIndex + 1)}`, parentColorIndex);
	}

	if (inputIndex !== -1) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} 0 V ${LaneHeight / 2}`, circleColorIndex);
	if (row.commit.parentObjectIds.length > 0) appendPath(svg, `M ${LaneWidth * (circleIndex + 1)} ${LaneHeight / 2} V ${LaneHeight}`, circleColorIndex);
	if (expandedHeight > LaneHeight) {
		for (let index = 0; index < row.outputSwimlanes.length; index += 1) {
			appendPath(svg, `M ${LaneWidth * (index + 1)} ${LaneHeight} V ${expandedHeight}`, row.outputSwimlanes[index].colorIndex);
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
