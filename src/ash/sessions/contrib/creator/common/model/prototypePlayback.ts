import type { DesignTextMeasurer } from './designText.js';
import { applyPrototypeScroll, prototypePath, prototypeScrollVector, prototypeScrollFrames, prototypeScrollOffset, prototypeScrollRange, prototypeScrollTo, prototypeVisibleShapes, type PrototypeScrollPositions } from './prototypeScroll.js';
import type { DesignPoint } from '../core/geometry.js';
import { evaluatePrototypeExpression, type PrototypeValue } from './prototypeExpression.js';
import { resolveDesignLayout } from './layout.js';
import { flattenDesignShapes, type DesignShape } from './document.js';
import { remapDesignInstance, resolveDesignComponents } from './components.js';
import { emptyDesignResources, getDesignResourceCatalog, resolveDesignVariable, getDesignLibraryShapes, resolveDesignResources, type DesignResources } from './designResources.js';
import { prototypeComponent, prototypeVariants, prototypeFrames, type PrototypeFrame, type PrototypeInteraction, type PrototypeTransition, type PrototypeStep, type PrototypeSpring } from './prototype.js';

interface OverlayState { readonly frame: PrototypeFrame; readonly settings: NonNullable<PrototypeStep['overlay']>; }
export interface PrototypeState { readonly frame: PrototypeFrame; readonly overlays: readonly OverlayState[]; }
export interface PrototypeSnapshot { readonly state: PrototypeState; readonly history: readonly PrototypeState[]; readonly scroll: PrototypeScrollPositions; readonly values: Readonly<Record<string, PrototypeValue>>; readonly modes: Readonly<Record<string, string>>; }
export interface PrototypeEffect { readonly from: PrototypeFrame; readonly transition: PrototypeTransition; readonly url?: string; readonly failed?: boolean; readonly scroll?: { readonly from: PrototypeScrollPositions; readonly to: PrototypeScrollPositions; }; }

