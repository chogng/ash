import type { DesignShape } from './model/document.js';

/** Selection and the active path node belong to a view, never to the saved document. */
export class DesignSelection {
	private readonly selectedIds = new Set<string>();
	public nodeIndex = 0;

	public get ids(): ReadonlySet<string> { return this.selectedIds; }

	public set(ids: readonly string[]): void {
		this.selectedIds.clear();
		for (const id of ids) { this.selectedIds.add(id); }
		this.nodeIndex = 0;
	}

	public add(id: string): void { this.selectedIds.add(id); }

	public toggle(id: string): void {
		if (this.selectedIds.has(id)) { this.selectedIds.delete(id); }
		else { this.selectedIds.add(id); }
	}

	public retain(shapes: readonly DesignShape[]): boolean {
		const ids = new Set(shapes.map(shape => shape.id));
		const count = this.selectedIds.size;
		for (const id of this.selectedIds) { if (!ids.has(id)) { this.selectedIds.delete(id); } }
		return this.selectedIds.size !== count;
	}
}
