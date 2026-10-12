import { Disposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ISpeechService, SpeechToTextState } from '../common/speechService.js';

export class SpeechAccessibilitySignalContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.speechAccessibilitySignal';

	constructor(
		@ISpeechService speech: ISpeechService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		super();
		let recordingAnnounced = speech.state === SpeechToTextState.Recording && !speech.isStarting;
		this._register(speech.onDidChangeState(state => {
			if (state === SpeechToTextState.Recording && !speech.isStarting && !recordingAnnounced) {
				recordingAnnounced = true;
				void signals.playSignal(AccessibilitySignal.voiceRecordingStarted);
			} else if (state === SpeechToTextState.Idle && recordingAnnounced) {
				recordingAnnounced = false;
				void signals.playSignal(AccessibilitySignal.voiceRecordingStopped);
			}
		}));
	}
}
