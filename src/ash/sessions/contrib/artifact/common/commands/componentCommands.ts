import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { canvasBounds } from '../../../canvas/common/canvasGeometry.js';
import { getArtifactCanvasOverrideFields, getArtifactCanvasOverrideValue, copyArtifactCanvasOverride, flattenArtifactCanvasShapes, type ArtifactCanvasOverride, type ArtifactCanvasShape } from '../model/artifactCanvasDocument.js';
import type { ArtifactCanvasModel } from '../model/artifactCanvasModel.js';
import { detachArtifactCanvasInstance, remapArtifactCanvasInstance, resetArtifactCanvasOverrides } from '../model/components.js';
import { getArtifactCanvasLibraryShapes } from '../model/artifactCanvasResources.js';
import { getArtifactCanvasShapeEntries } from '../model/hitTest.js';

type Frame = Extract<ArtifactCanvasShape, { kind: 'frame'; }>;

/** Component operations share the document model's single commit, inheritance and undo boundary. */
export class ComponentCommands {
	constructor(private readonly model: ArtifactCanvasModel) { }
	private get shapes(): readonly ArtifactCanvasShape[] { return this.model.value.shapes; }
	public isLocal(id: string): boolean { return flattenArtifactCanvasShapes(this.shapes).some(shape => shape.id === id); }
	private get sources(): readonly ArtifactCanvasShape[] { return [...this.shapes, ...getArtifactCanvasLibraryShapes(this.model.value.resources)]; }
	private find(id: string): ArtifactCanvasShape | undefined { return flattenArtifactCanvasShapes(this.sources).find(shape => shape.id === id); }
	public get mains(): readonly Frame[] { return flattenArtifactCanvasShapes([...this.shapes, ...getArtifactCanvasLibraryShapes(this.model.value.resources, true)]).filter((shape): shape is Frame => shape.kind === 'frame' && shape.component?.kind === 'main'); }
	public getInstance(id: string): Frame | undefined {
		const entries = getArtifactCanvasShapeEntries(this.shapes);
		const entry = entries.find(entry => entry.shape.id === id);
		if (!entry) { return undefined; }
		return [entry.shape, ...[...entry.ancestors].reverse().map(id => this.find(id)!)].find((shape): shape is Frame => shape.kind === 'frame' && !!shape.instance);
	}
	public isInstanceChild(id: string): boolean {
		return getArtifactCanvasShapeEntries(this.shapes).find(entry => entry.shape.id === id)?.ancestors.some(id => { const shape = this.find(id); return shape?.kind === 'frame' && !!shape.instance; }) ?? false;
	}
	public getSet(id: string): Frame | undefined {
		const shape = this.find(id);
		if (shape?.kind === 'frame' && shape.component?.kind === 'set') { return shape; }
		return flattenArtifactCanvasShapes(this.sources).find((shape): shape is Frame => shape.kind === 'frame' && shape.component?.kind === 'set' && shape.children.some(child => child.id === id));
	}
	public getMain(id: string): Frame | undefined {
		const instance = this.getInstance(id);
		const source = instance?.instance ? this.find(instance.instance.componentId) : this.find(id);
		return source?.kind === 'frame' && source.component?.kind === 'main' ? source : undefined;
	}
	private replace(updates: ReadonlyMap<string, ArtifactCanvasShape>, roots: readonly ArtifactCanvasShape[] = this.shapes): readonly ArtifactCanvasShape[] {
		const visit = (shape: ArtifactCanvasShape): ArtifactCanvasShape => {
			const updated = updates.get(shape.id) ?? shape;
			return updated.kind === 'frame' || updated.kind === 'group' ? { ...updated, children: updated.children.map(visit) } : updated;
		};
		return roots.map(visit);
	}
	private siblings(parentId: string | undefined, edit: (siblings: readonly ArtifactCanvasShape[]) => readonly ArtifactCanvasShape[]): readonly ArtifactCanvasShape[] {
		if (!parentId) { return edit(this.shapes); }
		const parent = this.find(parentId);
		return parent?.kind === 'frame' || parent?.kind === 'group' ? this.replace(new Map([[parentId, { ...parent, children: edit(parent.children) }]])) : this.shapes;
	}
	public canCreate(ids: ReadonlySet<string>): boolean {
		const entries = getArtifactCanvasShapeEntries(this.shapes).filter(entry => ids.has(entry.shape.id));
		return entries.length > 0 && entries.every(entry => entry.parent?.id === entries[0].parent?.id && !this.isInstanceChild(entry.shape.id) && !(entry.shape.kind === 'frame' && (entry.shape.component || entry.shape.instance))) && (entries[0].parent?.kind !== 'frame' || entries[0].parent.component?.kind !== 'set');
	}
	public create(ids: ReadonlySet<string>): string | undefined {
		if (!this.canCreate(ids)) { return undefined; }
		const entries = getArtifactCanvasShapeEntries(this.shapes).filter(entry => ids.has(entry.shape.id));
		const first = entries[0].shape;
		if (entries.length === 1 && first.kind === 'frame') {
			this.model.applyEdit(this.replace(new Map([[first.id, { ...first, component: { kind: 'main' } }]])));
			return first.id;
		}
		const bounds = canvasBounds(entries.map(entry => entry.shape));
		const frame: Frame = { ...bounds, id: generateUuid(), kind: 'frame', name: first.name || localize('sessions.design.component', 'Component'), fill: '#ffffff00', rotation: 0, clip: false, component: { kind: 'main' }, children: entries.map(entry => shift(entry.shape, -bounds.x, -bounds.y)) };
		this.model.applyEdit(this.siblings(entries[0].parent?.id, shapes => shapes.flatMap(shape => shape.id === entries.at(-1)!.shape.id ? [frame] : ids.has(shape.id) ? [] : [shape])));
		return frame.id;
	}
	public makeInstance(source: Frame): Frame {
		const { component: _component, sourceId: _source, overrides: _overrides, ...frame } = source;
		return { ...frame, id: generateUuid(), instance: { componentId: source.id }, children: [] };
	}
	public createInstance(id: string): string | undefined {
		let source = this.find(id);
		if (source?.kind === 'frame' && source.component?.kind === 'set') { source = [...source.children].sort((a, b) => a.y - b.y || a.x - b.x)[0]; }
		if (source?.kind !== 'frame' || source.component?.kind !== 'main') { return undefined; }
		const anchor = this.getSet(source.id) ?? source;
		const world = getArtifactCanvasShapeEntries(this.shapes).find(entry => entry.shape.id === anchor.id)?.world ?? { x: 40, y: 0, width: source.width, height: 0 };
		const instance = { ...this.makeInstance(source), x: world.x, y: world.y + world.height + 40 };
		this.model.applyEdit([...this.shapes, instance]);
		return instance.id;
	}
	public reset(id: string, field?: ArtifactCanvasOverride): void {
		const shape = this.find(id);
		if (!shape || !this.getInstance(id)) { return; }
		this.model.applyEdit(this.replace(new Map([[id, resetArtifactCanvasOverrides(shape, field)]])));
	}
	public detach(id: string): void {
		const instance = this.find(id);
		if (instance?.kind !== 'frame' || !instance.instance || this.isInstanceChild(id)) { return; }
		this.model.applyEdit(this.replace(new Map([[id, detachArtifactCanvasInstance(instance, this.sources)]])));
	}
	public canSwap(id: string, componentId: string): boolean {
		const instance = this.find(id); const main = this.find(componentId);
		if (instance?.kind !== 'frame' || !instance.instance || main?.kind !== 'frame' || main.component?.kind !== 'main') { return false; }
		const contains = (node: ArtifactCanvasShape, seen: Set<string>): boolean => {
			if (node.id === id) { return true; }
			if (seen.has(node.id)) { return false; } seen.add(node.id);
			if (node.kind === 'frame' && node.instance) { const source = this.find(node.instance.componentId); if (source && contains(source, seen)) { return true; } }
			return (node.kind === 'frame' || node.kind === 'group') && node.children.some(child => contains(child, seen));
		};
		return !contains(main, new Set());
	}
	public swap(id: string, componentId: string): void {
		if (!this.canSwap(id, componentId)) { return; }
		const instance = this.find(id) as Frame; const main = this.find(componentId) as Frame;
		const previous = this.getMain(id);
		const set = this.getSet(main.id);
		const inheritedSource = instance.sourceId ? this.find(instance.sourceId) : undefined;
		let updated = remapArtifactCanvasInstance(instance, main, inheritedSource?.kind === 'frame' ? inheritedSource : previous, !!set && !!previous && this.getSet(previous.id)?.id === set.id);
		if (this.isInstanceChild(id)) { updated = { ...updated, overrides: [...new Set([...(updated.overrides ?? []), 'instance' as const])] }; }
		this.model.applyEdit(this.replace(new Map([[id, updated]])));
	}
	public canPush(id: string): boolean { return !!this.pushEdits(id); }
	public push(id: string): void {
		const shapes = this.pushEdits(id);
		if (shapes) { this.model.applyEdit(shapes); }
	}
	private pushEdits(id: string): readonly ArtifactCanvasShape[] | undefined {
		const instance = this.find(id); const main = this.getMain(id);
		if (instance?.kind !== 'frame' || !instance.instance || !main || !this.isLocal(main.id) || this.isInstanceChild(id)) { return; }
		if (getArtifactCanvasShapeEntries(this.shapes).find(entry => entry.shape.id === main.id)?.ancestors.some(id => { const shape = this.find(id); return shape?.kind === 'frame' && shape.component?.kind === 'main'; })) { return; }
		const push = (node: ArtifactCanvasShape, source: ArtifactCanvasShape): ArtifactCanvasShape => {
			const next = { ...source };
			for (const field of node.overrides ?? []) { copyArtifactCanvasOverride(next, node, field); }
			if ((node.kind === 'frame' || node.kind === 'group') && (next.kind === 'frame' || next.kind === 'group')) {
				if (node.kind === 'frame' && node.instance && node.overrides?.includes('instance')) {
					// Push a nested swap into this main's instance, never into the newly
					// referenced component. Its children already refer to that new source.
					return { ...next, children: node.children.map(clone) };
				}
				return { ...next, children: next.children.map(child => { const override = node.children.find(layer => layer.sourceId === child.id); return override ? push(override, child) : child; }) };
			}
			return next;
		};
		const updates = new Map([[main.id, push(instance, main)], [id, resetArtifactCanvasOverrides(instance)]]);
		const shapes = this.replace(updates);
		// A nested swap can be valid in an instance but recursive when pushed into
		// its definition. Check the proposed graph before crossing the history boundary.
		return hasCycle(shapes) ? undefined : shapes;
	}
	public restore(id: string): string | undefined {
		const instance = this.find(id);
		if (instance?.kind !== 'frame' || !instance.instance || this.find(instance.instance.componentId)) { return undefined; }
		const used = new Set(flattenArtifactCanvasShapes(this.shapes).map(shape => shape.id));
		const restore = (node: ArtifactCanvasShape, root = false): ArtifactCanvasShape => {
			const { sourceId, overrides: _overrides, ...rest } = node;
			const next = { ...rest, id: root ? instance.instance!.componentId : sourceId && !used.has(sourceId) ? sourceId : generateUuid() };
			used.add(next.id);
			if (next.kind === 'frame') {
				if (!root && next.instance) {
					const source = this.find(next.instance.componentId);
					const recovered = { ...next, children: next.children.map(child => clone(child)) };
					return source?.kind === 'frame' ? recoverNestedInstance(recovered, source) : recovered;
				}
				const { instance: _instance, ...frame } = next;
				return { ...frame, children: frame.children.map(child => restore(child)), ...(root ? { component: { kind: 'main' as const }, x: instance.x - instance.width - 40 } : {}) };
			}
			return next.kind === 'group' ? { ...next, children: next.children.map(child => restore(child)) } : next;
		};
		const main = restore(instance, true);
		this.model.applyEdit([...this.shapes, main]);
		return main.id;
	}
	public canCombine(ids: ReadonlySet<string>): boolean {
		const entries = getArtifactCanvasShapeEntries(this.shapes).filter(entry => ids.has(entry.shape.id));
		return entries.length > 1 && entries.every(entry => entry.parent?.id === entries[0].parent?.id && entry.shape.kind === 'frame' && entry.shape.component?.kind === 'main' && !this.getSet(entry.shape.id) && !this.isInstanceChild(entry.shape.id));
	}
	public combine(ids: ReadonlySet<string>): string | undefined {
		if (!this.canCombine(ids)) { return undefined; }
		const entries = getArtifactCanvasShapeEntries(this.shapes).filter(entry => ids.has(entry.shape.id));
		const set = makeSet(entries.map(entry => entry.shape as Frame));
		this.model.applyEdit(this.siblings(entries[0].parent?.id, shapes => shapes.flatMap(shape => shape.id === entries.at(-1)!.shape.id ? [set] : ids.has(shape.id) ? [] : [shape])));
		return set.id;
	}
	public addVariant(id: string): string | undefined {
		const set = this.getSet(id);
		const source = this.find(id);
		const main = source?.kind === 'frame' && source.component?.kind === 'main' ? source : set?.children[0];
		if (main?.kind !== 'frame' || main.component?.kind !== 'main') { return undefined; }
		let copy = clone(main) as Frame;
		if (set?.component?.kind === 'set') {
			const property = set.component.properties[0];
			let suffix = set.children.length + 1;
			const value = (): string => localize('sessions.design.variantNumber', 'Variant {0}', suffix);
			while (set.children.some(child => child.kind === 'frame' && child.component?.kind === 'main' && child.component.variant?.[property] === value())) { suffix++; }
			copy = { ...copy, x: Math.max(0, ...set.children.map(child => child.x + child.width)) + 24, y: 24, component: { kind: 'main', variant: { ...main.component.variant, [property]: value() } } };
			this.model.applyEdit(this.replace(new Map([[set.id, { ...set, width: copy.x + copy.width + 24, height: Math.max(set.height, copy.height + 48), children: [...set.children, copy] }]])));
		} else {
			copy = shift(copy, main.width + 24, 0) as Frame;
			const container = makeSet([main, copy]);
			const parentId = getArtifactCanvasShapeEntries(this.shapes).find(entry => entry.shape.id === main.id)?.parent?.id;
			this.model.applyEdit(this.siblings(parentId, shapes => shapes.map(shape => shape.id === main.id ? container : shape)));
		}
		return copy.id;
	}
	public setProperties(id: string, properties: readonly string[], renamed?: readonly [string, string]): boolean {
		const set = this.getSet(id);
		if (set?.component?.kind !== 'set' || properties.length < 1 || properties.length > 32 || new Set(properties).size !== properties.length || properties.some(name => !name.trim() || name.length > 256)) { return false; }
		const children = set.children.map(child => {
			const main = child as Frame;
			const values = main.component?.kind === 'main' ? main.component.variant ?? {} : {};
			return { ...main, component: { kind: 'main' as const, variant: Object.fromEntries(properties.map(property => [property, values[renamed?.[1] === property ? renamed[0] : property] ?? localize('sessions.design.defaultVariantValue', 'Default')])) } };
		});
		const keys = children.map(child => JSON.stringify(properties.map(property => child.component.variant[property])));
		if (new Set(keys).size !== keys.length) { return false; }
		this.model.applyEdit(this.replace(new Map([[set.id, { ...set, component: { kind: 'set', properties }, children }]])));
		return true;
	}
	public setVariantValue(id: string, property: string, value: string): boolean {
		const main = this.find(id); const set = this.getSet(id);
		if (main?.kind !== 'frame' || main.component?.kind !== 'main' || set?.component?.kind !== 'set' || !set.component.properties.includes(property) || !value.trim() || value.length > 256) { return false; }
		const variant = { ...main.component.variant, [property]: value };
		if (set.children.some(child => child.id !== id && child.kind === 'frame' && child.component?.kind === 'main' && set.component?.kind === 'set' && set.component.properties.every(key => child.component?.kind === 'main' && child.component.variant?.[key] === variant[key]))) { return false; }
		this.model.applyEdit(this.replace(new Map([[id, { ...main, component: { kind: 'main', variant } }]])));
		return true;
	}
	public selectVariant(id: string, property: string, value: string): void {
		const main = this.getMain(id); const set = main ? this.getSet(main.id) : undefined;
		if (!main || set?.component?.kind !== 'set') { return; }
		const values = main.component?.kind === 'main' ? main.component.variant : undefined;
		const candidates = set.children.filter((child): child is Frame => child.kind === 'frame' && child.component?.kind === 'main' && child.component.variant?.[property] === value);
		const score = (child: Frame): number => Object.entries(values ?? {}).filter(([key, value]) => child.component?.kind === 'main' && child.component.variant?.[key] === value).length;
		candidates.sort((a, b) => score(b) - score(a));
		if (candidates[0]) { this.swap(id, candidates[0].id); }
	}
}

