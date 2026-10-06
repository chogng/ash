import { generateUuid } from '../../../../../base/common/uuid.js';
import { designBounds, type DesignFrame, toDesignLocal, type DesignPoint } from '../core/geometry.js';
import { getDesignShapeEntries } from '../model/hitTest.js';
import type { DesignAsset, DesignShape, DesignShapeGeometry } from '../model/document.js';
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
			shape = {
				...geometry, kind, closed: false, strokeWidth: 2, nodes: [
					{ x: 0, y: 0.5, incoming: { x: 0, y: 0.5 }, outgoing: { x: 0.25, y: 0 } },
					{ x: 1, y: 0.5, incoming: { x: 0.75, y: 1 }, outgoing: { x: 1, y: 0.5 } },
				]
			};
		} else { shape = { ...geometry, kind }; }
		this.insertShape(shape);
		return shape.id;
	}

	public updateShape(shape: DesignShape): void { this.updateShapes([shape]); }

	public insertShape(shape: DesignShape, assets: readonly DesignAsset[] = this.model.value.assets): void {
		const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
		const frame = shape.kind === 'frame' ? undefined : getDesignShapeEntries(this.model.value.shapes).filter(entry => entry.world.kind === 'frame').reverse().find(entry => {
			const point = toDesignLocal(entry.world, center);
			return point.x >= 0 && point.y >= 0 && point.x <= entry.world.width && point.y <= entry.world.height;
		});
		if (!frame) { this.model.applyEdit([...this.model.value.shapes, shape], assets); return; }
		const position = toDesignLocal(frame.world, center);
		const child = { ...shape, x: position.x - shape.width / 2, y: position.y - shape.height / 2, rotation: shape.rotation - frame.world.rotation };
		if (shape.motion) {
			child.motion = {
				...shape.motion, keyframes: shape.motion.keyframes.map(keyframe => {
					const position = toDesignLocal(frame.world, { x: keyframe.x + shape.width / 2, y: keyframe.y + shape.height / 2 });
					return { ...keyframe, x: position.x - shape.width / 2, y: position.y - shape.height / 2, rotation: keyframe.rotation - frame.world.rotation };
				})
			};
		}
		const insert = (current: DesignShape): DesignShape => {
			if (current.id === frame.shape.id && current.kind === 'frame') { return { ...current, children: [...current.children, child] }; }
			return current.kind === 'frame' || current.kind === 'group' ? { ...current, children: current.children.map(insert) } : current;
		};
		this.model.applyEdit(this.model.value.shapes.map(insert), assets);
	}

	public addFrame(center: DesignPoint): string {
		const frame: DesignShape = { id: generateUuid(), kind: 'frame', x: center.x - 320, y: center.y - 240, width: 640, height: 480, rotation: 0, fill: '#ffffff', clip: true, children: [] };
		this.insertShape(frame);
		return frame.id;
	}

	public updateShapes(shapes: readonly DesignShape[]): void {
		const updates = new Map(shapes.map(shape => [shape.id, shape]));
		const update = (current: DesignShape): DesignShape => {
			const shape = updates.get(current.id);
			if (!shape) { return current.kind === 'frame' || current.kind === 'group' ? { ...current, children: current.children.map(update) } : current; }
			// Moving the base object carries its animation; editing keyframes supplies a new motion value.
			if (shape.motion && shape.motion === current.motion) {
				return { ...shape, motion: { ...shape.motion, keyframes: shape.motion.keyframes.map(frame => ({ ...frame, x: frame.x + shape.x - current.x, y: frame.y + shape.y - current.y, rotation: frame.rotation + shape.rotation - current.rotation })) } };
			}
			return shape;
		};
		this.model.applyEdit(this.model.value.shapes.map(update));
	}

	public updateGeometry(shape: DesignShape, field: keyof DesignFrame, value: number): void {
		let updated = { ...shape, [field]: value };
		if (shape.kind === 'group' && (field === 'width' || field === 'height')) {
			// The file format represents rotation and uniform group scale, so resizing keeps its aspect ratio.
			updated = { ...updated, width: value * (field === 'height' ? shape.contentWidth / shape.contentHeight : 1), height: value * (field === 'width' ? shape.contentHeight / shape.contentWidth : 1) };
		}
		this.updateShape(updated);
	}

	public canGroup(ids: ReadonlySet<string>): boolean {
		const entries = getDesignShapeEntries(this.model.value.shapes).filter(entry => ids.has(entry.shape.id));
		return entries.length >= 2 && entries.every(entry => entry.parent?.id === entries[0].parent?.id);
	}

	public group(ids: ReadonlySet<string>): string | undefined {
		if (!this.canGroup(ids)) { return undefined; }
		const entries = getDesignShapeEntries(this.model.value.shapes).filter(entry => ids.has(entry.shape.id));
		const children = entries.map(entry => entry.shape);
		const bounds = designBounds(children);
		const group: DesignShape = {
			...bounds,
			id: generateUuid(),
			kind: 'group',
			rotation: 0,
			fill: '#808080',
			contentWidth: bounds.width,
			contentHeight: bounds.height,
			children: children.map(shape => ({
				...shape, x: shape.x - bounds.x, y: shape.y - bounds.y,
				...(shape.motion ? { motion: { ...shape.motion, keyframes: shape.motion.keyframes.map(frame => ({ ...frame, x: frame.x - bounds.x, y: frame.y - bounds.y })) } } : {}),
			})),
		};
		// The group takes the frontmost selected position; unselected objects keep their relative order.
		const front = children.at(-1)!.id;
		this.editSiblings(entries[0].parent?.id, shapes => shapes.flatMap(shape => {
			if (shape.id === front) { return [group]; }
			return ids.has(shape.id) ? [] : [shape];
		}));
		return group.id;
	}

	public ungroup(id: string): readonly string[] {
		const entry = getDesignShapeEntries(this.model.value.shapes).find(entry => entry.shape.id === id);
		const group = entry?.shape;
		if (group?.kind !== 'group' || group.motion) { return []; }
		// Uniform group scaling keeps children representable without shear after ungrouping.
		const scale = group.width / group.contentWidth;
		const radians = group.rotation * Math.PI / 180;
		// A frame does not scale its contents by itself; removing the group must carry its scale into those contents.
		const scaleFrameChild = (child: DesignShape): DesignShape => {
			const geometry = { ...child, x: child.x * scale, y: child.y * scale, width: child.width * scale, height: child.height * scale, ...(child.motion ? { motion: { ...child.motion, keyframes: child.motion.keyframes.map(frame => ({ ...frame, x: frame.x * scale, y: frame.y * scale })) } } : {}) };
			if (geometry.kind === 'frame') { return { ...geometry, children: geometry.children.map(scaleFrameChild) }; }
			if (geometry.kind === 'text') { return { ...geometry, fontSize: geometry.fontSize * scale }; }
			if (geometry.kind === 'path') { return { ...geometry, strokeWidth: geometry.strokeWidth * scale }; }
			return geometry;
		};
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
			if (child.motion) {
				geometry.motion = {
					...child.motion, keyframes: child.motion.keyframes.map(frame => {
						const dx = (frame.x + child.width / 2) * scale - group.width / 2;
						const dy = (frame.y + child.height / 2) * scale - group.height / 2;
						return {
							...frame,
							x: group.x + group.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians) - child.width * scale / 2,
							y: group.y + group.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians) - child.height * scale / 2,
							rotation: frame.rotation + group.rotation,
						};
					})
				};
			}
			if (geometry.kind === 'text') { return { ...geometry, fontSize: geometry.fontSize * scale }; }
			if (geometry.kind === 'path') { return { ...geometry, strokeWidth: geometry.strokeWidth * scale }; }
			if (geometry.kind === 'frame') { return { ...geometry, children: geometry.children.map(scaleFrameChild) }; }
			return geometry;
		});
		this.editSiblings(entry!.parent?.id, shapes => shapes.flatMap(shape => shape.id === id ? children : [shape]));
		return children.map(child => child.id);
	}

	private editSiblings(parentId: string | undefined, edit: (shapes: readonly DesignShape[]) => readonly DesignShape[]): void {
		const update = (shape: DesignShape): DesignShape => {
			if (shape.kind !== 'frame') { return shape; }
			return { ...shape, children: shape.id === parentId ? edit(shape.children) : shape.children.map(update) };
		};
		this.model.applyEdit(parentId === undefined ? edit(this.model.value.shapes) : this.model.value.shapes.map(update));
	}

	public removeShapes(ids: ReadonlySet<string>): void {
		const remove = (shapes: readonly DesignShape[]): readonly DesignShape[] => shapes.filter(shape => !ids.has(shape.id)).map(shape => shape.kind === 'frame' || shape.kind === 'group' ? { ...shape, children: remove(shape.children) } : shape);
		this.model.applyEdit(remove(this.model.value.shapes));
	}
}
