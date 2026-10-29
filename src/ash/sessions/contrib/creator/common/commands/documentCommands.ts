import { VectorCommands, flattenDesignVector } from './vectorCommands.js';
import { isDesignVector, type DesignBooleanOperation, type DesignPathContour } from '../model/designVector.js';
import { TextCommands } from './textCommands.js';
import { updateDesignText, scaleDesignText } from '../model/designText.js';
import { mapPrototypeActions } from '../model/prototype.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { designBounds, type DesignFrame, toDesignLocal, type DesignPoint } from '../core/geometry.js';
import { getDesignShapeEntries } from '../model/hitTest.js';
import {
	flattenDesignShapes,
	type DesignAsset,
	type DesignAutoLayout,
	type DesignShape,
	type DesignShapeGeometry,
} from '../model/document.js';
import type { DesignModel } from '../model/designModel.js';
import { PrototypeCommands } from './prototypeCommands.js';
import { ResourceCommands } from './resourceCommands.js';
import { ComponentCommands } from './componentCommands.js';

/** Every document edit reaches the same atomic history boundary. */
export class DocumentCommands {
	public readonly components: ComponentCommands;
	public readonly text: TextCommands;
	public readonly vector: VectorCommands;
	public readonly prototype: PrototypeCommands;
	public readonly resources: ResourceCommands;
	constructor(private readonly model: DesignModel) {
		this.vector = new VectorCommands(model);
		this.text = new TextCommands(model);
		this.prototype = new PrototypeCommands(model);
		this.components = new ComponentCommands(model);
		this.resources = new ResourceCommands(model);
	}

	public setBackground(background: string): void {
		this.model.setBackground(background);
	}

	public addShape(kind: 'rectangle' | 'ellipse' | 'text' | 'path', center: DesignPoint, text = ''): string {
		const geometry: DesignShapeGeometry = {
			id: generateUuid(),
			x: center.x - 60,
			y: center.y - 40,
			width: 120,
			height: 80,
			rotation: 0,
			fill: '#808080',
		};
		let shape: DesignShape;
		if (kind === 'text') {
			shape = { ...geometry, kind, x: center.x - 120, width: 240, text, fontSize: 24, textAutoResize: 'width' };
		} else if (kind === 'path') {
			shape = {
				...geometry,
				kind,
				closed: false,
				strokeWidth: 2,
				nodes: [
					{ x: 0, y: 0.5, incoming: { x: 0, y: 0.5 }, outgoing: { x: 0.25, y: 0 } },
					{ x: 1, y: 0.5, incoming: { x: 0.75, y: 1 }, outgoing: { x: 1, y: 0.5 } },
				],
			};
		} else {
			shape = { ...geometry, kind };
		}
		this.insertShape(shape);
		return shape.id;
	}

	public updateShape(shape: DesignShape): void {
		this.updateShapes([shape]);
	}

	public insertShape(shape: DesignShape, assets: readonly DesignAsset[] = this.model.value.assets): void {
		const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
		const frame =
			shape.kind === 'frame'
				? undefined
				: getDesignShapeEntries(this.model.value.shapes)
						.filter(
							entry =>
								entry.shape.kind === 'frame' &&
								!entry.shape.instance &&
								entry.shape.component?.kind !== 'set' &&
								!this.components.isInstanceChild(entry.shape.id),
						)
						.reverse()
						.find(entry => {
							const point = toDesignLocal(entry.world, center);
							return (
								point.x >= 0 &&
								point.y >= 0 &&
								point.x <= entry.world.width &&
								point.y <= entry.world.height
							);
						});
		if (!frame) {
			this.model.applyEdit([...this.model.value.shapes, shape], assets);
			return;
		}
		const position = toDesignLocal(frame.world, center);
		const scale = frame.world.width / frame.shape.width;
		let child = {
			...shape,
			x: (position.x - shape.width / 2) / scale,
			y: (position.y - shape.height / 2) / scale,
			width: shape.width / scale,
			height: shape.height / scale,
			rotation: shape.rotation - frame.world.rotation,
		};
		if (child.kind === 'text') {
			child = scaleDesignText(child, 1 / scale);
		}
		if (child.kind === 'path') {
			child = { ...child, strokeWidth: child.strokeWidth / scale };
		}
		if (shape.motion) {
			child.motion = {
				...shape.motion,
				keyframes: shape.motion.keyframes.map(keyframe => {
					const position = toDesignLocal(frame.world, {
						x: keyframe.x + shape.width / 2,
						y: keyframe.y + shape.height / 2,
					});
					return {
						...keyframe,
						x: (position.x - shape.width / 2) / scale,
						y: (position.y - shape.height / 2) / scale,
						rotation: keyframe.rotation - frame.world.rotation,
					};
				}),
			};
		}
		const insert = (current: DesignShape): DesignShape => {
			if (current.id === frame.shape.id && current.kind === 'frame') {
				return { ...current, children: [...current.children, child] };
			}
			return current.kind === 'frame' || current.kind === 'group'
				? { ...current, children: current.children.map(insert) }
				: current;
		};
		this.model.applyEdit(this.model.value.shapes.map(insert), assets);
	}

