import { isRecord } from '../../../../../base/common/types.js';
import { isUuid } from '../../../../../base/common/uuid.js';
import { readPrototypeExpression, prototypeExpressionType, type PrototypeExpression } from './prototypeExpression.js';
import { getDesignResourceCatalog, type DesignResources } from './designResources.js';
import { localize } from '../../../../../nls.js';
import { flattenDesignShapes, type DesignShape, type DesignShapeGeometry } from './document.js';

export type PrototypeTrigger =
	'click' | 'hover' | 'press' | 'drag' | 'enter' | 'leave' | 'down' | 'up' | 'key' | 'delay';
export type PrototypeAction =
	| 'navigate'
	| 'back'
	| 'overlay'
	| 'swap'
	| 'close'
	| 'url'
	| 'changeTo'
	| 'setVariable'
	| 'setMode'
	| 'conditional'
	| 'scrollTo';
export interface PrototypeTransition {
	readonly type: 'instant' | 'dissolve' | 'smart' | 'moveIn' | 'moveOut' | 'push' | 'slideIn' | 'slideOut' | 'scroll';
	readonly duration: number;
	readonly easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';
	readonly spring?: PrototypeSpring;
	readonly direction: 'left' | 'right' | 'top' | 'bottom';
}
export interface PrototypeSpring {
	readonly mass: number;
	readonly stiffness: number;
	readonly damping: number;
	readonly initialVelocity: number;
}
export interface PrototypeStep {
	readonly action: PrototypeAction;
	readonly destination?: string;
	readonly url?: string;
	readonly resetScroll?: boolean;
	readonly transition: PrototypeTransition;
	readonly overlay?: {
		readonly position: 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
		readonly closeOutside: boolean;
		readonly background: boolean;
	};
	readonly variableId?: string;
	readonly value?: PrototypeExpression;
	readonly collectionId?: string;
	readonly modeId?: string;
	readonly branches?: readonly {
		readonly condition?: PrototypeExpression;
		readonly actions: readonly PrototypeStep[];
	}[];
}
export interface PrototypeInteraction {
	/** IDs are local to the layer, so inherited interactions keep a stable identity. */
	readonly id: string;
	readonly trigger: PrototypeTrigger;
	readonly delay?: number;
	readonly key?: string;
	readonly actions: readonly PrototypeStep[];
}
export const defaultPrototypeSpring: PrototypeSpring = Object.freeze({
	mass: 1,
	stiffness: 100,
	damping: 15,
	initialVelocity: 0,
});
/** All consumers traverse the same action tree, including conditional destinations. */
export function flattenPrototypeActions(actions: readonly PrototypeStep[]): readonly PrototypeStep[] {
	return actions.flatMap(action => [
		action,
		...(action.branches?.flatMap(branch => flattenPrototypeActions(branch.actions)) ?? []),
	]);
}
export function mapPrototypeActions(
	actions: readonly PrototypeStep[],
	map: (action: PrototypeStep) => PrototypeStep | undefined,
): readonly PrototypeStep[] {
	return actions.flatMap(action => {
		const next = map(action);
		return next
			? [
					{
						...next,
						...(next.branches
							? {
									branches: next.branches.map(branch => ({
										...branch,
										actions: mapPrototypeActions(branch.actions, map),
									})),
								}
							: {}),
					},
				]
			: [];
	});
}

