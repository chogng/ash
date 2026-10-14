import { Disposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ISpeechService } from '../common/speechService.js';

export class SpeechAccessibilitySignalContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.speechAccessibilitySignal';

	constructor(
		@ISpeechService speech: ISpeechService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		super();
		let recordingAnnounced = speech.hasActiveSpeechToTextSession && !speech.isStarting;
		this._register(speech.onDidStartSpeechToTextSession(() => {
			if (recordingAnnounced) return;
			recordingAnnounced = true;
			void signals.playSignal(AccessibilitySignal.voiceRecordingStarted);
		}));
		this._register(speech.onDidEndSpeechToTextSession(() => {
			if (!recordingAnnounced) return;
			recordingAnnounced = false;
			void signals.playSignal(AccessibilitySignal.voiceRecordingStopped);
		}));
	}
}
