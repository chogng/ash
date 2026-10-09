import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, AccessibilitySignalService, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { AccessibilityProgressSignalScheduler } from '../../../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ITaskService } from '../../../services/tasks/common/taskService.js';
import { ITerminalService, type ITerminalInstance } from '../../terminal/browser/terminal.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../chat/browser/speechToText/chatSpeechToTextService.js';
import { SaveAccessibilitySignal } from './saveAccessibilitySignal.js';
import { AccessibilitySignalDebuggerContribution } from './accessibilitySignalDebuggerContribution.js';
import { EditorTextPropertySignalsContribution } from './editorTextPropertySignalsContribution.js';

registerSingleton(IAccessibilitySignalService, AccessibilitySignalService, InstantiationType.Delayed);

class TaskProgressAccessibilityContribution extends Disposable {
	private readonly progress = this._register(new MutableDisposable<AccessibilityProgressSignalScheduler>());

	constructor(
		@ITaskService private readonly taskService: ITaskService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAccessibilitySignalService signals: IAccessibilitySignalService,
	) {
		super();
		this._register(taskService.onDidStartTask(() => this.updateProgress()));
		this._register(taskService.onDidChangeTaskRun(run => {
			this.updateProgress();
			if (run.status === 'succeeded' || run.status === 'completed') { void signals.playSignal(AccessibilitySignal.taskCompleted); }
			if (run.status === 'failed') { void signals.playSignal(AccessibilitySignal.taskFailed); }
		}));
		this.updateProgress();
	}

	private updateProgress(): void {
		// TaskService owns execution state; concurrent tasks share one quiet progress cue.
		if (this.taskService.activeRuns.length === 0) {
			this.progress.clear();
		} else if (!this.progress.value) {
			this.progress.value = this.instantiationService.createInstance(AccessibilityProgressSignalScheduler, 5000, undefined);
		}
	}
}

registerWorkbenchContribution('workbench.contrib.taskProgressAccessibility', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(TaskProgressAccessibilityContribution));

class TerminalAccessibilityContribution extends Disposable {
	private readonly terminals = this._register(new DisposableMap<ITerminalInstance, DisposableStore>());

	constructor(@ITerminalService terminals: ITerminalService, @ITaskService tasks: ITaskService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		const taskTerminals = new Set(tasks.activeRuns.map(run => run.terminalId));
		this._register(toDisposable(() => taskTerminals.clear()));
		this._register(tasks.onDidStartTask(run => taskTerminals.add(run.terminalId)));
		const attach = (instance: ITerminalInstance): void => {
			const lifetime = new DisposableStore();
			this.terminals.set(instance, lifetime);
			lifetime.add(instance.onDidChangeCommandStatus(event => {
				// The task contribution owns results for task terminals, even when the panel is hidden.
				if (taskTerminals.has(instance.id)) { return; }
				if (event.status === 'succeeded') { void signals.playSignal(AccessibilitySignal.terminalCommandSucceeded); }
				if (event.status === 'failed') { void signals.playSignal(AccessibilitySignal.terminalCommandFailed); }
			}));
		};
		this._register(terminals.onDidCreateInstance(attach));
		this._register(terminals.onDidDisposeInstance(instance => {
			taskTerminals.delete(instance.id);
			this.terminals.deleteAndDispose(instance);
		}));
		for (const instance of terminals.instances) { attach(instance); }
	}
}

class ChatAccessibilityContribution extends Disposable {
	constructor(@IChatService chat: IChatService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		// This is a bounded notification cursor, not a second copy of turn state.
		const cursors = new Map<string, number>();
		this._register(toDisposable(() => cursors.clear()));
		this._register(chat.onDidBecomeReady(() => cursors.clear()));
		this._register(chat.onDidUpdateThread(envelope => {
			if (envelope.update.type !== 'committed') { return; }
			const key = JSON.stringify([envelope.sessionId, envelope.threadId]);
			if (envelope.durableSequence <= (cursors.get(key) ?? -1)) { return; }
			cursors.delete(key);
			cursors.set(key, envelope.durableSequence);
			if (cursors.size > 100) { cursors.delete(cursors.keys().next().value!); }
			const event = envelope.update.event;
			if (event.type === 'turnAccepted') { void signals.playSignal(AccessibilitySignal.chatRequestSent); }
			if (event.type === 'turnCompleted' || event.type === 'turnFailed') { void signals.playSignal(AccessibilitySignal.chatResponseReceived); }
			if (event.type === 'interactionRequested' && event.interaction.request.type !== 'dynamicTool') {
				void signals.playSignal(AccessibilitySignal.chatUserActionRequired);
			}
		}));
	}
}

class VoiceRecordingAccessibilityContribution extends Disposable {
	constructor(@IChatSpeechToTextService speech: IChatSpeechToTextService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		let recordingAnnounced = speech.state === ChatSpeechToTextState.Recording && !speech.isStarting;
		this._register(speech.onDidChangeState(state => {
			if (state === ChatSpeechToTextState.Recording && !speech.isStarting && !recordingAnnounced) {
				recordingAnnounced = true;
				void signals.playSignal(AccessibilitySignal.voiceRecordingStarted);
			} else if (state === ChatSpeechToTextState.Idle && recordingAnnounced) {
				recordingAnnounced = false;
				void signals.playSignal(AccessibilitySignal.voiceRecordingStopped);
			}
		}));
	}
}

for (const [id, contribution] of [
	['workbench.contrib.terminalAccessibilitySignals', TerminalAccessibilityContribution],
	['workbench.contrib.chatAccessibilitySignals', ChatAccessibilityContribution],
	['workbench.contrib.voiceRecordingAccessibilitySignals', VoiceRecordingAccessibilityContribution],
	['workbench.contrib.saveAccessibilitySignals', SaveAccessibilitySignal],
	['workbench.contrib.debugAccessibilitySignals', AccessibilitySignalDebuggerContribution],
	['workbench.contrib.editorTextPropertySignals', EditorTextPropertySignalsContribution],
] as const) {
	registerWorkbenchContribution(id, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(contribution));
}