/** One preview owns its navigation stack. It never writes to the design document. */
export class PrototypePlayback {
	public state: PrototypeState;
	private history: readonly PrototypeState[] = [];
	private values: Readonly<Record<string, PrototypeValue>> = {};
	private modes: Readonly<Record<string, string>> = {};
	private scroll: PrototypeScrollPositions = {};
	private readonly sources: readonly DesignShape[];
	constructor(private readonly shapes: readonly DesignShape[], start: string, private readonly resources: DesignResources = emptyDesignResources, private readonly measureText?: DesignTextMeasurer) {
		this.sources = resolveDesignResources([...shapes, ...getDesignLibraryShapes(resources)], resources);
		const frames = prototypeFrames(shapes);
		this.state = { frame: frames.find(frame => frame.id === start) ?? frames[0], overlays: [] };
	}
	public get activeFrame(): PrototypeFrame { return this.materialize(this.state.overlays.at(-1)?.frame ?? this.state.frame); }
	public get canBack(): boolean { return this.history.length > 0; }
	public snapshot(): PrototypeSnapshot { return { state: this.state, history: this.history, scroll: this.scroll, values: this.values, modes: this.modes }; }
	public restore(snapshot: PrototypeSnapshot): void { this.state = snapshot.state; this.history = snapshot.history; this.scroll = snapshot.scroll; this.values = snapshot.values; this.modes = snapshot.modes; }
	/** Pausing at each yield lets the browser finish one animation before evaluating the next action. */
	public *run(interaction: PrototypeInteraction, sourceId?: string): Generator<PrototypeEffect> {
		const componentId = sourceId ? prototypeComponent([this.activeFrame], sourceId)?.id : undefined;
		const visit = function* (this: PrototypePlayback, actions: readonly PrototypeStep[]): Generator<PrototypeEffect> {
			for (const action of actions) {
				if (action.action === 'conditional') {
					for (const branch of action.branches!) {
						const matches = branch.condition ? evaluatePrototypeExpression(branch.condition, id => this.variable(id)) : true;
						if (matches === undefined) { yield { from: this.scene, transition: action.transition, failed: true }; break; }
						if (matches === true) { yield* visit.call(this, branch.actions); break; }
					}
					continue;
				}
				const from = this.scene;
				if (action.action === 'scrollTo') {
					const component = sourceId ? prototypeComponent([this.activeFrame], sourceId) : undefined;
					const target = component && flattenDesignShapes([component]).find(shape => shape.sourceId === action.destination)?.id || action.destination!;
					const before = this.scroll; this.scroll = prototypeScrollTo(this.activeFrame, target, this.scroll);
					if (before !== this.scroll) { yield { from, transition: action.transition, scroll: { from: before, to: this.scroll } }; }
					continue;
				}
				if (action.action === 'url') { if (action.url) { yield { from, transition: action.transition, url: action.url }; } continue; }
				if (action.action === 'setVariable') {
					const variable = getDesignResourceCatalog(this.resources).variables.find(item => item.id === action.variableId);
					const value = evaluatePrototypeExpression(action.value!, id => this.variable(id));
					const valid = variable && value !== undefined && (variable.type === 'color' ? typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value) : typeof value === variable.type);
					if (valid) { this.values = { ...this.values, [variable.id]: value! }; }
					yield { from, transition: action.transition, ...(!valid ? { failed: true } : {}) }; continue;
				}
				if (action.action === 'setMode') {
					const collection = getDesignResourceCatalog(this.resources).collections.find(item => item.id === action.collectionId);
					const valid = collection?.modes.some(mode => mode.id === action.modeId);
					if (valid) { this.modes = { ...this.modes, [collection!.id]: action.modeId! }; }
					yield { from, transition: action.transition, ...(!valid ? { failed: true } : {}) }; continue;
				}
				if (this.execute(action, sourceId && prototypeComponent([this.activeFrame], sourceId) ? sourceId : componentId ?? sourceId)) { yield { from, transition: action.transition }; }
			}
		};
		yield* visit.call(this, interaction.actions);
	}
	private variable(id: string): PrototypeValue | undefined { return resolveDesignVariable(this.resources, id, { ...this.resources.modes, ...this.modes }, undefined, this.values); }
	private materialize(frame: PrototypeFrame): PrototypeFrame { return resolveDesignLayout(resolveDesignResources([frame], { ...this.resources, modes: { ...this.resources.modes, ...this.modes } }, this.values), [frame], this.measureText)[0] as PrototypeFrame; }
	private execute(interaction: PrototypeStep, sourceId?: string): boolean {
		const { action } = interaction;
		if (action === 'changeTo') { return sourceId ? this.changeVariant(sourceId, interaction.destination!) : false; }
		if (action === 'back') {
			const previous = this.history.at(-1);
			if (!previous) { return false; }
			this.history = this.history.slice(0, -1); this.state = previous; return true;
		}
		if (action === 'close') {
			if (!this.state.overlays.length) { return false; }
			this.state = { ...this.state, overlays: this.state.overlays.slice(0, -1) }; return true;
		}
		const destination = prototypeFrames(this.shapes).find(frame => frame.id === interaction.destination);
		if (!destination || !['navigate', 'overlay', 'swap'].includes(action)) { return false; }
		if (action !== 'navigate' && (destination.id === this.state.frame.id || this.state.overlays.some(item => item.frame.id === destination.id))) { return false; }
		this.rememberScroll(destination, !!interaction.resetScroll);
		if (action === 'navigate') {
			if (this.state.frame.id === destination.id && !this.state.overlays.length) { if (!interaction.resetScroll) { return false; } this.rememberScroll(destination, true); return true; }
			this.history = [...this.history, this.state];
			this.state = { frame: destination, overlays: [] };
		} else {
			if (destination.id === this.state.frame.id || this.state.overlays.some(item => item.frame.id === destination.id)) { return false; }
			const overlay = { frame: destination, settings: interaction.overlay ?? { position: 'center', closeOutside: true, background: true } } as const;
			// Swap replaces the top overlay without growing its stack; on a page it replaces the page.
			if (action === 'swap' && !this.state.overlays.length) { this.state = { frame: destination, overlays: [] }; }
			else if (action === 'swap') { this.state = { ...this.state, overlays: [...this.state.overlays.slice(0, -1), overlay] }; }
			else if (!this.state.overlays.some(item => item.frame.id === destination.id)) { this.state = { ...this.state, overlays: [...this.state.overlays, overlay] }; }
			else { return false; }
		}
		return true;
	}
	private changeVariant(sourceId: string, destination: string): boolean {
		const active = this.state.overlays.at(-1)?.frame ?? this.state.frame;
		const trees = [active, ...this.sources];
		const instance = prototypeComponent([active], sourceId);
		const target = prototypeVariants(trees, sourceId).find(frame => frame.id === destination);
		if (!instance?.instance || !target) { return false; }
		const previous = flattenDesignShapes(this.sources).find(shape => shape.id === instance.instance!.componentId) as PrototypeFrame | undefined;
		const remapped = remapDesignInstance(instance, target, previous, true);
		const resolved = resolveDesignResources(resolveDesignComponents([remapped], this.sources), this.resources)[0];
		const update = (shape: DesignShape): DesignShape => shape.id === instance.id ? resolved : shape.kind === 'frame' || shape.kind === 'group' ? { ...shape, children: shape.children.map(update) } : shape;
		if (this.state.overlays.length) { this.state = { ...this.state, overlays: this.state.overlays.map((overlay, index) => index === this.state.overlays.length - 1 ? { ...overlay, frame: resolveDesignResources([update(overlay.frame)], this.resources)[0] as PrototypeFrame } : overlay) }; }
		else { this.state = { ...this.state, frame: resolveDesignResources([update(this.state.frame)], this.resources)[0] as PrototypeFrame }; }
		return true;
	}

	/** Offsets are session state, including remembered screens, and never become authored geometry. */
	public get scrollRegions(): readonly PrototypeFrame[] { return prototypeVisibleShapes(applyPrototypeScroll(this.activeFrame, this.scroll)).filter((shape): shape is PrototypeFrame => shape.kind === 'frame' && !!shape.overflowDirection && shape.overflowDirection !== 'none'); }
	public get scrollFrames(): readonly PrototypeFrame[] { return prototypeScrollFrames([this.activeFrame]); }
	public scrollOffset(id: string): DesignPoint { const frame = this.scrollFrames.find(frame => frame.id === id); return frame ? prototypeScrollOffset(frame, this.scroll) : { x: 0, y: 0 }; }
	public scrollBy(id: string, delta: DesignPoint): boolean {
		let x = delta.x, y = delta.y, changed = false;
		const path = prototypePath([this.activeFrame], id);
		for (const shape of [...path].reverse()) {
			if (shape.kind !== 'frame' || !shape.overflowDirection || shape.overflowDirection === 'none') { continue; }
			const chain = path.slice(1, path.indexOf(shape) + 1), local = prototypeScrollVector(chain, { x, y });
			const before = prototypeScrollOffset(shape, this.scroll), next = prototypeScrollOffset(shape, { [shape.id]: { x: before.x + local.x, y: before.y + local.y } });
			if (next.x !== before.x || next.y !== before.y) { this.scroll = { ...this.scroll, [shape.id]: next }; changed = true; }
			const consumed = prototypeScrollVector(chain, { x: next.x - before.x, y: next.y - before.y }, true); x -= consumed.x; y -= consumed.y;
		}
		return changed;
	}
	public scrollEdge(id: string, end: boolean): boolean {
		const frame = [...prototypePath([this.activeFrame], id)].reverse().find((shape): shape is PrototypeFrame => shape.kind === 'frame' && !!shape.overflowDirection && shape.overflowDirection !== 'none');
		if (!frame) { return false; }
		const range = end ? prototypeScrollRange(frame) : { x: 0, y: 0 }, before = this.scrollOffset(frame.id);
		this.scroll = { ...this.scroll, [frame.id]: range }; return before.x !== range.x || before.y !== range.y;
	}
	private rememberScroll(destination: PrototypeFrame, reset: boolean): void {
		const next = { ...this.scroll };
		if (reset) { for (const frame of prototypeScrollFrames([destination])) { next[frame.id] = { x: 0, y: 0 }; } }
		else {
			const source = this.activeFrame;
			const family = (frame: PrototypeFrame): string => frame.name?.split('/')[0].trim() ?? '';
			if (source.id !== destination.id && family(source) && family(source) === family(destination)) {
				const match = (from: DesignShape, to: DesignShape): void => {
					if (from.kind === 'frame' && to.kind === 'frame') { next[to.id] = prototypeScrollOffset(to, { [to.id]: prototypeScrollOffset(from, this.scroll) }); }
					if ((from.kind === 'frame' || from.kind === 'group') && (to.kind === 'frame' || to.kind === 'group')) {
						const remaining = [...from.children];
						for (const child of to.children) { const index = remaining.findIndex(item => (item.name ?? item.kind) === (child.name ?? child.kind)); if (index >= 0) { match(remaining.splice(index, 1)[0], child); } }
					}
				}; match(source, destination);
			}
		}
		this.scroll = next;
	}
	public sceneAtScroll(positions: PrototypeScrollPositions): PrototypeFrame { return prototypeScene({ frame: applyPrototypeScroll(this.materialize(this.state.frame), positions), overlays: this.state.overlays.map(overlay => ({ ...overlay, frame: applyPrototypeScroll(this.materialize(overlay.frame), positions) })) }); }
	public get scene(): PrototypeFrame { return this.sceneAtScroll(this.scroll); }
	/** Delay clocks belong to the screen, even when the trigger layer is outside its viewport. */
	public get delayHotspots(): readonly DesignShape[] {
		const frame = this.activeFrame;
		const visit = (shape: DesignShape): readonly DesignShape[] => shape.visible === false ? [] : [shape, ...(shape.kind === 'frame' || shape.kind === 'group' ? shape.children.flatMap(visit) : [])];
		return visit(frame).filter(shape => shape.interactions?.some(item => item.trigger === 'delay'));
	}
	public get hotspots(): readonly DesignShape[] {
		return prototypeVisibleShapes(applyPrototypeScroll(this.activeFrame, this.scroll)).filter(shape => shape.interactions?.length);
	}
}

