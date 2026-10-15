import { prototypeScrollRange, type PrototypeScrollPositions } from '../../../common/model/prototypeScroll.js';
import type { DesignPoint } from '../../../common/core/geometry.js';
import { addDisposableListener, h, svg } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { renderDesignShape } from '../../../browser/svgRenderer.js';
import type { DesignEditorContributionContext } from '../../../browser/designEditorBrowser.js';
import { defaultPrototypeTransition, prototypeFrames, prototypeOwner, type PrototypeFrame, type PrototypeInteraction, type PrototypeTransition, type PrototypeTrigger } from '../../../common/model/prototype.js';
import { PrototypePlayback, samplePrototypeTransition, prototypeTransitionDuration, prototypeProgress, springProgress, type PrototypeEffect, type PrototypeSnapshot } from '../../../common/model/prototypePlayback.js';
import { actionLabels, triggerLabels } from './prototypeLabels.js';

/** Playback input, timers and animation frames have the lifetime of one preview, never of the file. */
export class PrototypePreview extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly scene: SVGSVGElement;
	private readonly status: HTMLElement;
	private readonly back: Button;
	private readonly flow: HTMLSelectElement;
	private readonly pending = this._register(new DisposableStore());
	private playback: PrototypePlayback | undefined;
	private returnFocus: HTMLElement | undefined;
	private start = '';
	private readonly inertSiblings = new Map<HTMLElement, boolean>();
	private animating = false;
	private chain: Generator<PrototypeEffect> | undefined;
	private failure = '';
	private delayFrame = '';
	private readonly firedDelays = new Set<string>();
	private temporary: { snapshot: PrototypeSnapshot; trigger: 'hover' | 'press'; bounds: DOMRect; transition: PrototypeTransition; } | undefined;
	private pointer: { id: string; sourceId: string; x: number; y: number; pointerId: number; } | undefined;
	private suppressClick = false;
	private pan: { id: string; pointerId: number; x: number; y: number; moved: boolean; } | undefined;
	constructor(private readonly context: DesignEditorContributionContext, private readonly openExternal: (url: string) => void) {
		super();
		const doc = context.ownerDocument;
		this.domNode = h(doc, 'section', { className: 'ash-prototype-preview', attributes: { role: 'region', 'aria-label': localize('sessions.design.prototype.preview', 'Prototype preview'), tabindex: '0' } });
		this.domNode.hidden = true;
		const controls = h(doc, 'div', { className: 'ash-prototype-preview-controls' });
		this.flow = h(doc, 'select', { attributes: { 'aria-label': localize('sessions.design.prototype.flow', 'Flow starting point') } });
		controls.append(this.flow);
		this.back = this._register(new Button(controls, { label: actionLabels().back, onClick: () => this.perform({ id: '', trigger: 'click', actions: [{ action: 'back', transition: defaultPrototypeTransition }] }) }));
		this._register(new Button(controls, { label: localize('sessions.design.prototype.restart', 'Restart flow'), onClick: () => this.restart(this.start) }));
		this._register(new Button(controls, { label: localize('sessions.creator.closePreview', 'Close preview'), onClick: () => this.close() }));
		this.status = h(doc, 'span', { attributes: { role: 'status', 'aria-live': 'polite' } });
		controls.append(this.status);
		this.scene = svg(doc, 'svg', { className: 'ash-prototype-preview-scene' });
		this.domNode.append(controls, this.scene);
		this._register(addDisposableListener(this.flow, 'change', () => this.restart(this.flow.value)));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); if (this.playback?.state.overlays.length) { this.perform({ id: '', trigger: 'click', actions: [{ action: 'close', transition: defaultPrototypeTransition }] }); } else { this.close(); } return; }
			if (event.target !== this.domNode && !this.scene.contains(event.target as Node)) { return; }
			const hot = this.playback?.hotspots.find(shape => shape.interactions?.some(item => item.trigger === 'key' && item.key?.toLowerCase() === event.key.toLowerCase()));
			const keyInteraction = hot?.interactions?.find(item => item.trigger === 'key' && item.key?.toLowerCase() === event.key.toLowerCase());
			if (keyInteraction && !event.repeat) { event.preventDefault(); this.perform(keyInteraction, hot?.id); return; }
			if (this.playback && !this.animating && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
				const id = this.scrollTarget(event.target), height = this.playback.scrollFrames.find(frame => frame.id === id)?.height ?? this.playback.activeFrame.height;
				const delta = { x: event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0, y: event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : event.key === 'PageUp' ? -height * 0.9 : event.key === 'PageDown' ? height * 0.9 : 0 };
				const changed = event.key === 'Home' || event.key === 'End' ? this.playback.scrollEdge(id, event.key === 'End') : this.playback.scrollBy(id, delta);
				if (changed) { event.preventDefault(); event.stopPropagation(); this.finish(false); return; }
			}
			if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
				const match = this.hotspot(event.target, 'click') ?? this.hotspot(event.target);
				if (match) { event.preventDefault(); this.activate(match.interaction, match.element); }
			}
		}));
		this._register(addDisposableListener(this.domNode, 'keyup', event => { if (this.temporary && (event.key === 'Enter' || event.key === ' ')) { this.revert(); } }));
		this._register(addDisposableListener(this.scene, 'wheel', event => {
			if (!this.playback || this.animating || event.ctrlKey) { return; }
			const id = this.scrollTarget(event.target), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.playback.activeFrame.height : 1;
			const delta = this.designDelta((event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit, (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit);
			if (this.playback.scrollBy(id, delta)) { event.preventDefault(); event.stopPropagation(); this.finish(false); }
		}, { passive: false }));
		this._register(addDisposableListener(this.scene, 'click', event => {
			if (this.suppressClick) { this.suppressClick = false; return; }
			const match = this.hotspot(event.target, 'click');
			if (match) { this.activate(match.interaction, match.element); return; }
			const overlay = this.playback?.state.overlays.at(-1);
			if (overlay?.settings.closeOutside && !(event.target as Element).closest(`[data-shape-id="${overlay.frame.id}"]`)) { this.perform({ id: '', trigger: 'click', actions: [{ action: 'close', transition: defaultPrototypeTransition }] }); }
		}));
		this._register(addDisposableListener(this.scene, 'pointerdown', event => {
			if (event.button !== 0) { return; }
			this.suppressClick = false;
			const drag = this.hotspot(event.target, 'drag');
			if (drag) { this.pointer = { id: drag.interaction.id, sourceId: drag.element.getAttribute('data-shape-id')!, x: event.clientX, y: event.clientY, pointerId: event.pointerId }; }
			const match = this.hotspot(event.target, 'press') ?? this.hotspot(event.target, 'down');
			if (match) { event.preventDefault(); this.activate(match.interaction, match.element); }
			else if (!drag && this.playback?.scrollFrames.length && !this.animating) { this.pan = { id: this.scrollTarget(event.target), pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; this.scene.setPointerCapture?.(event.pointerId); }
		}));
		this._register(addDisposableListener(this.domNode, 'pointermove', event => {
			if (this.pan && event.pointerId === this.pan.pointerId) {
				const pan = this.pan, dx = pan.x - event.clientX, dy = pan.y - event.clientY;
				if (pan.moved || Math.hypot(dx, dy) > 8) { pan.moved = true; pan.x = event.clientX; pan.y = event.clientY; this.suppressClick = true; event.preventDefault(); if (this.playback?.scrollBy(pan.id, this.designDelta(dx, dy))) { this.finish(false); } }
			}
			if (this.temporary?.trigger === 'hover') {
				const rect = this.temporary.bounds;
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { this.revert(); }
			}
			if (this.pointer && event.pointerId === this.pointer.pointerId && Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) > 8) {
				const interaction = this.playback?.hotspots.flatMap(shape => shape.interactions ?? []).find(item => item.id === this.pointer?.id && item.trigger === 'drag');
				const sourceId = this.pointer.sourceId; this.pointer = undefined; this.suppressClick = true; if (interaction) { this.perform(interaction, sourceId); }
			}
		}));
		this._register(addDisposableListener(doc, 'pointerup', event => {
			this.pointer = undefined;
			const panned = this.pan?.moved; this.cancelPan(); if (panned) { return; }
			if (this.temporary?.trigger === 'press') { this.suppressClick = true; this.revert(); return; }
			if (this.scene.contains(event.target as Node)) { const match = this.hotspot(event.target, 'up'); if (match) { this.perform(match.interaction, match.element.getAttribute('data-shape-id')!); } }
		}));
		this._register(addDisposableListener(doc, 'pointercancel', () => { this.pointer = undefined; this.cancelPan(); this.revert(); }));
		for (const [eventName, trigger] of [['pointerover', 'enter'], ['pointerout', 'leave']] as const) {
			this._register(addDisposableListener(this.scene, eventName, event => {
				if (this.temporary || this.animating) { return; }
				const match = this.hotspot(event.target, trigger) ?? (trigger === 'enter' ? this.hotspot(event.target, 'hover') : undefined);
				if (match && (!event.relatedTarget || !match.element.contains(event.relatedTarget as Node))) { this.activate(match.interaction, match.element); }
			}));
		}
		this._register(addDisposableListener(this.domNode, 'pointerleave', () => { if (this.temporary?.trigger === 'hover') { this.revert(); } }));
		this._register(addDisposableListener(doc.defaultView!, 'blur', () => { this.pointer = undefined; this.cancelPan(); this.revert(); }));
		this._register(context.documentController.model.onDidChange(() => { if (this.isOpen) { this.close(this.domNode.contains(this.context.ownerDocument.activeElement)); } }));
	}
	public get isOpen(): boolean { return !this.domNode.hidden; }
	public show(): void {
		if (this.isOpen) { this.focus(); return; }
		const shapes = this.context.documentController.model.value.shapes;
		const frames = prototypeFrames(shapes);
		if (!frames.length) { return; }
		this.returnFocus = this.context.ownerDocument.activeElement as HTMLElement;
		const selected = prototypeOwner(shapes, [...this.context.selection.ids][0]);
		this.domNode.hidden = false;
		for (const sibling of this.domNode.parentElement?.children ?? []) { if (sibling !== this.domNode && sibling instanceof this.context.ownerDocument.defaultView!.HTMLElement) { this.inertSiblings.set(sibling, sibling.inert); sibling.inert = true; } }
		this.flow.replaceChildren(...frames.filter(frame => frame.flowStart).map(frame => h(this.context.ownerDocument, 'option', { properties: { value: frame.id } }, frame.flowStart!)));
		this.restart(selected?.id ?? frames.find(frame => frame.flowStart)?.id ?? frames[0].id);
		this.focus();
	}
	public focus(): void { this.domNode.focus(); }
	public close(restoreFocus = true): void { this.cancelPan(); this.chain = undefined; this.pending.clear(); this.animating = false; this.temporary = undefined; this.pointer = undefined; this.playback = undefined; this.domNode.hidden = true; for (const [sibling, inert] of this.inertSiblings) { sibling.inert = inert; } this.inertSiblings.clear(); if (restoreFocus && this.returnFocus?.isConnected) { this.returnFocus.focus(); } }
	private restart(id: string): void {
		this.cancelPan(); this.pointer = undefined;
		this.chain = undefined; this.failure = ''; this.firedDelays.clear(); this.pending.clear(); this.temporary = undefined; this.animating = false; this.start = id;
		this.playback = new PrototypePlayback(this.context.documentController.model.value.shapes, id, this.context.documentController.model.value.resources, this.context.documentController.model.measureText);
		if (![...this.flow.options].some(option => option.value === id)) { const frame = this.playback.state.frame; this.flow.append(h(this.context.ownerDocument, 'option', { properties: { value: id } }, frame.name || localize('sessions.design.prototype.selectedScreen', 'Selected screen'))); }
		this.flow.value = id;
		this.finish();
	}
	private hotspot(target: EventTarget | null, trigger?: PrototypeTrigger): { interaction: PrototypeInteraction; element: Element; } | undefined {
		if (this.animating || !this.playback || !(target instanceof this.context.ownerDocument.defaultView!.Element)) { return; }
		for (let element: Element | null = target; element && element !== this.scene; element = element.parentElement) {
			const shape = this.playback.hotspots.find(shape => shape.id === element!.getAttribute('data-shape-id'));
			const interaction = shape?.interactions?.find(item => trigger ? item.trigger === trigger : !['delay', 'key'].includes(item.trigger));
			if (interaction) { return { interaction, element }; }
		}
		return;
	}
	private activate(interaction: PrototypeInteraction, element: Element): void {
		if (!this.playback || this.temporary) { return; }
		if (interaction.trigger === 'hover' || interaction.trigger === 'press') { this.temporary = { snapshot: this.playback.snapshot(), trigger: interaction.trigger, bounds: element.getBoundingClientRect(), transition: interaction.actions[0].transition }; }
		this.perform(interaction, element.getAttribute('data-shape-id')!);
	}
	private revert(): void {
		if (!this.temporary || !this.playback) { return; }
		const from = this.playback.scene, scrollFrom = this.playback.snapshot().scroll; const { snapshot, transition } = this.temporary;
		this.chain = undefined; this.temporary = undefined; this.playback.restore(snapshot); this.animate(from, transition, () => this.finish(), transition.type === 'scroll' ? { from: scrollFrom, to: snapshot.scroll } : undefined);
	}
	private perform(interaction: PrototypeInteraction, sourceId?: string): void {
		if (!this.playback || this.animating || this.chain) { return; }
		this.pending.clear(); this.failure = '';
		this.chain = this.playback.run(interaction, sourceId);
		this.advance();
	}
	private advance(): void {
		while (this.chain && this.playback) {
			const next = this.chain.next();
			if (next.done) { this.chain = undefined; this.finish(); return; }
			const effect = next.value;
			if (effect.failed) { this.failure = localize('sessions.design.prototype.actionFailed', 'An action could not run. Check its variable references and expression values.'); continue; }
			if (effect.url) { this.openExternal(effect.url); continue; }
			if (effect.transition.type !== 'instant' && !this.context.ownerDocument.defaultView!.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { this.animate(effect.from, effect.transition, () => this.advance(), effect.scroll); return; }
		}
	}
	private animate(from: PrototypeFrame, transition: PrototypeTransition, complete: () => void = () => this.finish(), scroll?: PrototypeEffect['scroll']): void {
		this.pending.clear();
		const window = this.context.ownerDocument.defaultView!;
		if (transition.type === 'instant' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { complete(); return; }
		this.animating = true;
		const to = this.playback!.scene;
		const start = window.performance.now();
		const duration = prototypeTransitionDuration(transition);
		let frame = 0;
		this.pending.add(toDisposable(() => window.cancelAnimationFrame(frame)));
		const tick = (now: number): void => {
			const progress = Math.min(1, (now - start) / duration);
			this.scene.setAttribute('viewBox', `0 0 ${from.width + (to.width - from.width) * progress} ${from.height + (to.height - from.height) * progress}`);
			const t = progress >= 1 ? 1 : transition.easing === 'spring' && transition.spring ? springProgress(progress * duration / 1000, transition.spring) : prototypeProgress(progress, transition.easing);
			const offsets: PrototypeScrollPositions = scroll ? Object.fromEntries([...new Set([...Object.keys(scroll.from), ...Object.keys(scroll.to)])].map(id => { const a = scroll.from[id] ?? { x: 0, y: 0 }, b = scroll.to[id] ?? { x: 0, y: 0 }; return [id, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }]; })) : {};
			const layers = scroll ? [{ shape: this.playback!.sceneAtScroll(offsets), x: 0, y: 0, opacity: 1 }] : samplePrototypeTransition(from, to, transition, progress);
			this.scene.replaceChildren(...layers.map(layer => {
				const group = svg(this.context.ownerDocument, 'g', { attributes: { transform: `translate(${layer.x} ${layer.y})`, opacity: `${layer.opacity}`, 'aria-hidden': 'true' } }); group.append(this.renderShape(layer.shape)); return group;
			}));
			if (progress < 1) { frame = window.requestAnimationFrame(tick); } else { this.animating = false; complete(); }
		};
		frame = window.requestAnimationFrame(tick);
	}
	private cancelPan(): void { const pointer = this.pan?.pointerId; this.pan = undefined; if (pointer !== undefined && this.scene.hasPointerCapture?.(pointer)) { this.scene.releasePointerCapture(pointer); } }
	private scrollTarget(target: EventTarget | null): string {
		if (target instanceof this.context.ownerDocument.defaultView!.Element) { for (let element: Element | null = target; element && element !== this.scene; element = element.parentElement) { const id = element.getAttribute('data-shape-id'); if (id && this.playback?.scrollFrames.some(frame => frame.id === id)) { return id; } } }
		return this.playback?.activeFrame.id ?? '';
	}
	private designDelta(x: number, y: number): DesignPoint {
		const element = this.scene.querySelector<SVGGraphicsElement>(`[data-shape-id="${this.playback?.activeFrame.id}"]`), matrix = element?.getScreenCTM?.()?.inverse();
		return matrix ? { x: matrix.a * x + matrix.c * y, y: matrix.b * x + matrix.d * y } : { x, y };
	}
	private renderShape(shape: PrototypeFrame | import('../../../common/model/document.js').DesignShape): SVGGraphicsElement {
		const element = renderDesignShape(shape, undefined, this.context.documentController.getEmbeddedImageSources());
		for (const guide of element.querySelectorAll('[data-layout-guide]')) { guide.remove(); }
		return element;
	}
	private finish(schedule = true): void {
		if (schedule) { this.pending.clear(); } this.animating = false;
		const playback = this.playback;
		if (!playback) { return; }
		const focused = this.context.ownerDocument.activeElement;
		const hadFocus = this.scene.contains(focused), focusId = hadFocus ? focused?.getAttribute('data-shape-id') : undefined;
		const scene = playback.scene;
		this.scene.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
		this.scene.replaceChildren(this.renderShape(scene));
		this.scene.dataset.screenId = playback.activeFrame.id;
		this.back.enabled = playback.canBack;
		this.status.textContent = playback.activeFrame.name || localize('sessions.design.prototype.screenNumber', 'Screen {0}', prototypeFrames(this.context.documentController.model.value.shapes).findIndex(frame => frame.id === playback.activeFrame.id) + 1);
		if (this.failure) { this.status.textContent += ' — ' + this.failure; }
		if (this.delayFrame !== playback.activeFrame.id) { this.delayFrame = playback.activeFrame.id; this.firedDelays.clear(); }
		for (const frame of playback.scrollRegions) {
			const element = this.scene.querySelector<SVGGraphicsElement>(`[data-shape-id="${frame.id}"]`);
			if (!element) { continue; }
			const offset = playback.scrollOffset(frame.id), range = prototypeScrollRange(frame);
			element.dataset.scrollX = `${offset.x}`; element.dataset.scrollY = `${offset.y}`;
			element.setAttribute('tabindex', '0'); element.setAttribute('role', 'region');
			element.setAttribute('aria-label', localize('sessions.design.prototype.scrollRegion', '{0}. Scroll position {1} of {2} horizontally, {3} of {4} vertically. Use arrow keys, Page Up, Page Down, Home or End.', frame.name || localize('sessions.design.prototype.scrollableFrame', 'Scrollable frame'), Math.round(offset.x), Math.round(range.x), Math.round(offset.y), Math.round(range.y)));
		}
		for (const shape of playback.hotspots) {
			const element = this.scene.querySelector<SVGGraphicsElement>(`[data-shape-id="${shape.id}"]`);
			if (!element || !shape.interactions?.some(item => !['delay', 'key'].includes(item.trigger))) { continue; }
			const label = shape.name || (shape.kind === 'text' ? shape.text : localize('sessions.design.prototype.hotspot', 'Hotspot'));
			element.setAttribute('tabindex', '0'); element.setAttribute('role', 'button'); element.setAttribute('aria-label', label + ': ' + shape.interactions!.map(item => `${triggerLabels()[item.trigger]} · ${item.actions.map(action => actionLabels()[action.action]).join(' → ')}`).join(', ')); element.classList.add('ash-prototype-hotspot');
		}
		for (const shape of schedule ? playback.delayHotspots : []) {
			for (const interaction of shape.interactions ?? []) {
				const delayKey = `${shape.id}:${interaction.id}`;
				if (!schedule || interaction.trigger !== 'delay' || this.firedDelays.has(delayKey)) { continue; }
				const window = this.context.ownerDocument.defaultView!;
				const timer = window.setTimeout(() => { this.firedDelays.add(delayKey); this.perform(interaction, shape.id); }, interaction.delay);
				this.pending.add(toDisposable(() => window.clearTimeout(timer)));
			}
		}
		if (hadFocus) { const target = focusId ? this.scene.querySelector<SVGGraphicsElement>(`[data-shape-id="${focusId}"][tabindex="0"]`) : undefined; if (target) { target.focus(); } else { this.focus(); } }
	}
	public getAccessibleContent(): string {
		return this.playback ? [localize('sessions.design.prototype.currentScreen', 'Current screen: {0}', this.status.textContent ?? ''), ...this.playback.scrollRegions.map(frame => localize('sessions.design.prototype.scrollSummary', '{0}: scroll position {1}, {2}.', frame.name || localize('sessions.design.prototype.scrollableFrame', 'Scrollable frame'), Math.round(this.playback!.scrollOffset(frame.id).x), Math.round(this.playback!.scrollOffset(frame.id).y))), ...this.playback.hotspots.map(shape => `${shape.name || (shape.kind === 'text' ? shape.text : localize('sessions.design.prototype.hotspot', 'Hotspot'))}: ${shape.interactions!.map(item => `${triggerLabels()[item.trigger]} · ${item.actions.map(action => actionLabels()[action.action]).join(' → ')}`).join(', ')}`)].join('\n') : '';
	}
	public override dispose(): void { this.cancelPan(); this.chain = undefined; this.pending.clear(); for (const [sibling, inert] of this.inertSiblings) { sibling.inert = inert; } this.inertSiblings.clear(); this.domNode.remove(); super.dispose(); }
}
