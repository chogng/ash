import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IAccessibilityService } from '../../accessibility/common/accessibility.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';

export class Sound {
	private constructor(public readonly fileName: string) { }
	public static readonly progress = new Sound('progress.mp3');
	public static readonly success = new Sound('success.mp3');
	public static readonly error = new Sound('error.mp3');
	public static readonly bell = new Sound('bell.mp3');
	public static readonly save = new Sound('save.mp3');
	public static readonly format = new Sound('format.mp3');
	public static readonly clear = new Sound('clear.mp3');
	public static readonly request = new Sound('request.mp3');
	public static readonly response = new Sound('response.mp3');
	public static readonly break = new Sound('break.mp3');
	public static readonly warning = new Sound('warning.mp3');
}

export class SoundSource {
	constructor(private readonly sound: Sound) { }
	public getSound(): Sound { return this.sound; }
}

export class AccessibilitySignal {
	private constructor(
		public readonly settingsKey: string,
		public readonly sound: SoundSource,
		private readonly label: () => string,
		private readonly announcement: (() => string) | undefined,
	) { }

	public get name(): string { return this.label(); }
	public get announcementMessage(): string | undefined { return this.announcement?.(); }

	public static readonly progress = new AccessibilitySignal(
		'accessibility.signals.progress', new SoundSource(Sound.progress),
		() => localize('accessibility.signals.progress.title', 'Progress signals'),
		() => localize('accessibility.signals.progress.message', 'Progress'),
	);
	public static readonly taskCompleted = new AccessibilitySignal(
		'accessibility.signals.taskCompleted', new SoundSource(Sound.success),
		() => localize('accessibility.signals.taskCompleted.title', 'Task completed'),
		() => localize('accessibility.signals.taskCompleted.message', 'Task completed'),
	);
	public static readonly taskFailed = new AccessibilitySignal(
		'accessibility.signals.taskFailed', new SoundSource(Sound.error),
		() => localize('accessibility.signals.taskFailed.title', 'Task failed'),
		() => localize('accessibility.signals.taskFailed.message', 'Task failed'),
	);
	public static readonly terminalCommandSucceeded = new AccessibilitySignal(
		'accessibility.signals.terminalCommandSucceeded', new SoundSource(Sound.success),
		() => localize('accessibility.signals.terminalCommandSucceeded.title', 'Terminal command succeeded'),
		() => localize('accessibility.signals.terminalCommandSucceeded.message', 'Command succeeded'),
	);
	public static readonly terminalCommandFailed = new AccessibilitySignal(
		'accessibility.signals.terminalCommandFailed', new SoundSource(Sound.error),
		() => localize('accessibility.signals.terminalCommandFailed.title', 'Terminal command failed'),
		() => localize('accessibility.signals.terminalCommandFailed.message', 'Command failed'),
	);
	public static readonly terminalBell = new AccessibilitySignal(
		'accessibility.signals.terminalBell', new SoundSource(Sound.bell),
		() => localize('accessibility.signals.terminalBell.title', 'Terminal bell'),
		() => localize('accessibility.signals.terminalBell.message', 'Terminal bell'),
	);
	public static readonly save = new AccessibilitySignal(
		'accessibility.signals.save', new SoundSource(Sound.save),
		() => localize('accessibility.signals.save.title', 'File saved'),
		() => localize('accessibility.signals.save.message', 'File saved'),
	);
	public static readonly format = new AccessibilitySignal(
		'accessibility.signals.format', new SoundSource(Sound.format),
		() => localize('accessibility.signals.format.title', 'Formatting completed'),
		() => localize('accessibility.signals.format.message', 'Formatting completed'),
	);
	public static readonly clear = new AccessibilitySignal(
		'accessibility.signals.clear', new SoundSource(Sound.clear),
		() => localize('accessibility.signals.clear.title', 'Terminal cleared'),
		() => localize('accessibility.signals.clear.message', 'Terminal cleared'),
	);
	public static readonly chatRequestSent = new AccessibilitySignal(
		'accessibility.signals.chatRequestSent', new SoundSource(Sound.request),
		() => localize('accessibility.signals.chatRequestSent.title', 'Chat request sent'),
		() => localize('accessibility.signals.chatRequestSent.message', 'Chat request sent'),
	);
	public static readonly chatResponseReceived = new AccessibilitySignal(
		'accessibility.signals.chatResponseReceived', new SoundSource(Sound.response),
		() => localize('accessibility.signals.chatResponseReceived.title', 'Chat response received'),
		undefined,
	);
	public static readonly chatUserActionRequired = new AccessibilitySignal(
		'accessibility.signals.chatUserActionRequired', new SoundSource(Sound.bell),
		() => localize('accessibility.signals.chatUserActionRequired.title', 'Chat requires your action'),
		() => localize('accessibility.signals.chatUserActionRequired.message', 'Chat requires your action'),
	);
	public static readonly voiceRecordingStarted = new AccessibilitySignal(
		'accessibility.signals.voiceRecordingStarted', new SoundSource(Sound.request),
		() => localize('accessibility.signals.voiceRecordingStarted.title', 'Voice recording started'),
		undefined,
	);
	public static readonly voiceRecordingStopped = new AccessibilitySignal(
		'accessibility.signals.voiceRecordingStopped', new SoundSource(Sound.response),
		() => localize('accessibility.signals.voiceRecordingStopped.title', 'Voice recording stopped'),
		undefined,
	);
	public static readonly onDebugBreak = new AccessibilitySignal(
		'accessibility.signals.onDebugBreak', new SoundSource(Sound.break),
		() => localize('accessibility.signals.onDebugBreak.title', 'Debugger paused'),
		() => localize('accessibility.signals.onDebugBreak.message', 'Debugger paused'),
	);
	public static readonly errorAtPosition = new AccessibilitySignal(
		'accessibility.signals.errorAtPosition', new SoundSource(Sound.error),
		() => localize('accessibility.signals.errorAtPosition.title', 'Error at cursor'),
		() => localize('accessibility.signals.errorAtPosition.message', 'Error at cursor'),
	);
	public static readonly warningAtPosition = new AccessibilitySignal(
		'accessibility.signals.warningAtPosition', new SoundSource(Sound.warning),
		() => localize('accessibility.signals.warningAtPosition.title', 'Warning at cursor'),
		() => localize('accessibility.signals.warningAtPosition.message', 'Warning at cursor'),
	);
	public static readonly errorOnLine = new AccessibilitySignal(
		'accessibility.signals.errorOnLine', new SoundSource(Sound.error),
		() => localize('accessibility.signals.errorOnLine.title', 'Error on line'),
		() => localize('accessibility.signals.errorOnLine.message', 'Error on line'),
	);
	public static readonly warningOnLine = new AccessibilitySignal(
		'accessibility.signals.warningOnLine', new SoundSource(Sound.warning),
		() => localize('accessibility.signals.warningOnLine.title', 'Warning on line'),
		() => localize('accessibility.signals.warningOnLine.message', 'Warning on line'),
	);
	public static readonly break = new AccessibilitySignal(
		'accessibility.signals.break', new SoundSource(Sound.break),
		() => localize('accessibility.signals.break.title', 'Breakpoint on line'),
		() => localize('accessibility.signals.break.message', 'Breakpoint on line'),
	);