export function prototypeScene(state: PrototypeState): PrototypeFrame {
	const children = [...state.frame.children];
	for (const [index, overlay] of state.overlays.entries()) {
		const { frame, settings } = overlay;
		if (settings.background) { children.push({ id: `overlay-backdrop-${index}`, kind: 'rectangle', x: 0, y: 0, width: state.frame.width, height: state.frame.height, rotation: 0, fill: '#00000066' }); }
		const x = settings.position === 'center' ? (state.frame.width - frame.width) / 2 : settings.position.endsWith('Right') ? state.frame.width - frame.width : 0;
		const y = settings.position === 'center' ? (state.frame.height - frame.height) / 2 : settings.position.startsWith('bottom') ? state.frame.height - frame.height : 0;
		children.push({ ...frame, x, y, rotation: 0 });
	}
	return { ...state.frame, x: 0, y: 0, rotation: 0, clip: true, children };
}

/** CSS easing curves are evaluated in time, including solving their non-linear x coordinate. */
export function prototypeProgress(time: number, easing: PrototypeTransition['easing']): number {
	const t = Math.min(1, Math.max(0, time));
	if (easing === 'linear' || t === 0 || t === 1) { return t; }
	const [x1, y1, x2, y2] = easing === 'easeIn' ? [0.42, 0, 1, 1] : easing === 'easeOut' ? [0, 0, 0.58, 1] : [0.42, 0, 0.58, 1];
	const curve = (u: number, a: number, b: number): number => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
	let low = 0, high = 1;
	for (let iteration = 0; iteration < 24; iteration++) { const middle = (low + high) / 2; if (curve(middle, x1, x2) < t) { low = middle; } else { high = middle; } }
	return curve((low + high) / 2, y1, y2);
}

