import { h } from "../../base/browser/dom.js";
import { Dimension } from "../../base/browser/dom.js";
import { type IPositionedRectangle } from "../../base/browser/geometry.js";
import type { Event } from "../../base/common/event.js";
import type { WorkbenchPartId } from "../services/layout/common/workbenchLayoutService.js";
import type { WorkbenchPart } from "./part.js";

export interface WorkbenchPartFrameInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export const NoWorkbenchPartFrameInsets: WorkbenchPartFrameInsets = {
	top: 0,
	right: 0,
	bottom: 0,
	left: 0,
};

export interface WorkbenchPartViewOptions {
	/** Whether the hosting Grid may snap this Part closed through its Sash. */
	readonly snap?: boolean;
}

/** Adapts one Workbench Part to the generic Grid view contract. */
export class WorkbenchPartView<TPartId extends string = WorkbenchPartId> {
	readonly frame: HTMLDivElement;
	readonly snap: boolean;
	private frameInsets = NoWorkbenchPartFrameInsets;

	constructor(
		readonly partId: TPartId,
		readonly part: WorkbenchPart,
		options: WorkbenchPartViewOptions = {},
	) {
		const frame = h(part.domNode.ownerDocument, "div");
		this.frame = frame;
		frame.className = "ash-workbench-part-frame";
		frame.append(part.domNode);
		this.snap = options.snap === true;
	}

	get element(): HTMLElement {
		return this.frame;
	}

	get minimumWidth(): number {
		return this.part.minimumWidth + this.frameInsets.left + this.frameInsets.right;
	}

	get maximumWidth(): number {
		return this.part.maximumWidth + this.frameInsets.left + this.frameInsets.right;
	}

	get minimumHeight(): number {
		return this.part.minimumHeight + this.frameInsets.top + this.frameInsets.bottom;
	}

	get maximumHeight(): number {
		return this.part.maximumHeight + this.frameInsets.top + this.frameInsets.bottom;
	}

	get onDidChange(): Event<void> {
		return this.part.onDidChangeConstraints;
	}

	layout(bounds: IPositionedRectangle): void {
		this.part.layout(new Dimension(
			Math.max(0, bounds.width - this.frameInsets.left - this.frameInsets.right),
			Math.max(0, bounds.height - this.frameInsets.top - this.frameInsets.bottom),
		));
	}

	setVisible(visible: boolean): void {
		this.part.setVisible(visible);
	}

	setFrameInsets(insets: WorkbenchPartFrameInsets): void {
		if (
			this.frameInsets.top === insets.top &&
			this.frameInsets.right === insets.right &&
			this.frameInsets.bottom === insets.bottom &&
			this.frameInsets.left === insets.left
		) {
			return;
		}
		this.frameInsets = insets;
		this.frame.style.paddingTop = `${insets.top}px`;
		this.frame.style.paddingRight = `${insets.right}px`;
		this.frame.style.paddingBottom = `${insets.bottom}px`;
		this.frame.style.paddingLeft = `${insets.left}px`;
	}

	toJSON(): TPartId {
		return this.partId;
	}
}
