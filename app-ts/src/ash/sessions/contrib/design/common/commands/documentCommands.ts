import { generateUuid } from '../../../../../base/common/uuid.js';
import { designBounds, type DesignFrame, type DesignPoint } from '../core/geometry.js';
import type { DesignShape, DesignShapeGeometry } from '../model/document.js';
import type { DesignModel } from '../model/designModel.js';

/** Every document edit reaches the same atomic history boundary. */
export class DocumentCommands {
	constructor(private readonly model: DesignModel) { }

	public addShape(kind: 'rectangle' | 'ellipse' | 'text' | 'path', center: DesignPoint, text = ''): string {
		const geometry: DesignShapeGeometry = { id: generateUuid(), x: center.x - 60, y: center.y - 40, width: 120, height: 80, rotation: 0, fill: '#808080' };
		let shape: DesignShape;
		if (kind === 'text') {
			shape = { ...geometry, kind, x: center.x - 120, width: 240, text, fontSize: 24 };
		} else if (kind === 'path') {
			shape = { ...geometry, kind, closed: false, strokeWidth: 2, nodes: [
				{ x: 0, y: 0.5, incoming: { x: 0, y: 0.5 }, outgoing: { x: 0.25, y: 0 } },
				{ x: 1, y: 0.5, incoming: { x: 0.75, y: 1 }, outgoing: { x: 1, y: 0.5 } },
			] };
		} else { shape = { ...geometry, kind }; }
		this.model.applyEdit([...this.model.value.shapes, shape]);
		return shape.id;
	}

	public updateShape(shape: DesignShape): void { this.updateShapes([shape]); }

	public updateShapes(shapes: readonly DesignShape[]): void {
		const updates = new Map(shapes.map(shape => [shape.id, shape]));
		this.model.applyEdit(this.model.value.shapes.map(current => updates.get(current.id) ?? current));
	}

	public updateGeometry(shape: DesignShape, field: keyof DesignFrame, value: number): void {
		let updated = { ...shape, [field]: value };
		if (shape.kind === 'group' && (field === 'width' || field === 'height')) {
			// The file format represents rotation and uniform group scale, so resizing keeps its aspect ratio.
			updated = { ...updated, width: value * (field === 'height' ? shape.contentWidth / shape.contentHeight : 1), height: value * (field === 'width' ? shape.contentHeight / shape.contentWidth : 1) };
		}
		this.updateShape(updated);
	}

	public group(ids: ReadonlySet<string>): string | undefined {
		const children = this.model.value.shapes.filter(shape => ids.has(shape.id));
		if (children.length < 2) { return undefined; }
		const bounds = designBounds(children);
		const group: DesignShape = {
			...bounds,
			id: generateUuid(),
			kind: 'group',
			rotation: 0,
			fill: '#808080',
			contentWidth: bounds.width,
			contentHeight: bounds.height,
			children: children.map(shape => ({ ...shape, x: shape.x - bounds.x, y: shape.y - bounds.y })),
		};
		// The group takes the frontmost selected position; unselected objects keep their relative order.
		const front = children.at(-1)!.id;
		this.model.applyEdit(this.model.value.shapes.flatMap(shape => {
			if (shape.id === front) { return [group]; }
			return ids.has(shape.id) ? [] : [shape];
		}));
		return group.id;
	}

	public ungroup(id: string): readonly string[] {
		const group = this.model.value.shapes.find(shape => shape.id === id);
		if (group?.kind !== 'group') { return []; }
		// Uniform group scaling keeps children representable without shear after ungrouping.
		const scale = group.width / group.contentWidth;
		const radians = group.rotation * Math.PI / 180;
		const children = group.children.map((child): DesignShape => {
			const dx = (child.x + child.width / 2) * scale - group.width / 2;
			const dy = (child.y + child.height / 2) * scale - group.height / 2;
			const geometry = {
				...child,
				x: group.x + group.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians) - child.width * scale / 2,
				y: group.y + group.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians) - child.height * scale / 2,
				width: child.width * scale,
				height: child.height * scale,
				rotation: child.rotation + group.rotation,
			};
			if (geometry.kind === 'text') { return { ...geometry, fontSize: geometry.fontSize * scale }; }
			if (geometry.kind === 'path') { return { ...geometry, strokeWidth: geometry.strokeWidth * scale }; }
			return geometry;
		});
		this.model.applyEdit(this.model.value.shapes.flatMap(shape => shape.id === id ? children : [shape]));
		return children.map(child => child.id);
	}

	public removeShapes(ids: ReadonlySet<string>): void { this.model.applyEdit(this.model.value.shapes.filter(shape => !ids.has(shape.id))); }
}