export const defaultPrototypeTransition: PrototypeTransition = Object.freeze({
	type: 'instant',
	duration: 300,
	easing: 'easeOut',
	direction: 'left',
});
export type PrototypeFrame = Extract<DesignShape, { kind: 'frame' }>;
export function prototypeFrames(shapes: readonly DesignShape[]): readonly PrototypeFrame[] {
	return shapes.filter((shape): shape is PrototypeFrame => shape.kind === 'frame' && !shape.component);
}
export function prototypeOwner(shapes: readonly DesignShape[], id: string): PrototypeFrame | undefined {
	return prototypeFrames(shapes).find(frame => flattenDesignShapes([frame]).some(shape => shape.id === id));
}
/** A hotspot switches its nearest containing instance, including nested interactive components. */
export function prototypeComponent(shapes: readonly DesignShape[], id: string): PrototypeFrame | undefined {
	const path = (shape: DesignShape): readonly DesignShape[] | undefined => {
		if (shape.id === id) {
			return [shape];
		}
		if (shape.kind === 'frame' || shape.kind === 'group') {
			for (const child of shape.children) {
				const found = path(child);
				if (found) {
					return [shape, ...found];
				}
			}
		}
		return;
	};
	const chain = shapes.map(path).find(Boolean);
	return (
		chain &&
		[...chain]
			.reverse()
			.find(
				(shape): shape is PrototypeFrame =>
					shape.kind === 'frame' && (!!shape.instance || shape.component?.kind === 'main'),
			)
	);
}
export function prototypeVariants(shapes: readonly DesignShape[], id: string): readonly PrototypeFrame[] {
	const component = prototypeComponent(shapes, id);
	const mainId = component?.instance?.componentId ?? component?.id;
	const set = flattenDesignShapes(shapes).find(
		shape =>
			shape.kind === 'frame' &&
			shape.component?.kind === 'set' &&
			shape.children.some(child => child.id === mainId),
	);
	return set?.kind === 'frame'
		? set.children.filter(
				(shape): shape is PrototypeFrame =>
					shape.kind === 'frame' && shape.component?.kind === 'main' && shape.id !== mainId,
			)
		: [];
}
/** Scroll actions stay within one screen, or within their reusable component definition. */
export function prototypeScrollScope(shapes: readonly DesignShape[], id: string): PrototypeFrame | undefined {
	return prototypeOwner(shapes, id) ?? prototypeComponent(shapes, id);
}

