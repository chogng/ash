import './media/dictationMicFeedback.css';
import { getWindow, h } from '../../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunWithStore, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import type { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { ChatSpeechToTextState, type IChatSpeechToTextService } from './chatSpeechToTextService.js';

export function readDictationLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
	analyser.getByteTimeDomainData(samples);
	return Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
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