function blendColor(from: string, to: string, t: number): string {
	const channels = (color: string): number[] => (color.length === 7 ? color + 'ff' : color).slice(1).match(/../gu)!.map(value => parseInt(value, 16));
	const a = channels(from), b = channels(to);
	return '#' + a.map((value, index) => Math.round(Math.max(0, Math.min(255, value + (b[index] - value) * t))).toString(16).padStart(2, '0')).join('');
}

/** Matching stays within each parent and pairs duplicate names by paint order. Unmatched layers dissolve. */
export function smartAnimate(from: DesignShape, to: DesignShape, t: number): DesignShape {
	const lerp = (a: number, b: number): number => a + (b - a) * t;
	let result: DesignShape = { ...to, x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: Math.max(0.001, lerp(from.width, to.width)), height: Math.max(0.001, lerp(from.height, to.height)), rotation: lerp(from.rotation, to.rotation), fill: blendColor(from.fill, to.fill, t), opacity: Math.max(0, Math.min(1, lerp(from.visible === false ? 0 : from.opacity ?? 1, to.visible === false ? 0 : to.opacity ?? 1))), visible: true };
	if ((from.kind === 'frame' || from.kind === 'group') && (result.kind === 'frame' || result.kind === 'group')) {
		const remaining = [...from.children];
		const children = result.children.flatMap(child => {
			const index = remaining.findIndex(candidate => candidate.kind === child.kind && (candidate.name ?? candidate.kind) === (child.name ?? child.kind));
			if (index < 0) { return [{ ...child, opacity: (child.opacity ?? 1) * Math.max(0, Math.min(1, t)) }]; }
			const previous = remaining.splice(index, 1)[0];
			// Text, image content and vector topology are not interpolated by Smart Animate.
			const changedContent = previous.kind === 'text' && child.kind === 'text' && previous.text !== child.text || previous.kind === 'image' && child.kind === 'image' && previous.assetVersionId !== child.assetVersionId || previous.kind === 'path' && child.kind === 'path' && JSON.stringify(previous.nodes) !== JSON.stringify(child.nodes);
			if (changedContent) { return [{ ...previous, id: `exit-${previous.id}`, opacity: (previous.opacity ?? 1) * Math.max(0, Math.min(1, 1 - t)) }, { ...child, opacity: (child.opacity ?? 1) * Math.max(0, Math.min(1, t)) }]; }
			return [smartAnimate(previous, child, t)];
		});
		children.push(...remaining.map(child => ({ ...child, id: `exit-${child.id}`, opacity: (child.opacity ?? 1) * Math.max(0, Math.min(1, 1 - t)) })));
		result = { ...result, children };
	}
	return result;
}