export function isPrototypeUrl(value: string): boolean {
	if (/[\r\n\u0000]/u.test(value)) {
		return false;
	}
	try {
		return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

/** File boundary: legacy single actions are migrated once; the model only owns action arrays. */
export function parsePrototypeProperties(
	value: Record<string, unknown>,
): Pick<
	DesignShapeGeometry,
	'interactions' | 'flowStart' | 'overflowDirection' | 'scrollPosition' | 'layoutPositioning'
> {
	const invalid = (): never => {
		throw new TypeError(
			localize('sessions.design.prototype.invalid', 'Invalid prototype interaction or flow starting point.'),
		);
	};
	const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
		Object.keys(value).every(key => keys.includes(key));
	const finite = (value: unknown, min: number, max: number): boolean =>
		typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
	if (
		value.flowStart !== undefined &&
		(value.kind !== 'frame' ||
			typeof value.flowStart !== 'string' ||
			!value.flowStart.trim() ||
			value.flowStart.length > 1024)
	) {
		invalid();
	}
	for (const [key, options] of [
		['overflowDirection', ['none', 'horizontal', 'vertical', 'both']],
		['scrollPosition', ['scroll', 'fixed', 'sticky']],
		['layoutPositioning', ['auto', 'absolute']],
	] as const) {
		if (value[key] !== undefined && !(options as readonly unknown[]).includes(value[key])) {
			invalid();
		}
	}
	if (value.overflowDirection !== undefined && value.kind !== 'frame') {
		invalid();
	}
	let actionCount = 0;
	const parseActions = (value: unknown, depth: number): readonly PrototypeStep[] => {
		if (!Array.isArray(value) || depth > 16 || value.length > 1000) {
			return invalid();
		}
		return value.map(raw => {
			if (
				++actionCount > 1000 ||
				!isRecord(raw) ||
				!only(raw, [
					'action',
					'destination',
					'url',
					'transition',
					'overlay',
					'variableId',
					'value',
					'collectionId',
					'modeId',
					'branches',
					'resetScroll',
				]) ||
				![
					'navigate',
					'back',
					'overlay',
					'swap',
					'close',
					'url',
					'changeTo',
					'setVariable',
					'setMode',
					'conditional',
					'scrollTo',
				].includes(String(raw.action))
			) {
				return invalid();
			}
			const { transition, overlay } = raw;
			if (
				(raw.destination !== undefined && !isUuid(raw.destination)) ||
				(['navigate', 'overlay', 'swap', 'changeTo', 'scrollTo'].includes(String(raw.action)) &&
					!isUuid(raw.destination))
			) {
				invalid();
			}
			if (
				(raw.url !== undefined &&
					(typeof raw.url !== 'string' ||
						raw.url.length > 2048 ||
						(raw.url !== '' && !isPrototypeUrl(raw.url)))) ||
				(raw.action === 'url' && raw.url === undefined)
			) {
				invalid();
			}
			if (
				!isRecord(transition) ||
				!only(transition, ['type', 'duration', 'easing', 'direction', 'spring']) ||
				![
					'instant',
					'dissolve',
					'smart',
					'moveIn',
					'moveOut',
					'push',
					'slideIn',
					'slideOut',
					'scroll',
				].includes(String(transition.type)) ||
				!finite(transition.duration, 1, transition.easing === 'spring' ? 60000 : 10000) ||
				!['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring'].includes(String(transition.easing)) ||
				!['left', 'right', 'top', 'bottom'].includes(String(transition.direction))
			) {
				return invalid();
			}
			if (
				(raw.resetScroll !== undefined &&
					(typeof raw.resetScroll !== 'boolean' ||
						!['navigate', 'overlay', 'swap'].includes(String(raw.action)))) ||
				(raw.action === 'scrollTo'
					? !['instant', 'scroll'].includes(String(transition.type))
					: transition.type === 'scroll')
			) {
				invalid();
			}
			const spring = transition.spring;
			if (
				(spring !== undefined &&
					(!isRecord(spring) ||
						!only(spring, ['mass', 'stiffness', 'damping', 'initialVelocity']) ||
						!finite(spring.mass, 0.1, 100) ||
						!finite(spring.stiffness, 1, 10000) ||
						!finite(spring.damping, 0.1, 1000) ||
						!finite(spring.initialVelocity, -100, 100))) ||
				(transition.easing === 'spring' && spring === undefined)
			) {
				invalid();
			}
			if (
				overlay !== undefined &&
				(!isRecord(overlay) ||
					!only(overlay, ['position', 'closeOutside', 'background']) ||
					!['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'].includes(
						String(overlay.position),
					) ||
					typeof overlay.closeOutside !== 'boolean' ||
					typeof overlay.background !== 'boolean')
			) {
				invalid();
			}
			if (
				(raw.variableId !== undefined && !isUuid(raw.variableId)) ||
				(raw.collectionId !== undefined && !isUuid(raw.collectionId)) ||
				(raw.modeId !== undefined && !isUuid(raw.modeId))
			) {
				invalid();
			}
			if (
				(raw.action === 'setVariable' && (!isUuid(raw.variableId) || raw.value === undefined)) ||
				(raw.action === 'setMode' && (!isUuid(raw.collectionId) || !isUuid(raw.modeId)))
			) {
				invalid();
			}
			const expression = raw.value === undefined ? undefined : readPrototypeExpression(raw.value);
			let branches: PrototypeStep['branches'];
			if (raw.branches !== undefined) {
				if (
					raw.action !== 'conditional' ||
					!Array.isArray(raw.branches) ||
					!raw.branches.length ||
					raw.branches.length > 100
				) {
					return invalid();
				}
				branches = raw.branches.map((branch, index, all) => {
					if (
						!isRecord(branch) ||
						!only(branch, ['condition', 'actions']) ||
						(branch.condition === undefined && (index === 0 || index !== all.length - 1))
					) {
						return invalid();
					}
					return {
						...(branch.condition === undefined
							? {}
							: { condition: readPrototypeExpression(branch.condition) }),
						actions: parseActions(branch.actions, depth + 1),
					};
				});
			} else if (raw.action === 'conditional') {
				invalid();
			}
			return {
				...raw,
				...(expression ? { value: expression } : {}),
				...(branches ? { branches } : {}),
			} as unknown as PrototypeStep;
		});
	};
	let interactions: PrototypeInteraction[] | undefined;
	if (value.interactions !== undefined) {
		if (!Array.isArray(value.interactions) || value.interactions.length > 100) {
			return invalid();
		}
		const ids = new Set<string>();
		interactions = value.interactions.map(raw => {
			if (
				!isRecord(raw) ||
				!only(raw, [
					'id',
					'trigger',
					'actions',
					'action',
					'destination',
					'delay',
					'key',
					'url',
					'transition',
					'overlay',
				])
			) {
				return invalid();
			}
			if (
				!isUuid(raw.id) ||
				ids.has(raw.id) ||
				!['click', 'hover', 'press', 'drag', 'enter', 'leave', 'down', 'up', 'key', 'delay'].includes(
					String(raw.trigger),
				)
			) {
				return invalid();
			}
			ids.add(raw.id);
			if (
				(raw.delay !== undefined && !finite(raw.delay, 1, 60000)) ||
				(raw.trigger === 'delay' && raw.delay === undefined)
			) {
				invalid();
			}
			if (
				(raw.key !== undefined && (typeof raw.key !== 'string' || !raw.key || raw.key.length > 64)) ||
				(raw.trigger === 'key' && raw.key === undefined)
			) {
				invalid();
			}
			const { id, trigger, delay, key, actions, ...legacy } = raw;
			if (actions !== undefined && Object.keys(legacy).length) {
				invalid();
			}
			actionCount = 0;
			const parsed = parseActions(actions ?? [legacy], 0);
			if (!parsed.length) {
				invalid();
			}
			return {
				id,
				trigger,
				...(delay === undefined ? {} : { delay }),
				...(key === undefined ? {} : { key }),
				actions: parsed,
			} as PrototypeInteraction;
		});
	}
	return {
		...Object.fromEntries(
			['overflowDirection', 'scrollPosition', 'layoutPositioning']
				.filter(key => value[key] !== undefined)
				.map(key => [key, value[key]]),
		),
		...(interactions ? { interactions } : {}),
		...(value.flowStart === undefined ? {} : { flowStart: value.flowStart as string }),
	};
}

export function validatePrototypeExpressions(shapes: readonly DesignShape[], resources?: DesignResources): void {
	const catalog = getDesignResourceCatalog(resources);
	for (const shape of flattenDesignShapes(shapes)) {
		for (const interaction of shape.interactions ?? []) {
			for (const action of flattenPrototypeActions(interaction.actions)) {
				const invalid = (): never => {
					throw new TypeError(
						localize(
							'sessions.design.prototype.invalidExpression',
							'Enter a valid expression with compatible values and operators.',
						),
					);
				};
				if (action.action === 'setVariable') {
					const type = prototypeExpressionType(action.value!, catalog.variables),
						variable = catalog.variables.find(item => item.id === action.variableId);
					if (
						type &&
						variable &&
						type !== variable.type &&
						!(
							variable.type === 'color' &&
							type === 'string' &&
							action.value!.kind === 'literal' &&
							/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(String(action.value!.value))
						)
					) {
						invalid();
					}
				}
				for (const branch of action.branches ?? []) {
					if (branch.condition) {
						const type = prototypeExpressionType(branch.condition, catalog.variables);
						if (type && type !== 'boolean') {
							invalid();
						}
					}
				}
			}
		}
	}
}

/** Deleting a target removes its wires in the same undo entry. Missing library targets stay inert. */
export function reconcilePrototypeLinks(
	shapes: readonly DesignShape[],
	previous: readonly DesignShape[],
): readonly DesignShape[] {
	const roots = new Set(prototypeFrames(shapes).map(shape => shape.id));
	const targets = new Set([
		...roots,
		...flattenDesignShapes(shapes)
			.filter(shape => shape.kind === 'frame' && shape.component?.kind === 'main')
			.map(shape => shape.id),
	]);
	const removed = new Set(
		flattenDesignShapes(previous)
			.filter(
				shape =>
					shape.kind === 'frame' &&
					(!shape.component || shape.component.kind === 'main') &&
					!targets.has(shape.id),
			)
			.map(shape => shape.id),
	);
	const currentIds = new Set(flattenDesignShapes(shapes).map(shape => shape.id));
	const removedLayers = new Set(
		flattenDesignShapes(previous)
			.filter(shape => !currentIds.has(shape.id))
			.map(shape => shape.id),
	);
	const update = (shape: DesignShape): DesignShape => {
		let result = shape;
		if (shape.interactions) {
			const scope = prototypeScrollScope(shapes, shape.id),
				allowed = new Set(
					scope ? flattenDesignShapes([scope]).flatMap(shape => [shape.id, shape.sourceId]) : [],
				);
			result = {
				...result,
				interactions: shape.interactions
					.map(interaction => ({
						...interaction,
						actions: mapPrototypeActions(interaction.actions, action => {
							if (!action.destination) {
								return action;
							}
							if ((action.action === 'scrollTo' ? removedLayers : removed).has(action.destination)) {
								return;
							}
							// Reparenting a target to another screen also removes the wire in this history entry.
							return action.action === 'scrollTo' &&
								currentIds.has(action.destination) &&
								!allowed.has(action.destination)
								? undefined
								: action;
						}),
					}))
					.filter(interaction => interaction.actions.length),
			};
		}
		if (shape.flowStart && !roots.has(shape.id)) {
			const { flowStart: _flowStart, ...rest } = result;
			result = rest;
		}
		return result.kind === 'frame' || result.kind === 'group'
			? { ...result, children: result.children.map(update) }
			: result;
	};
	return shapes.map(update);
}
