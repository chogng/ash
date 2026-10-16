import { IChatSpeechToTextService } from '../../chat/browser/speechToText/chatSpeechToTextService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ISpeechService } from '../common/speechService.js';

export class SpeechAccessibilitySignalContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.speechAccessibilitySignal';

	constructor(
		@ISpeechService speech: ISpeechService,
		@IChatSpeechToTextService dictation: IChatSpeechToTextService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		super();
		let extensionRecording = speech.hasActiveSpeechToTextSession;
		let recordingAnnounced = extensionRecording || dictation.isBusy && !dictation.isStarting;
		const update = (): void => {
			const recording = extensionRecording || dictation.isBusy && !dictation.isStarting;
			if (recording === recordingAnnounced) return;
			recordingAnnounced = recording;
			void signals.playSignal(recording ? AccessibilitySignal.voiceRecordingStarted : AccessibilitySignal.voiceRecordingStopped);
		};
		this._register(speech.onDidStartSpeechToTextSession(() => { extensionRecording = true; update(); }));
		this._register(speech.onDidEndSpeechToTextSession(() => { extensionRecording = false; update(); }));
		this._register(dictation.onDidChangeState(update));
	}
}