function shift(shape: ArtifactCanvasShape, dx: number, dy: number): ArtifactCanvasShape {
	return { ...shape, x: shape.x + dx, y: shape.y + dy, ...(shape.motion ? { motion: { ...shape.motion, keyframes: shape.motion.keyframes.map(frame => ({ ...frame, x: frame.x + dx, y: frame.y + dy })) } } : {}) };
}
function clone(shape: ArtifactCanvasShape): ArtifactCanvasShape {
	const copy = { ...shape, id: generateUuid() };
	return copy.kind === 'frame' || copy.kind === 'group' ? { ...copy, children: copy.children.map(clone) } : copy;
}
/** An orphan snapshot has outer source IDs whose objects were deleted. Recover
 * nested links against the surviving inner main, preserving the snapshot's appearance.
 */
function recoverNestedInstance(instance: Frame, source: Frame): Frame {
	const recover = (node: ArtifactCanvasShape, target: ArtifactCanvasShape, root = false): ArtifactCanvasShape => {
		const overrides = getArtifactCanvasOverrideFields(node, target).filter(field => !(root && field === 'instance') && !(node.kind === 'text' && (field === 'width' || field === 'height')) && JSON.stringify(getArtifactCanvasOverrideValue(node, field)) !== JSON.stringify(getArtifactCanvasOverrideValue(target, field)));
		const result = { ...node, overrides, ...(root ? {} : { sourceId: target.id }) };
		if ((result.kind === 'frame' || result.kind === 'group') && (target.kind === 'frame' || target.kind === 'group')) {
			const remaining = [...result.children];
			return {
				...result, children: target.children.flatMap(child => {
					let index = remaining.findIndex(node => node.kind === child.kind && node.name === child.name);
					if (index < 0) { index = remaining.findIndex(node => node.kind === child.kind); }
					return index < 0 ? [] : [recover(remaining.splice(index, 1)[0], child)];
				})
			};
		}
		return result;
	};
	return recover(instance, source, true) as Frame;
}
function hasCycle(shapes: readonly ArtifactCanvasShape[]): boolean {
	const objects = new Map(flattenArtifactCanvasShapes(shapes).map(shape => [shape.id, shape]));
	const active = new Set<string>(); const done = new Set<string>();
	const visit = (shape: ArtifactCanvasShape): boolean => {
		if (active.has(shape.id)) { return true; }
		if (done.has(shape.id)) { return false; }
		active.add(shape.id);
		if (shape.kind === 'frame' && shape.instance) { const source = objects.get(shape.instance.componentId); if (source && visit(source)) { return true; } }
		if ((shape.kind === 'frame' || shape.kind === 'group') && shape.children.some(visit)) { return true; }
		active.delete(shape.id); done.add(shape.id); return false;
	};
	return shapes.some(visit);
}
function makeSet(components: readonly Frame[]): Frame {
	const bounds = canvasBounds(components);
	const property = localize('sessions.design.variantProperty', 'State');
	return { ...bounds, id: generateUuid(), name: components[0].name || localize('sessions.design.componentSet', 'Component set'), kind: 'frame', rotation: 0, fill: '#ffffff00', clip: false, width: bounds.width + 48, height: bounds.height + 48, component: { kind: 'set', properties: [property] }, children: components.map((main, index) => ({ ...shift(main, 24 - bounds.x, 24 - bounds.y) as Frame, component: { kind: 'main', variant: { [property]: localize('sessions.design.variantNumber', 'Variant {0}', index + 1) } } })) };
}