	public addFrame(center: DesignPoint): string {
		const frame: DesignShape = {
			id: generateUuid(),
			kind: 'frame',
			x: center.x - 320,
			y: center.y - 240,
			width: 640,
			height: 480,
			rotation: 0,
			fill: '#ffffff',
			clip: true,
			children: [],
		};
		this.insertShape(frame);
		return frame.id;
	}

	public updateShapes(shapes: readonly DesignShape[]): void {
		const updates = new Map(shapes.map(shape => [shape.id, shape]));
		const update = (current: DesignShape): DesignShape => {
			let shape = updates.get(current.id) ?? current;
			if (
				shape.kind === 'text' &&
				current.kind === 'text' &&
				shape.text !== current.text &&
				shape.textRuns === current.textRuns
			) {
				shape = { ...shape, textRuns: updateDesignText(current, shape.text).textRuns };
			}
			if (shape.kind === 'frame' || shape.kind === 'group') {
				shape = { ...shape, children: shape.children.map(update) };
			}
			// Moving the base object carries its animation; editing keyframes supplies a new motion value.
			if (shape.motion && shape.motion === current.motion) {
				return {
					...shape,
					motion: {
						...shape.motion,
						keyframes: shape.motion.keyframes.map(frame => ({
							...frame,
							x: frame.x + shape.x - current.x,
							y: frame.y + shape.y - current.y,
							rotation: frame.rotation + shape.rotation - current.rotation,
						})),
					},
				};
			}
			return shape;
		};
		this.model.applyEdit(this.model.value.shapes.map(update));
	}

	public updateGeometry(shape: DesignShape, field: keyof DesignFrame, value: number): void {
		let updated = { ...shape, [field]: value };
		if (field === 'width' || field === 'height') {
			if (updated.kind === 'text') {
				updated = {
					...updated,
					textAutoResize:
						field === 'width' && (updated.textAutoResize === 'width' || updated.textAutoResize === 'height')
							? 'height'
							: 'none',
				};
			}
			if (updated.sizing) {
				updated = { ...updated, sizing: { ...updated.sizing, [field]: 'fixed' } };
			}
			if (updated.kind === 'frame' && updated.autoLayout) {
				updated = { ...updated, autoLayout: { ...updated.autoLayout, [field]: 'fixed' } };
			}
		}
		if (shape.kind === 'group' && (field === 'width' || field === 'height')) {
			// The file format represents rotation and uniform group scale, so resizing keeps its aspect ratio.
			updated = {
				...updated,
				width: value * (field === 'height' ? shape.contentWidth / shape.contentHeight : 1),
				height: value * (field === 'width' ? shape.contentHeight / shape.contentWidth : 1),
			};
		}
		this.updateShape(updated);
	}

	/** Root selections exclude descendants so a selected subtree is never edited twice. */
	private selectedEntries(ids: ReadonlySet<string>) {
		return getDesignShapeEntries(this.model.value.shapes).filter(
			entry => ids.has(entry.shape.id) && !entry.ancestors.some(id => ids.has(id)),
		);
	}

