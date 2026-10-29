import type { DesignShape } from './model/document.js';

/** Selection and the active path node belong to a view, never to the saved document. */
export class DesignSelection {
	private readonly selectedIds = new Set<string>();
	public contourIndex = 0;
	public editingVector = false;
	public paintingVector = false;
	public editingWidth = false;
	public paintId: string | undefined;
	public gradientStopId: string | undefined;
	public editingGradient = false;
	public effectId: string | undefined;
	public editingBlur = false;
	public blurHandle: 'start' | 'end' = 'end';
	public readonly widthPointIds = new Set<string>();
	public selectWidth(id: string, additive = false): void {
		if (!additive) {
			this.widthPointIds.clear();
		}
		if (additive && this.widthPointIds.has(id)) {
			this.widthPointIds.delete(id);
		} else {
			this.widthPointIds.add(id);
		}
		this.editingVector = true;
		this.editingWidth = true;
	}
	private activeNode = 0;
	public readonly nodeIndices = new Set<number>([0]);
	public get nodeIndex(): number {
		return this.activeNode;
	}
	public set nodeIndex(index: number) {
		this.activeNode = index;
		this.nodeIndices.clear();
		this.nodeIndices.add(index);
	}
	public selectNode(contour: number, index: number, additive = false): void {
		if (contour !== this.contourIndex || !additive) {
			this.nodeIndices.clear();
		}
		this.contourIndex = contour;
		this.activeNode = index;
		this.editingVector = true;
		if (additive && this.nodeIndices.has(index)) {
			this.nodeIndices.delete(index);
		} else {
			this.nodeIndices.add(index);
		}
	}

	public get ids(): ReadonlySet<string> {
		return this.selectedIds;
	}

	public set(ids: readonly string[]): void {
		this.effectId = undefined;
		this.editingBlur = false;
		this.blurHandle = 'end';
		this.selectedIds.clear();
		for (const id of ids) {
			this.selectedIds.add(id);
		}
		this.nodeIndex = 0;
		this.contourIndex = 0;
		this.editingVector = false;
		this.paintingVector = false;
		this.editingWidth = false;
		this.widthPointIds.clear();
		this.paintId = undefined;
		this.gradientStopId = undefined;
		this.editingGradient = false;
	}

	public add(id: string): void {
		this.selectedIds.add(id);
	}

	public toggle(id: string): void {
		if (this.selectedIds.has(id)) {
			this.selectedIds.delete(id);
		} else {
			this.selectedIds.add(id);
		}
	}

	public retain(shapes: readonly DesignShape[]): boolean {
		const ids = new Set(shapes.map(shape => shape.id));
		const count = this.selectedIds.size;
		for (const id of this.selectedIds) {
			if (!ids.has(id)) {
				this.selectedIds.delete(id);
			}
		}
		return this.selectedIds.size !== count;
	}
}
