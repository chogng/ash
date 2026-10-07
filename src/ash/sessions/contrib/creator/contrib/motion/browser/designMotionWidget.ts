import './designMotionWidget.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import type { DesignModel } from '../../../common/model/designModel.js';
import type { DesignKeyframe, DesignMotion, DesignShape } from '../../../common/model/document.js';
import { designMotionDuration, sampleDesignMotion } from '../common/motion.js';
import type { DesignScene } from '../../../browser/designEditorBrowser.js';

/** The document owns keyframes; this contribution owns only playback time and timeline DOM. */
export class DesignMotionWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeTime = this.changeEmitter.event;
	private readonly playButton: Button;
	private readonly addButton: Button;
	private readonly removeButton: Button;
	private readonly clearButton: Button;
	private readonly timeline: HTMLInputElement;
	private readonly durationInput: HTMLInputElement;
	private readonly loopInput: HTMLInputElement;
	private readonly frameSelect: HTMLSelectElement;
	private readonly fields = new Map<'x' | 'y' | 'rotation' | 'opacity', HTMLInputElement>();
	private readonly timeLabel: HTMLElement;
	private shape: DesignShape | undefined;
	private frameIndex = 0;
	private time = 0;
	private animationFrame: number | undefined;
	private isActive = false;
	private isBusy = false;

	constructor(ownerDocument: Document, private readonly model: DesignModel, private readonly commands: DocumentCommands) {
		super();
		this.domNode = h(ownerDocument, 'section', { className: 'ash-design-motion-widget', attributes: { 'aria-label': localize('sessions.design.motionTimeline', 'Animation timeline') } });
		const playback = h(ownerDocument, 'div', { className: 'ash-design-motion-row' });
		const properties = h(ownerDocument, 'div', { className: 'ash-design-motion-row' });
		const hint = h(ownerDocument, 'span', { className: 'ash-design-motion-hint' }, localize('sessions.design.motionHint', 'Select an object, add keyframes, then edit its position, rotation and opacity. Interpolation is linear.'));
		this.playButton = this._register(new Button(playback, { label: localize('sessions.design.playMotion', 'Play'), onClick: () => this.togglePlayback() }));
		this.timeline = h(ownerDocument, 'input', { properties: { type: 'range', min: '0', max: '1000', step: '1', value: '0' }, attributes: { 'aria-label': localize('sessions.design.motionTime', 'Animation time (ms)') } });
		this.timeLabel = h(ownerDocument, 'span', { className: 'ash-design-motion-time' });
		playback.append(this.timeline, this.timeLabel);
		this.durationInput = h(ownerDocument, 'input', { properties: { type: 'number', min: '1', step: '1' }, attributes: { 'aria-label': localize('sessions.design.motionDuration', 'Duration (ms)') } });
		this.loopInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.motionLoop', 'Loop') } });
		this.frameSelect = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.design.keyframe', 'Keyframe') } });
		properties.append(
			h(ownerDocument, 'label', {}, localize('sessions.design.motionDuration', 'Duration (ms)'), this.durationInput),
			h(ownerDocument, 'label', {}, localize('sessions.design.motionLoop', 'Loop'), this.loopInput),
			h(ownerDocument, 'label', {}, localize('sessions.design.keyframe', 'Keyframe'), this.frameSelect),
		);
		for (const [field, label] of [
			['x', localize('sessions.design.motionX', 'Keyframe X')],
			['y', localize('sessions.design.motionY', 'Keyframe Y')],
			['rotation', localize('sessions.design.motionRotation', 'Keyframe rotation')],
			['opacity', localize('sessions.design.motionOpacity', 'Keyframe opacity')],
		] as const) {
			const input = h(ownerDocument, 'input', { properties: { type: 'number', step: field === 'opacity' ? '0.1' : 'any' }, attributes: { 'aria-label': label } });
			if (field === 'opacity') { input.min = '0'; input.max = '1'; }
			properties.append(h(ownerDocument, 'label', {}, label, input));
			this.fields.set(field, input);
			this._register(addDisposableListener(input, 'change', () => {
				if (!input.checkValidity() || !Number.isFinite(input.valueAsNumber)) { this.update(this.shape, this.isBusy); return; }
				const motion = this.shape!.motion!;
				this.commit({ ...motion, keyframes: motion.keyframes.map((frame, index) => index === this.frameIndex ? { ...frame, [field]: input.valueAsNumber } : frame) });
			}));
		}
		this.addButton = this._register(new Button(playback, { label: localize('sessions.design.addKeyframe', 'Add keyframe'), onClick: () => this.addKeyframe() }));
		this.removeButton = this._register(new Button(playback, {
			label: localize('sessions.design.removeKeyframe', 'Remove keyframe'), onClick: () => {
				const motion = this.shape!.motion!;
				this.commit({ ...motion, keyframes: motion.keyframes.filter((_, index) => index !== this.frameIndex) });
			}
		}));
		this.clearButton = this._register(new Button(playback, {
			label: localize('sessions.design.clearMotion', 'Remove animation'), onClick: () => {
				const { motion, ...shape } = this.shape!;
				this.stop();
				this.commands.updateShape(shape);
			}
		}));
		this.domNode.append(hint, playback, properties);
		this._register(addDisposableListener(this.timeline, 'input', () => { this.stop(); this.setTime(this.timeline.valueAsNumber); }));
		this._register(addDisposableListener(this.durationInput, 'change', () => {
			if (!this.durationInput.checkValidity() || !Number.isFinite(this.durationInput.valueAsNumber)) { this.update(this.shape, this.isBusy); return; }
			this.commit({ ...this.shape!.motion!, duration: this.durationInput.valueAsNumber });
		}));
		this._register(addDisposableListener(this.loopInput, 'change', () => this.commit({ ...this.shape!.motion!, loop: this.loopInput.checked })));
		this._register(addDisposableListener(this.frameSelect, 'change', () => {
			this.stop();
			this.frameIndex = Number(this.frameSelect.value);
			const motion = this.shape!.motion!;
			this.setTime(motion.keyframes[this.frameIndex].offset * motion.duration);
			this.update(this.shape, this.isBusy);
		}));
		this._register(toDisposable(() => this.stop()));
	}

	public getScene(): DesignScene {
		const opacity = new Map<string, number>();
		const sample = (shape: DesignShape): DesignShape => {
			const frame = sampleDesignMotion(shape, this.time);
			opacity.set(shape.id, frame.opacity);
			const geometry = { ...shape, x: frame.x, y: frame.y, rotation: frame.rotation };
			return geometry.kind === 'group' || geometry.kind === 'frame' ? { ...geometry, children: geometry.children.map(sample) } : geometry;
		};
		return { shapes: this.model.value.shapes.map(sample), opacity };
	}

	public setActive(isActive: boolean): void {
		this.isActive = isActive;
		this.domNode.classList.toggle('visible', isActive);
		if (!isActive) { this.stop(); this.setTime(0); }
	}

	public update(shape: DesignShape | undefined, isBusy: boolean): void {
		if (this.shape?.id !== shape?.id) { this.frameIndex = 0; }
		this.shape = shape;
		this.isBusy = isBusy;
		if (isBusy) { this.stop(); }
		this.timeline.max = `${designMotionDuration(this.model.value.shapes)}`;
		const motion = shape?.motion;
		this.addButton.enabled = !!shape && !isBusy;
		this.clearButton.enabled = !!motion && !isBusy;
		this.playButton.enabled = this.hasMotion(this.model.value.shapes) && !isBusy;
		this.frameIndex = Math.min(this.frameIndex, (motion?.keyframes.length ?? 1) - 1);
		this.removeButton.enabled = !!motion && this.frameIndex > 0 && this.frameIndex < motion.keyframes.length - 1 && !isBusy;
		this.durationInput.disabled = this.loopInput.disabled = this.frameSelect.disabled = !motion || isBusy;
		this.durationInput.value = `${motion?.duration ?? 1000}`;
		this.loopInput.checked = motion?.loop ?? false;
		this.frameSelect.replaceChildren(...(motion?.keyframes ?? []).map((frame, index) => h(this.domNode.ownerDocument, 'option', { properties: { value: `${index}` } }, `${Math.round(frame.offset * 100)}%`)));
		this.frameSelect.value = `${this.frameIndex}`;
		for (const [field, input] of this.fields) {
			input.disabled = !motion || isBusy;
			input.value = `${motion?.keyframes[this.frameIndex][field] ?? (field === 'opacity' ? 1 : shape?.[field] ?? 0)}`;
		}
		this.timeLabel.textContent = localize('sessions.design.motionTimeValue', '{0} ms', Math.round(this.time));
	}

	private hasMotion(shapes: readonly DesignShape[]): boolean {
		return shapes.some(shape => !!shape.motion || ((shape.kind === 'group' || shape.kind === 'frame') && this.hasMotion(shape.children)));
	}

	private hasLoop(shapes: readonly DesignShape[]): boolean {
		return shapes.some(shape => shape.motion?.loop || ((shape.kind === 'group' || shape.kind === 'frame') && this.hasLoop(shape.children)));
	}

	private addKeyframe(): void {
		const shape = this.shape!;
		let motion = shape.motion;
		if (!motion) {
			const frame = sampleDesignMotion(shape, 0);
			motion = { duration: 1000, loop: false, keyframes: [{ ...frame, offset: 0 }, { ...frame, offset: 1 }] };
			this.frameIndex = 1;
		} else {
			const frame: DesignKeyframe = { ...sampleDesignMotion({ ...shape, motion: { ...motion, loop: false } }, this.time), offset: Math.min(1, this.time / motion.duration) };
			const keyframes = [...motion.keyframes.filter(current => current.offset !== frame.offset), frame].sort((a, b) => a.offset - b.offset);
			this.frameIndex = keyframes.indexOf(frame);
			motion = { ...motion, keyframes };
		}
		this.setTime(motion.keyframes[this.frameIndex].offset * motion.duration);
		this.commit(motion);
	}

	private commit(motion: DesignMotion): void {
		this.stop();
		this.commands.updateShape({ ...this.shape!, motion });
	}

	private setTime(time: number): void {
		this.time = time;
		const duration = Number(this.timeline.max);
		this.timeline.value = `${time > duration ? time % duration : time}`;
		this.timeLabel.textContent = localize('sessions.design.motionTimeValue', '{0} ms', Math.round(time));
		this.changeEmitter.fire();
	}

	private togglePlayback(): void {
		if (this.animationFrame !== undefined) { this.stop(); return; }
		const window = getWindow(this.domNode);
		const duration = designMotionDuration(this.model.value.shapes);
		const isLooping = this.hasLoop(this.model.value.shapes);
		const start = window.performance.now() - (this.time >= duration ? 0 : this.time);
		this.playButton.label = localize('sessions.design.pauseMotion', 'Pause');
		const tick = (timestamp: number): void => {
			if (!this.isActive || !this.domNode.checkVisibility()) { this.stop(); return; }
			this.setTime(isLooping ? timestamp - start : Math.min(duration, timestamp - start));
			if (!isLooping && this.time >= duration) { this.stop(); return; }
			this.animationFrame = window.requestAnimationFrame(tick);
		};
		this.animationFrame = window.requestAnimationFrame(tick);
	}

	private stop(): void {
		if (this.animationFrame !== undefined) { getWindow(this.domNode).cancelAnimationFrame(this.animationFrame); this.animationFrame = undefined; }
		this.playButton.label = localize('sessions.design.playMotion', 'Play');
	}
}