	public duplicate(ids: ReadonlySet<string>): readonly string[] {
		const entries = this.selectedEntries(ids);
		if (
			entries.length === 1 &&
			entries[0].parent?.kind === 'frame' &&
			entries[0].parent.component?.kind === 'set'
		) {
			const id = this.components.addVariant(entries[0].shape.id);
			return id ? [id] : [];
		}
		const selected = new Set(
			this.selectedEntries(ids)
				.filter(
					entry =>
						!this.components.isInstanceChild(entry.shape.id) &&
						(entry.parent?.kind !== 'frame' || entry.parent.component?.kind !== 'set'),
				)
				.map(entry => entry.shape.id),
		);
		const copies: string[] = [];
		const cloneIds = new Map(
			entries
				.filter(
					entry =>
						selected.has(entry.shape.id) &&
						!(entry.shape.kind === 'frame' && entry.shape.component?.kind === 'main'),
				)
				.flatMap(entry => flattenDesignShapes([entry.shape]))
				.map(shape => [shape.id, generateUuid()]),
		);
		const clone = (shape: DesignShape): DesignShape => {
			const copy = {
				...shape,
				id: cloneIds.get(shape.id)!,
				...(shape.interactions
					? {
							interactions: shape.interactions.map(interaction => ({
								...interaction,
								actions: mapPrototypeActions(interaction.actions, action => ({
									...action,
									...(action.destination
										? { destination: cloneIds.get(action.destination) ?? action.destination }
										: {}),
								})),
							})),
						}
					: {}),
			};
			return copy.kind === 'frame' || copy.kind === 'group'
				? { ...copy, children: copy.children.map(clone) }
				: copy;
		};
		const duplicate = (shapes: readonly DesignShape[]): readonly DesignShape[] =>
			shapes.flatMap<DesignShape>(shape => {
				if (selected.has(shape.id)) {
					const copy =
						shape.kind === 'frame' && shape.component?.kind === 'main'
							? this.components.makeInstance(shape)
							: clone(shape);
					copies.push(copy.id);
					return [
						shape,
						{
							...copy,
							x: copy.x + 20,
							y: copy.y + 20,
							...(copy.motion
								? {
										motion: {
											...copy.motion,
											keyframes: copy.motion.keyframes.map(frame => ({
												...frame,
												x: frame.x + 20,
												y: frame.y + 20,
											})),
										},
									}
								: {}),
						},
					];
				}
				return [shape.kind === 'frame' ? { ...shape, children: duplicate(shape.children) } : shape];
			});
		this.model.applyEdit(duplicate(this.model.value.shapes));
		return copies;
	}

	public reorder(ids: ReadonlySet<string>, order: 'front' | 'back' | 'forward' | 'backward'): void {
		const selected = new Set(
			this.selectedEntries(ids)
				.filter(entry => !this.components.isInstanceChild(entry.shape.id))
				.map(entry => entry.shape.id),
		);
		const reorder = (shapes: readonly DesignShape[]): readonly DesignShape[] => {
			const result = shapes.map(shape =>
				shape.kind === 'frame' && !selected.has(shape.id)
					? { ...shape, children: reorder(shape.children) }
					: shape,
			);
			if (order === 'front') {
				return [
					...result.filter(shape => !selected.has(shape.id)),
					...result.filter(shape => selected.has(shape.id)),
				];
			}
			if (order === 'back') {
				return [
					...result.filter(shape => selected.has(shape.id)),
					...result.filter(shape => !selected.has(shape.id)),
				];
			}
			if (order === 'forward') {
				for (let index = result.length - 2; index >= 0; index--) {
					if (selected.has(result[index].id) && !selected.has(result[index + 1].id)) {
						[result[index], result[index + 1]] = [result[index + 1], result[index]];
					}
				}
			} else {
				for (let index = 1; index < result.length; index++) {
					if (selected.has(result[index].id) && !selected.has(result[index - 1].id)) {
						[result[index], result[index - 1]] = [result[index - 1], result[index]];
					}
				}
			}
			return result;
		};
		this.model.applyEdit(reorder(this.model.value.shapes));
	}

	public canArrange(ids: ReadonlySet<string>, minimum = 1): boolean {
		const entries = this.selectedEntries(ids);
		const layout = entries[0]?.parent?.kind === 'frame' ? entries[0].parent.autoLayout : undefined;
		return (
			entries.length >= minimum &&
			entries.every(
				entry => entry.parent?.id === entries[0].parent?.id && !this.components.isInstanceChild(entry.shape.id),
			) &&
			(!layout ||
				entries.every(entry => entry.shape.layoutPositioning === 'absolute') ||
				(minimum === 1 && layout?.direction === 'grid')) &&
			(entries.length > 1 || !!entries[0].parent)
		);
	}

