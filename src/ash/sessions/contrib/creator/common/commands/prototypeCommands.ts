import { prototypePath, prototypeScrollTargets } from '../model/prototypeScroll.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { flattenDesignShapes, type DesignShape } from '../model/document.js';
import { getDesignLibraryShapes } from '../model/designResources.js';
import type { DesignModel } from '../model/designModel.js';
import {
	defaultPrototypeTransition,
	prototypeVariants,
	prototypeFrames,
	prototypeOwner,
	type PrototypeInteraction,
} from '../model/prototype.js';

/** Wires, hotspot settings and flow names are ordinary immutable document edits. */
export class PrototypeCommands {
	constructor(private readonly model: DesignModel) {}
	public connect(ids: ReadonlySet<string>, destination: string): void {
		const shapes = this.model.value.shapes;
		const isScreen = prototypeFrames(shapes).some(frame => frame.id === destination);
		const sources = [...shapes, ...getDesignLibraryShapes(this.model.value.resources)];
		const updates = new Map<string, DesignShape>();
		const hasFlow = prototypeFrames(shapes).some(frame => frame.flowStart);
		for (const shape of flattenDesignShapes(shapes)) {
			const owner = prototypeOwner(shapes, shape.id);
			if (!ids.has(shape.id) || (shape.interactions?.length ?? 0) >= 100) {
				continue;
			}
			const isScroll = prototypeScrollTargets(shapes, shape.id, false).some(target => target.id === destination);
			const isVariant = prototypeVariants(sources, shape.id).some(frame => frame.id === destination);
			if (!isScroll && !isVariant && (!isScreen || !owner || owner.id === destination)) {
				continue;
			}
			updates.set(shape.id, {
				...shape,
				interactions: [
					...(shape.interactions ?? []),
					{
						id: generateUuid(),
						trigger: 'click',
						actions: [
							{
								action: isScroll ? 'scrollTo' : isVariant ? 'changeTo' : 'navigate',
								destination,
								transition: defaultPrototypeTransition,
							},
						],
					},
				],
			});
			if (!isScroll && !isVariant && owner && !hasFlow && ![...updates.values()].some(shape => shape.flowStart)) {
				updates.set(owner.id, {
					...(updates.get(owner.id) ?? owner),
					flowStart: localize('sessions.design.prototype.defaultFlow', 'Flow 1'),
				});
			}
		}
		this.commit(updates);
	}
	public setScroll(
		id: string,
		settings: Pick<Partial<DesignShape>, 'overflowDirection' | 'scrollPosition' | 'layoutPositioning'>,
	): void {
		const path = prototypePath(this.model.value.shapes, id),
			shape = path.at(-1),
			parent = path.at(-2);
		if (!shape) {
			return;
		}
		const next = { ...shape, ...settings };
		if (
			parent?.kind === 'frame' &&
			parent.autoLayout &&
			next.scrollPosition === 'fixed' &&
			next.layoutPositioning !== 'absolute'
		) {
			next.scrollPosition = 'scroll';
		}
		this.commit(new Map([[id, next]]));
	}
	public setInteractions(id: string, interactions: readonly PrototypeInteraction[]): void {
		const shape = flattenDesignShapes(this.model.value.shapes).find(shape => shape.id === id);
		if (shape) {
			this.commit(new Map([[id, { ...shape, interactions }]]));
		}
	}
	public setFlow(id: string, name: string | undefined): void {
		const shape = prototypeFrames(this.model.value.shapes).find(shape => shape.id === id);
		if (shape) {
			const { flowStart: _flowStart, ...rest } = shape;
			const flowStart = name?.trim().slice(0, 1024);
			this.commit(new Map([[id, { ...rest, ...(flowStart ? { flowStart } : {}) }]]));
		}
	}
	private commit(updates: ReadonlyMap<string, DesignShape>): void {
		const update = (shape: DesignShape): DesignShape => {
			const result = updates.get(shape.id) ?? shape;
			return result.kind === 'frame' || result.kind === 'group'
				? { ...result, children: result.children.map(update) }
				: result;
		};
		this.model.applyEdit(this.model.value.shapes.map(update));
	}
}