export interface PrototypeAnimationLayer { readonly shape: DesignShape; readonly x: number; readonly y: number; readonly opacity: number; }
export function samplePrototypeTransition(from: PrototypeFrame, to: PrototypeFrame, transition: PrototypeTransition, progress: number): readonly PrototypeAnimationLayer[] {
	const t = transition.easing === 'spring' && transition.spring ? springProgress(progress * prototypeTransitionDuration(transition) / 1000, transition.spring) : prototypeProgress(progress, transition.easing);
	const layer = (shape: DesignShape, x = 0, y = 0, opacity = 1): PrototypeAnimationLayer => ({ shape, x: x || 0, y: y || 0, opacity: Math.max(0, Math.min(1, opacity)) });
	if (transition.type === 'instant' || progress >= 1) { return [layer(to)]; }
	if (transition.type === 'smart') { return [layer(smartAnimate(from, to, t))]; }
	if (transition.type === 'dissolve') { return [layer(from, 0, 0, 1 - t), layer(to, 0, 0, t)]; }
	const dx = transition.direction === 'left' ? -Math.max(from.width, to.width) : transition.direction === 'right' ? Math.max(from.width, to.width) : 0;
	const dy = transition.direction === 'top' ? -Math.max(from.height, to.height) : transition.direction === 'bottom' ? Math.max(from.height, to.height) : 0;
	if (transition.type === 'moveOut' || transition.type === 'slideOut') { return [layer(to, transition.type === 'slideOut' ? -dx * (1 - t) * 0.25 : 0, transition.type === 'slideOut' ? -dy * (1 - t) * 0.25 : 0), layer(from, dx * t, dy * t, transition.type === 'slideOut' ? 1 - t : 1)]; }
	const distance = transition.type === 'push' ? 1 : transition.type === 'slideIn' ? 0.25 : 0;
	return [layer(from, -dx * t * distance, -dy * t * distance, transition.type === 'slideIn' ? 1 - t : 1), layer(to, dx * (1 - t), dy * (1 - t))];
}