	public align(
		ids: ReadonlySet<string>,
		axis: 'horizontal' | 'vertical',
		alignment: 'start' | 'center' | 'end',
	): void {
		if (!this.canArrange(ids)) {
			return;
		}
		const entries = this.selectedEntries(ids);
		const shapes = entries.map(entry => entry.shape);
		if (
			entries[0].parent?.kind === 'frame' &&
			entries[0].parent.autoLayout?.direction === 'grid' &&
			entries.some(entry => entry.shape.layoutPositioning !== 'absolute')
		) {
			this.updateShapes(shapes.map(shape => ({ ...shape, gridCell: { ...shape.gridCell, [axis]: alignment } })));
			return;
		}
		const parent = entries[0].parent;
		const bounds =
			shapes.length === 1
				? {
						x: 0,
						y: 0,
						width: parent?.kind === 'group' ? parent.contentWidth : parent!.width,
						height: parent?.kind === 'group' ? parent.contentHeight : parent!.height,
					}
				: designBounds(shapes);
		const position = axis === 'horizontal' ? 'x' : 'y';
		const size = axis === 'horizontal' ? 'width' : 'height';
		const fraction = alignment === 'center' ? 0.5 : alignment === 'end' ? 1 : 0;
		this.updateShapes(
			shapes.map(shape => {
				const box = designBounds([shape]);
				return {
					...shape,
					[position]:
						shape[position] +
						bounds[position] +
						bounds[size] * fraction -
						box[position] -
						box[size] * fraction,
				};
			}),
		);
	}

	public distribute(ids: ReadonlySet<string>, axis: 'horizontal' | 'vertical'): void {
		if (!this.canArrange(ids, 3)) {
			return;
		}
		const position = axis === 'horizontal' ? 'x' : 'y';
		const size = axis === 'horizontal' ? 'width' : 'height';
		const shapes = this.selectedEntries(ids)
			.map(entry => ({ shape: entry.shape, bounds: designBounds([entry.shape]) }))
			.sort((a, b) => a.bounds[position] - b.bounds[position]);
		const first = shapes[0].bounds;
		const last = shapes.at(-1)!.bounds;
		const gap =
			(last[position] + last[size] - first[position] - shapes.reduce((sum, item) => sum + item.bounds[size], 0)) /
			(shapes.length - 1);
		let cursor = first[position];
		this.updateShapes(
			shapes.map(({ shape, bounds }) => {
				const updated = { ...shape, [position]: shape[position] + cursor - bounds[position] };
				cursor += bounds[size] + gap;
				return updated;
			}),
		);
	}

	public canAddAutoLayout(ids: ReadonlySet<string>): boolean {
		const entries = this.selectedEntries(ids);
		return (
			entries.length > 0 &&
			entries.every(
				entry =>
					entry.parent?.id === entries[0].parent?.id &&
					!this.components.isInstanceChild(entry.shape.id) &&
					(entry.parent?.kind !== 'frame' || entry.parent.component?.kind !== 'set') &&
					!(entry.shape.kind === 'frame' && entry.shape.component?.kind === 'set'),
			)
		);
	}

	public addAutoLayout(ids: ReadonlySet<string>): string | undefined {
		if (!this.canAddAutoLayout(ids)) {
			return undefined;
		}
		const entries = this.selectedEntries(ids);
		const children = entries.map(entry => entry.shape);
		const layout: DesignAutoLayout = {
			direction: 'horizontal',
			gap: 12,
			padding: { top: 12, right: 12, bottom: 12, left: 12 },
			align: 'start',
			justify: 'start',
			width: 'hug',
			height: 'hug',
		};
		if (children.length === 1 && children[0].kind === 'frame') {
			const frame = children[0];
			this.updateShape({
				...frame,
				autoLayout: frame.autoLayout ?? { ...layout, width: 'fixed', height: 'fixed' },
			});
			return frame.id;
		}
		const bounds = designBounds(children);
		const id = generateUuid();
		const frame: DesignShape = {
			...bounds,
			id,
			kind: 'frame',
			rotation: 0,
			fill: '#ffffff00',
			clip: false,
			autoLayout: layout,
			children: children.map(shape => ({
				...shape,
				x: shape.x - bounds.x,
				y: shape.y - bounds.y,
				...(shape.motion
					? {
							motion: {
								...shape.motion,
								keyframes: shape.motion.keyframes.map(keyframe => ({
									...keyframe,
									x: keyframe.x - bounds.x,
									y: keyframe.y - bounds.y,
								})),
							},
						}
					: {}),
			})),
		};
		const selected = new Set(children.map(shape => shape.id));
		this.editSiblings(entries[0].parent?.id, siblings =>
			siblings.flatMap(shape =>
				shape.id === children.at(-1)!.id ? [frame] : selected.has(shape.id) ? [] : [shape],
			),
		);
		return id;
	}

