import type { DesignTextMeasurer } from './designText.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { getDesignOverrideFields, getDesignOverrideValue, copyDesignOverride, flattenDesignShapes, type DesignOverride, type DesignShape } from './document.js';
import { designStyleFields } from './designResources.js';
import { resolveDesignLayout } from './layout.js';

type Frame = Extract<DesignShape, { kind: 'frame' }>;
const placement = ['x', 'y', 'rotation', 'constraints', 'sizing', 'gridCell', 'layoutPositioning', 'scrollPosition'] as const;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Capture direct edits before layout changes derived geometry. Explicit reset/swap commands supply their own override list. */
export function recordDesignOverrides(shapes: readonly DesignShape[], previous: readonly DesignShape[]): readonly DesignShape[] {
	const before = new Map(flattenDesignShapes(previous).map(shape => [shape.id, shape]));
	const visit = (shape: DesignShape, inherited: boolean): DesignShape => {
		const old = before.get(shape.id);
		const root = shape.kind === 'frame' && !!shape.instance;
		let updated = shape;
		if ((inherited || root) && old && shape.overrides === old.overrides) {
			const overrides = new Set(shape.overrides);
			for (const field of getDesignOverrideFields(shape, old)) {
				if (shape.kind === 'text' && (field === 'width' || field === 'height')) {
					continue;
				}
				if (!same(getDesignOverrideValue(shape, field), getDesignOverrideValue(old, field))) {
					overrides.add(field);
				}
			}
			if (overrides.size) {
				updated = { ...shape, overrides: [...overrides] };
			}
		}
		return updated.kind === 'frame' || updated.kind === 'group' ? { ...updated, children: updated.children.map(child => visit(child, inherited || root)) } : updated;
	};
	return shapes.map(shape => visit(shape, false));
}

/** The main tree owns inherited values; instance objects own only placement and listed overrides.
 * Materialized children keep stable IDs for selection, undo, orphan recovery, canvas and exports.
 */