	public static readonly diffLineInserted = new AccessibilitySignal(
		'accessibility.signals.diffLineInserted', new SoundSource(Sound.request),
		() => localize('accessibility.signals.diffLineInserted.title', 'Diff line inserted'),
		undefined,
	);

	public static readonly diffLineDeleted = new AccessibilitySignal(
		'accessibility.signals.diffLineDeleted', new SoundSource(Sound.clear),
		() => localize('accessibility.signals.diffLineDeleted.title', 'Diff line deleted'),
		undefined,
	);

	public static readonly diffLineModified = new AccessibilitySignal(
		'accessibility.signals.diffLineModified', new SoundSource(Sound.format),
		() => localize('accessibility.signals.diffLineModified.title', 'Diff line modified'),
		undefined,
	);

	public static readonly foldedArea = new AccessibilitySignal(
		'accessibility.signals.foldedArea', new SoundSource(Sound.format),
		() => localize('accessibility.signals.foldedArea.title', 'Folded area'),
		() => localize('accessibility.signals.foldedArea.message', 'Folded area'),
	);

	public static readonly inlineSuggestion = new AccessibilitySignal(
		'accessibility.signals.inlineSuggestion', new SoundSource(Sound.request),
		() => localize('accessibility.signals.inlineSuggestion.title', 'Inline suggestion'),
		undefined,
	);

