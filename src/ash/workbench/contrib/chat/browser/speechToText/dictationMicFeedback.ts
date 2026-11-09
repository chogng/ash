import './media/dictationMicFeedback.css';
import { getWindow, h } from '../../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunWithStore, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from './chatSpeechToTextService.js';

function readDictationLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
	analyser.getByteTimeDomainData(samples);
	let sum = 0;
	for (const sample of samples) sum += (sample - 128) ** 2;
	return Math.sqrt(sum / samples.length) / 128;
}

const waveformWidth = 112;
const waveformHeight = 20;
const waveformPitch = 7;
const waveformStroke = 2;
const waveformSampleMs = 80;
const svgNamespace = 'http://www.w3.org/2000/svg';

/** A short history of input levels, owned by the recording toolbar slot. */
export class DictationWaveformViewItem extends ActionViewItem {
	constructor(
		action: IAction,
		@IChatSpeechToTextService private readonly speech: IChatSpeechToTextService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) { super(action); }

	override render(container: HTMLElement): void {
		container.classList.add('ash-chat-dictation-waveform');
		container.setAttribute('aria-hidden', 'true');
		const document = container.ownerDocument;
		const svg = document.createElementNS(svgNamespace, 'svg');
		svg.setAttribute('width', String(waveformWidth));
		svg.setAttribute('height', String(waveformHeight));
		svg.setAttribute('viewBox', `0 0 ${waveformWidth} ${waveformHeight}`);
		const track = document.createElementNS(svgNamespace, 'g');
		const bars = Array.from({ length: waveformWidth / waveformPitch + 1 }, (_, index) => {
			const bar = document.createElementNS(svgNamespace, 'rect');
			bar.setAttribute('x', String(waveformPitch * (index + 0.5)));
			bar.setAttribute('width', String(waveformStroke));
			bar.setAttribute('rx', String(waveformStroke / 2));
			return bar;
		});
		const setHeight = (bar: SVGRectElement, height: number): void => {
			bar.setAttribute('y', String((waveformHeight - height) / 2));
			bar.setAttribute('height', String(height));
		};
		for (const bar of bars) setHeight(bar, waveformStroke);
		track.append(...bars);
		svg.append(track);
		container.append(svg);
		const window = getWindow(container);
		const analyser = observableFromEvent(container, this.speech.onDidChangeState, () => this.speech.analyserNode);
		const reducedMotion = observableFromEvent(container, this.accessibility.onDidChangeReducedMotion, () => this.accessibility.isMotionReduced());
		this._register(autorunWithStore((reader, store) => {
			const input = analyser.read(reader);
			if (reducedMotion.read(reader) || !input || typeof window.requestAnimationFrame !== 'function') return;
			const samples = new Uint8Array(Math.min(1024, input.fftSize));
			const heights = new Uint8Array(bars.length).fill(waveformStroke);
			let lastSample: number | undefined;
			const draw = (now: number): void => {
				lastSample ??= now - waveformSampleMs;
				const elapsed = now - lastSample;
				if (elapsed >= waveformSampleMs) {
					const steps = Math.min(bars.length, Math.floor(elapsed / waveformSampleMs));
					lastSample = now - elapsed % waveformSampleMs;
					const amplitude = readDictationLevel(input, samples);
					// Lift quiet speech above the noise floor while leaving room for louder peaks.
					const root = Math.sqrt(Math.max(0, (amplitude - 0.015) / 0.985));
					const level = 2 * root / (1 + root);
					const newest = waveformStroke + Math.round((waveformHeight - waveformStroke) * level);
					for (const [index, bar] of bars.entries()) {
						const height = index === bars.length - 1 ? newest : heights[index + steps] ?? waveformStroke;
						if (heights[index] === height) continue;
						heights[index] = height;
						setHeight(bar, height);
					}
				}
				// Move on every frame between audio samples, including when the input is quiet.
				track.style.transform = `translateX(${-(now - lastSample) / waveformSampleMs * waveformPitch}px)`;
				frame = window.requestAnimationFrame(draw);
			};
			let frame = window.requestAnimationFrame(draw);
			store.add(toDisposable(() => {
				window.cancelAnimationFrame(frame);
				track.style.removeProperty('transform');
				for (const bar of bars) setHeight(bar, waveformStroke);
			}));
		}));
	}

	override setTabbable(): void { }
}

/** The button owns the feedback, while the speech service owns the analyser. */
export function showDictationMicFeedback(button: HTMLElement, ownsRecording: IObservable<boolean>, speech: IChatSpeechToTextService, accessibility: IAccessibilityService): IDisposable {
	const recording = observableFromEvent(button, speech.onDidChangeState, () => speech.state === ChatSpeechToTextState.Recording);
	const reducedMotion = observableFromEvent(button, accessibility.onDidChangeReducedMotion, () => accessibility.isMotionReduced());
	return autorunWithStore((reader, store) => {
		if (!ownsRecording.read(reader) || !recording.read(reader)) return;
		button.classList.add('ash-dictation-recording');
		store.add(toDisposable(() => button.classList.remove('ash-dictation-recording')));
		const analyser = speech.analyserNode;
		if (reducedMotion.read(reader) || !analyser) return;

		const volume = h(button.ownerDocument, 'span', { className: 'ash-dictation-volume', attributes: { 'aria-hidden': 'true' } });
		button.append(volume);
		const samples = new Uint8Array(analyser.fftSize);
		let level = 0;
		let opacity = '';
		const animation = store.add(new AnimationFrameScheduler(getWindow(button), () => {
			const target = Math.min(1, readDictationLevel(analyser, samples) * 5);
			level += (target - level) * (target > level ? 0.4 : 0.15);
			const next = level.toFixed(2);
			if (next !== opacity) {
				volume.style.opacity = opacity = next;
			}
			animation.schedule();
		}));
		animation.schedule();
		store.add(toDisposable(() => volume.remove()));
	});
}