	public canGroup(ids: ReadonlySet<string>): boolean {
		const entries = getDesignShapeEntries(this.model.value.shapes).filter(entry => ids.has(entry.shape.id));
		return (
			entries.length >= 2 &&
			entries.every(
				entry =>
					entry.parent?.id === entries[0].parent?.id &&
					!this.components.isInstanceChild(entry.shape.id) &&
					(entry.parent?.kind !== 'frame' || entry.parent.component?.kind !== 'set'),
			)
		);
	}

	public canCombine(ids: ReadonlySet<string>): boolean {
		return (
			this.canGroup(ids) &&
			getDesignShapeEntries(this.model.value.shapes)
				.filter(entry => ids.has(entry.shape.id))
				.every(entry => isDesignVector(entry.shape))
		);
	}

	public group(ids: ReadonlySet<string>, booleanOperation?: DesignBooleanOperation): string | undefined {
		return this.combine(ids, booleanOperation);
	}

	public flatten(
		ids: ReadonlySet<string>,
		contours: (shape: DesignShape) => readonly DesignPathContour[],
		converted?: ReadonlyMap<string, DesignShape>,
	): string | undefined {
		if (
			!this.canGroup(ids) ||
			(converted
				? [...ids].some(id => !converted.get(id) || !isDesignVector(converted.get(id)!))
				: !this.canCombine(ids))
		) {
			return undefined;
		}
		return this.combine(ids, 'union', contours, converted);
	}

	private combine(
		ids: ReadonlySet<string>,
		booleanOperation?: DesignBooleanOperation,
		contours?: (shape: DesignShape) => readonly DesignPathContour[],
		converted?: ReadonlyMap<string, DesignShape>,
	): string | undefined {
		if (!this.canGroup(ids) || (booleanOperation && !converted && !this.canCombine(ids))) {
			return undefined;
		}
		const entries = getDesignShapeEntries(this.model.value.shapes).filter(entry => ids.has(entry.shape.id));
		const children = entries.map(entry => converted?.get(entry.shape.id) ?? entry.shape);
		const bounds = designBounds(children);
		const appearance = booleanOperation === 'subtract' ? children[0] : children.at(-1)!;
		const group: DesignShape = {
			...bounds,
			id: generateUuid(),
			kind: 'group',
			rotation: 0,
			fill: appearance.fill,
			...(booleanOperation
				? {
						booleanOperation,
						...(appearance.fills ? { fills: appearance.fills } : {}),
						...(appearance.blendMode ? { blendMode: appearance.blendMode } : {}),
						...(appearance.opacity !== undefined ? { opacity: appearance.opacity } : {}),
						...(appearance.effects ? { effects: appearance.effects } : {}),
						...(appearance.bindings
							? {
									bindings: Object.fromEntries(
										Object.entries(appearance.bindings).filter(
											([key]) => key === 'fill' || key === 'opacity',
										),
									),
								}
							: {}),
						...(appearance.styleBindings
							? {
									styleBindings: Object.fromEntries(
										Object.entries(appearance.styleBindings).filter(
											([key]) => key === 'fill' || key === 'effect',
										),
									),
								}
							: {}),
					}
				: {}),
			contentWidth: bounds.width,
			contentHeight: bounds.height,
			children: children.map(shape => ({
				...shape,
				x: shape.x - bounds.x,
				y: shape.y - bounds.y,
				...(shape.motion
					? {
							motion: {
								...shape.motion,
								keyframes: shape.motion.keyframes.map(frame => ({
									...frame,
									x: frame.x - bounds.x,
									y: frame.y - bounds.y,
								})),
							},
						}
					: {}),
			})),
		};
		const paths = contours?.(group);
		if (paths && !paths.length) {
			return undefined;
		}
		const combined = paths ? flattenDesignVector(group, paths) : group;
		// The group takes the frontmost selected position; unselected objects keep their relative order.
		const front = children.at(-1)!.id;
		this.editSiblings(entries[0].parent?.id, shapes =>
			shapes.flatMap<DesignShape>(shape => {
				if (shape.id === front) {
					return [combined];
				}
				return ids.has(shape.id) ? [] : [shape];
			}),
		);
		return group.id;
	}