	public static readonly chatEditModifiedFile = new AccessibilitySignal(
		'accessibility.signals.chatEditModifiedFile', new SoundSource(Sound.format),
		() => localize('accessibility.signals.chatEditModifiedFile.title', 'File modified by Chat'),
		() => localize('accessibility.signals.chatEditModifiedFile.message', 'File modified by Chat'),
	);

	public static readonly editsKept = new AccessibilitySignal(
		'accessibility.signals.editsKept', new SoundSource(Sound.success),
		() => localize('accessibility.signals.editsKept.title', 'Edits kept'),
		() => localize('accessibility.signals.editsKept.message', 'Edits kept'),
	);

	public static readonly editsUndone = new AccessibilitySignal(
		'accessibility.signals.editsUndone', new SoundSource(Sound.clear),
		() => localize('accessibility.signals.editsUndone.title', 'Edits undone'),
		() => localize('accessibility.signals.editsUndone.message', 'Edits undone'),
	);

	public static readonly codeActionTriggered = new AccessibilitySignal(
		'accessibility.signals.codeActionTriggered', new SoundSource(Sound.request),
		() => localize('accessibility.signals.codeActionTriggered.title', 'Code action triggered'),
		() => localize('accessibility.signals.codeActionTriggered.message', 'Code action triggered'),
	);

	public static readonly codeActionApplied = new AccessibilitySignal(
		'accessibility.signals.codeActionApplied', new SoundSource(Sound.success),
		() => localize('accessibility.signals.codeActionApplied.title', 'Code action applied'),
		() => localize('accessibility.signals.codeActionApplied.message', 'Code action applied'),
	);

	public static get allAccessibilitySignals(): readonly AccessibilitySignal[] {
		return [
			AccessibilitySignal.progress,
			AccessibilitySignal.taskCompleted,
			AccessibilitySignal.taskFailed,
			AccessibilitySignal.terminalCommandSucceeded,
			AccessibilitySignal.terminalCommandFailed,
			AccessibilitySignal.terminalBell,
			AccessibilitySignal.save,
			AccessibilitySignal.format,
			AccessibilitySignal.clear,
			AccessibilitySignal.chatRequestSent,
			AccessibilitySignal.chatResponseReceived,
			AccessibilitySignal.chatUserActionRequired,
			AccessibilitySignal.voiceRecordingStarted,
			AccessibilitySignal.voiceRecordingStopped,
			AccessibilitySignal.onDebugBreak,
			AccessibilitySignal.errorAtPosition,
			AccessibilitySignal.warningAtPosition,
			AccessibilitySignal.errorOnLine,
			AccessibilitySignal.warningOnLine,
			AccessibilitySignal.break,
			AccessibilitySignal.diffLineInserted,
			AccessibilitySignal.diffLineDeleted,
			AccessibilitySignal.diffLineModified,
			AccessibilitySignal.foldedArea,
			AccessibilitySignal.inlineSuggestion,
			AccessibilitySignal.chatEditModifiedFile,
			AccessibilitySignal.editsKept,
			AccessibilitySignal.editsUndone,
			AccessibilitySignal.codeActionTriggered,
			AccessibilitySignal.codeActionApplied,
		];
	}
}

export interface IAccessibilitySignalService {
	playSignal(signal: AccessibilitySignal): Promise<void>;
	/** The caller stops its loop by disposing the returned handle. */
	playSignalLoop(signal: AccessibilitySignal, milliseconds: number): IDisposable;
}

export const IAccessibilitySignalService = createServiceIdentifier<IAccessibilitySignalService>('accessibilitySignalService');

interface Playback {
	readonly audio: HTMLAudioElement;
	readonly signal: AccessibilitySignal;
	isPlaying: boolean;
	generation: number;
}