/** Unit step response with an initial velocity, solved for all three damping regimes. Time is seconds. */
export function springProgress(time: number, spring: PrototypeSpring): number {
	if (time <= 0) { return 0; }
	const a = spring.damping / (2 * spring.mass), w2 = spring.stiffness / spring.mass, discriminant = a * a - w2;
	if (Math.abs(discriminant) < 1e-8 * w2) { return 1 - Math.exp(-a * time) * (1 + (a - spring.initialVelocity) * time); }
	if (discriminant < 0) { const w = Math.sqrt(-discriminant); return 1 - Math.exp(-a * time) * (Math.cos(w * time) + (a - spring.initialVelocity) / w * Math.sin(w * time)); }
	const root = Math.sqrt(discriminant), r1 = -w2 / (a + root), r2 = -a - root;
	const c1 = (spring.initialVelocity + r2) / (r1 - r2), c2 = -1 - c1;
	return 1 + c1 * Math.exp(r1 * time) + c2 * Math.exp(r2 * time);
}

/** Springs derive their duration from settling, so changing mass changes speed instead of stretching time. */
export function prototypeTransitionDuration(transition: PrototypeTransition): number {
	if (transition.easing !== 'spring' || !transition.spring) { return transition.duration; }
	const { mass, damping, stiffness, initialVelocity } = transition.spring;
	const a = damping / (2 * mass), w2 = stiffness / mass, discriminant = a * a - w2;
	let seconds: number;
	if (discriminant < -1e-8 * w2) { seconds = Math.log(Math.hypot(1, (a - initialVelocity) / Math.sqrt(-discriminant)) / 0.001) / a; }
	else {
		const envelope = (t: number): number => {
			if (Math.abs(discriminant) < 1e-8 * w2) { return Math.exp(-a * t) * (1 + Math.abs(a - initialVelocity) * t); }
			const root = Math.sqrt(discriminant), r1 = -w2 / (a + root), r2 = -a - root, c1 = (initialVelocity + r2) / (r1 - r2);
			return Math.abs(c1) * Math.exp(r1 * t) + Math.abs(-1 - c1) * Math.exp(r2 * t);
		};
		let low = 0, high = 60;
		for (let i = 0; i < 32; i++) { const mid = (low + high) / 2; if (envelope(mid) > 0.001) { low = mid; } else { high = mid; } }
		seconds = high;
	}
	return Math.min(60000, Math.max(1, Math.ceil(seconds * 1000)));
}