	public ungroup(id: string): readonly string[] {
		const entry = getDesignShapeEntries(this.model.value.shapes).find(entry => entry.shape.id === id);
		const group = entry?.shape;
		if (group?.kind !== 'group' || group.motion || this.components.isInstanceChild(id)) {
			return [];
		}
		// Uniform group scaling keeps children representable without shear after ungrouping.
		const scale = group.width / group.contentWidth;
		const radians = (group.rotation * Math.PI) / 180;
		// A frame does not scale its contents by itself; removing the group must carry its scale into those contents.
		const scaleFrameChild = (child: DesignShape): DesignShape => {
			const geometry = {
				...child,
				x: child.x * scale,
				y: child.y * scale,
				width: child.width * scale,
				height: child.height * scale,
				...(child.motion
					? {
							motion: {
								...child.motion,
								keyframes: child.motion.keyframes.map(frame => ({
									...frame,
									x: frame.x * scale,
									y: frame.y * scale,
								})),
							},
						}
					: {}),
			};
			if (geometry.kind === 'frame') {
				return { ...geometry, children: geometry.children.map(scaleFrameChild) };
			}
			if (geometry.kind === 'text') {
				return scaleDesignText(geometry, scale);
			}
			if (geometry.kind === 'path') {
				return { ...geometry, strokeWidth: geometry.strokeWidth * scale };
			}
			return geometry;
		};
		const children = group.children.map((child): DesignShape => {
			const dx = (child.x + child.width / 2) * scale - group.width / 2;
			const dy = (child.y + child.height / 2) * scale - group.height / 2;
			const geometry = {
				...child,
				x:
					group.x +
					group.width / 2 +
					dx * Math.cos(radians) -
					dy * Math.sin(radians) -
					(child.width * scale) / 2,
				y:
					group.y +
					group.height / 2 +
					dx * Math.sin(radians) +
					dy * Math.cos(radians) -
					(child.height * scale) / 2,
				width: child.width * scale,
				height: child.height * scale,
				rotation: child.rotation + group.rotation,
			};
			if (child.motion) {
				geometry.motion = {
					...child.motion,
					keyframes: child.motion.keyframes.map(frame => {
						const dx = (frame.x + child.width / 2) * scale - group.width / 2;
						const dy = (frame.y + child.height / 2) * scale - group.height / 2;
						return {
							...frame,
							x:
								group.x +
								group.width / 2 +
								dx * Math.cos(radians) -
								dy * Math.sin(radians) -
								(child.width * scale) / 2,
							y:
								group.y +
								group.height / 2 +
								dx * Math.sin(radians) +
								dy * Math.cos(radians) -
								(child.height * scale) / 2,
							rotation: frame.rotation + group.rotation,
						};
					}),
				};
			}
			if (geometry.kind === 'text') {
				return scaleDesignText(geometry, scale);
			}
			if (geometry.kind === 'path') {
				return { ...geometry, strokeWidth: geometry.strokeWidth * scale };
			}
			if (geometry.kind === 'frame') {
				return { ...geometry, children: geometry.children.map(scaleFrameChild) };
			}
			return geometry;
		});
		this.editSiblings(entry!.parent?.id, shapes => shapes.flatMap(shape => (shape.id === id ? children : [shape])));
		return children.map(child => child.id);
	}

	private editSiblings(
		parentId: string | undefined,
		edit: (shapes: readonly DesignShape[]) => readonly DesignShape[],
	): void {
		const update = (shape: DesignShape): DesignShape => {
			if (shape.kind !== 'frame' && shape.kind !== 'group') {
				return shape;
			}
			return { ...shape, children: shape.id === parentId ? edit(shape.children) : shape.children.map(update) };
		};
		this.model.applyEdit(
			parentId === undefined ? edit(this.model.value.shapes) : this.model.value.shapes.map(update),
		);
	}

	public removeShapes(ids: ReadonlySet<string>): void {
		const removable = new Set([...ids].filter(id => !this.components.isInstanceChild(id)));
		const remove = (shapes: readonly DesignShape[]): readonly DesignShape[] =>
			shapes
				.filter(shape => !removable.has(shape.id))
				.flatMap<DesignShape>(shape => {
					if (shape.kind !== 'frame' && shape.kind !== 'group') {
						return [shape];
					}
					const children = remove(shape.children);
					return shape.kind === 'group' && !children.length ? [] : [{ ...shape, children }];
				});
		this.model.applyEdit(remove(this.model.value.shapes));
	}
}