/** Window-scoped audio and announcements; configuration and screen-reader state remain with their services. */
export class AccessibilitySignalService extends Disposable implements IAccessibilitySignalService {
	private readonly audioResources = this._register(new DisposableStore());
	private readonly loops = this._register(new DisposableMap<number, RunOnceScheduler>());
	private readonly loopCounts = new Map<AccessibilitySignal, number>();
	private readonly playback = new Map<AccessibilitySignal, Playback>();
	private nextLoopId = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.loopCounts.clear()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('accessibility.signals') || event.affectsConfiguration('accessibility.signalOptions.volume')) {
				this.updateAudioPolicy();
			}
		}));
		this._register(accessibilityService.onDidChangeScreenReaderOptimized(() => this.updateAudioPolicy()));
	}

	public async playSignal(signal: AccessibilitySignal): Promise<void> {
		if (this.isDisposed) { return; }
		const policy = this.configurationService.getValue<{ sound: string; announcement?: string; }>(signal.settingsKey);
		// Embedded editors may not register Workbench signal preferences.
		if (!policy) { return; }
		const screenReader = this.accessibilityService.isScreenReaderOptimized();
		const message = signal.announcementMessage;
		if (policy.announcement === 'auto' && screenReader && message) {
			this.accessibilityService.status(message);
		}
		if (policy.sound === 'off' || (policy.sound === 'auto' && !screenReader)) { return; }
		const volume = this.configurationService.getValue<number>('accessibility.signalOptions.volume') / 100;
		if (volume === 0) { return; }
		const fileName = signal.sound.getSound().fileName;
		let playback = this.playback.get(signal);
		if (playback?.isPlaying) { return; }
		if (!playback) {
			const audio = h(mainWindow.document, 'audio');
			audio.src = new URL(`./media/${fileName}`, import.meta.url).href;
			playback = { audio, signal, isPlaying: false, generation: 0 };
			this.playback.set(signal, playback);
			const state = playback;
			this.audioResources.add(toDisposable(() => {
				this.stopAudio(state);
				audio.removeAttribute('src');
				audio.load();
				this.playback.delete(signal);
			}));
			this.audioResources.add(addDisposableListener(audio, 'ended', () => { state.isPlaying = false; }));
			this.audioResources.add(addDisposableListener(audio, 'error', () => {
				state.isPlaying = false;
				this.logService.warn('accessibilitySignal', 'Could not load a signal sound.', fileName, audio.error);
			}));
		}
		const generation = ++playback.generation;
		playback.audio.volume = volume;
		playback.audio.currentTime = 0;
		playback.isPlaying = true;
		try {
			await playback.audio.play();
		} catch (error) {
			// Pausing can reject an earlier play promise after a new cue has already started.
			if (this.isDisposed || generation !== playback.generation) { return; }
			playback.isPlaying = false;
			// Browsers may reject playback until a user gesture. A later cue can retry.
			this.logService.debug('accessibilitySignal', 'Could not play a signal sound.', fileName, error);
		}
	}

	public playSignalLoop(signal: AccessibilitySignal, milliseconds: number): IDisposable {
		this.assertNotDisposed();
		if (!Number.isFinite(milliseconds) || milliseconds <= 0) { throw new TypeError('Signal loop interval must be positive.'); }
		const id = this.nextLoopId++;
		const timer = new RunOnceScheduler(() => {
			void this.playSignal(signal);
			timer.schedule();
		}, milliseconds);
		this.loops.set(id, timer);
		this.loopCounts.set(signal, (this.loopCounts.get(signal) ?? 0) + 1);
		void this.playSignal(signal);
		timer.schedule();
		return toDisposable(() => {
			if (!this.loops.isDisposed) { this.loops.deleteAndDispose(id); }
			const remaining = (this.loopCounts.get(signal) ?? 1) - 1;
			if (remaining > 0) { this.loopCounts.set(signal, remaining); }
			else {
				this.loopCounts.delete(signal);
				const playback = this.playback.get(signal);
				if (playback) { this.stopAudio(playback); }
			}
		});
	}

	private updateAudioPolicy(): void {
		const volume = this.configurationService.getValue<number>('accessibility.signalOptions.volume') / 100;
		for (const playback of this.playback.values()) {
			const policy = this.configurationService.getValue<{ sound: string; }>(playback.signal.settingsKey);
			if (!policy) { this.stopAudio(playback); continue; }
			playback.audio.volume = volume;
			if (volume === 0 || policy.sound === 'off' || (policy.sound === 'auto' && !this.accessibilityService.isScreenReaderOptimized())) {
				this.stopAudio(playback);
			}
		}
	}

	private stopAudio(playback: Playback): void {
		playback.generation++;
		playback.audio.pause();
		playback.isPlaying = false;
	}
}