export function resolveDesignComponents(shapes: readonly DesignShape[], libraryShapes: readonly DesignShape[] = [], measureText?: DesignTextMeasurer): readonly DesignShape[] {
	const objects = new Map(flattenDesignShapes([...shapes, ...libraryShapes]).map(shape => [shape.id, shape]));
	const cache = new Map<string, DesignShape>();
	const active = new Set<string>();
	const resolve = (shape: DesignShape): DesignShape => {
		const cached = cache.get(shape.id);
		if (cached) {
			return cached;
		}
		if (active.has(shape.id)) {
			throw new TypeError(localize('sessions.design.componentCycle', 'A component cannot contain an instance of itself.'));
		}
		active.add(shape.id);
		let result = shape;
		if (shape.kind === 'frame' && shape.instance) {
			const main = objects.get(shape.instance.componentId);
			if (main?.kind === 'frame' && main.component?.kind === 'main') {
				const source = resolve(main) as Frame;
				result = inherit(source, shape, true);
				// Free-frame constraints are relative to the source dimensions, not the
				// instance's last rendered bounds. This avoids cumulative resize drift.
				result = resolveDesignLayout([result], [{ ...result, width: source.width, height: source.height }], measureText)[0];
			}
		} else if (shape.kind === 'frame' || shape.kind === 'group') {
			result = { ...shape, children: shape.children.map(resolve) };
			result = resolveDesignLayout([result], [shape], measureText)[0];
		}
		active.delete(shape.id);
		cache.set(shape.id, result);
		return result;
	};
	const inherit = (source: DesignShape, previous: DesignShape | undefined, root = false): DesignShape => {
		const compatible = previous?.kind === source.kind ? previous : undefined;
		const overrides = compatible?.overrides ?? [];
		const result = { ...source, id: previous?.id ?? generateUuid() } as DesignShape;
		Reflect.deleteProperty(result, 'component');
		Reflect.deleteProperty(result, 'sourceId');
		Reflect.deleteProperty(result, 'overrides');
		if (root && previous?.kind === 'frame') {
			Reflect.set(result, 'instance', previous.instance);
			// A flow starts at this placed screen, independently of its component definition.
			if (previous.flowStart) {
				Reflect.set(result, 'flowStart', previous.flowStart);
			} else {
				Reflect.deleteProperty(result, 'flowStart');
			}
			for (const field of placement) {
				if (Reflect.has(previous, field)) {
					Reflect.set(result, field, Reflect.get(previous, field));
				} else {
					Reflect.deleteProperty(result, field);
				}
			}
			if (previous.sourceId) {
				Reflect.set(result, 'sourceId', previous.sourceId);
			}
		} else {
			Reflect.set(result, 'sourceId', source.id);
		}
		if (overrides.length) {
			Reflect.set(result, 'overrides', overrides);
		}
		for (const field of overrides) {
			copyDesignOverride(result, compatible!, field);
		}
		const bindings = { ...result.bindings };
		const styles = { ...result.styleBindings };
		for (const field of overrides) {
			if (!overrides.includes('bindings')) {
				const properties =
					field === 'autoLayout'
						? ['gap', 'crossGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
						: field === 'sizeLimits'
							? ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']
							: [field];
				for (const property of properties) {
					if (!(overrides as readonly string[]).includes(`bindings:${property}`)) {
						Reflect.deleteProperty(bindings, property);
					}
				}
			}
			if (!overrides.includes('styleBindings')) {
				for (const [kind, fields] of Object.entries(designStyleFields)) {
					if ((fields as readonly string[]).includes(field) && !(overrides as readonly string[]).includes(`styleBindings:${kind}`)) {
						Reflect.deleteProperty(styles, kind);
					}
				}
			}
		}
		if (result.bindings) {
			Reflect.set(result, 'bindings', bindings);
		}
		if (result.styleBindings) {
			Reflect.set(result, 'styleBindings', styles);
		}
		if (result.kind === 'frame' || result.kind === 'group') {
			const oldChildren = compatible?.kind === 'frame' || compatible?.kind === 'group' ? compatible.children : [];
			if (!root && result.kind === 'frame' && result.instance && overrides.includes('instance')) {
				// An explicit nested swap starts a new source tree. Otherwise every
				// descendant inherits from its peer in the outer main, including that
				// main's nested overrides, rather than bypassing it to the inner main.
				return resolve({ ...result, children: oldChildren });
			}
			const bySource = new Map(oldChildren.map(child => [child.sourceId, child]));
			return {
				...result,
				children: (source as Frame).children.map(child => inherit(child, bySource.get(child.id))),
			};
		}
		return result;
	};
	return shapes.map(resolve);
}

/** Match structural peers by name and kind, including duplicate-name occurrence, when swapping variants. */
export function remapDesignInstance(instance: Frame, source: Frame, previousSource?: Frame, variant = false): Frame {
	const match = (current: DesignShape, target: DesignShape, oldSource?: DesignShape, root = false): DesignShape => {
		// Variant-specific styles take precedence when their original values differ.
		// Text content, interactions and explicit instance sizing remain user intent across variants.
		const overrides = (current.overrides ?? []).filter(
			field =>
				!variant ||
				!oldSource ||
				field === 'text' ||
				(field === 'textRuns' && current.overrides?.includes('text')) ||
				field === 'name' ||
				field === 'instance' ||
				field === 'interactions' ||
				(root && (field === 'width' || field === 'height')) ||
				same(getDesignOverrideValue(oldSource, field), getDesignOverrideValue(target, field)),
		);
		let result = { ...current, sourceId: target.id, overrides };
		if (root) {
			const { sourceId: _source, ...rest } = result;
			result = { ...rest, ...(current.sourceId ? { sourceId: current.sourceId } : {}) } as typeof result;
		}
		if ((current.kind === 'frame' || current.kind === 'group') && (target.kind === 'frame' || target.kind === 'group')) {
			const oldLayers = oldSource?.kind === 'frame' || oldSource?.kind === 'group' ? oldSource.children : [];
			const remaining = [...current.children];
			const children = target.children.flatMap(child => {
				const index = remaining.findIndex(candidate => {
					const original = oldLayers.find(layer => layer.id === candidate.sourceId) ?? candidate;
					return original.kind === child.kind && (original.name ?? original.kind) === (child.name ?? child.kind);
				});
				if (index < 0) {
					return [];
				}
				const old = remaining.splice(index, 1)[0];
				return [
					match(
						old,
						child,
						oldLayers.find(layer => layer.id === old.sourceId),
					),
				];
			});
			result = { ...result, children } as typeof result;
		}
		return result;
	};
	return { ...(match(instance, source, previousSource, true) as Frame), instance: { componentId: source.id } };
}

export function detachDesignInstance(shape: Frame, shapes: readonly DesignShape[]): Frame {
	const objects = new Map(flattenDesignShapes(shapes).map(node => [node.id, node]));
	const unwrap = (node: DesignShape): DesignShape => {
		const source = node.sourceId ? objects.get(node.sourceId) : undefined;
		const { sourceId: _source, ...rest } = node;
		const updated = {
			...rest,
			...(source?.sourceId ? { sourceId: source.sourceId } : {}),
			overrides: [...new Set([...(source?.overrides ?? []), ...(node.overrides ?? [])])],
		};
		return updated.kind === 'frame' || updated.kind === 'group' ? { ...updated, children: updated.children.map(unwrap) } : updated;
	};
	const detach = (node: DesignShape, root: boolean): DesignShape => {
		const { sourceId: _source, overrides: _overrides, ...rest } = node;
		if (!root && rest.kind === 'frame' && rest.instance) {
			const source = node.sourceId ? objects.get(node.sourceId) : undefined;
			return {
				...rest,
				overrides: [...new Set([...(source?.overrides ?? []), ...(node.overrides ?? [])])].filter(field => field !== 'instance'),
				children: node.overrides?.includes('instance') ? rest.children : rest.children.map(unwrap),
			};
		}
		if (rest.kind === 'frame') {
			const { instance: _instance, ...frame } = rest;
			return { ...frame, children: frame.children.map(child => detach(child, false)) };
		}
		if (rest.kind === 'group') {
			return { ...rest, children: rest.children.map(child => detach(child, false)) };
		}
		return rest;
	};
	return detach(shape, true) as Frame;
}

export function resetDesignOverrides(shape: DesignShape, field?: DesignOverride): DesignShape {
	const updated = {
		...shape,
		overrides: field ? (shape.overrides ?? []).filter(value => value !== field && !(field === 'text' && value === 'textRuns')) : [],
	};
	return updated.kind === 'frame' || updated.kind === 'group' ? { ...updated, children: updated.children.map(child => resetDesignOverrides(child, field)) } : updated;
}
