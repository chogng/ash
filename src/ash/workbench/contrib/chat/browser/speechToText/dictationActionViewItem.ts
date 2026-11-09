import './media/dictationActionViewItem.css';
import { addDisposableListener, getWindow, h, WindowIntervalTimer } from '../../../../../base/browser/dom.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { createLoadingSpinner } from '../../../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { autorun, autorunWithStore, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import type { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/dictation/common/dictation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { DictationConfiguration } from '../../common/constants.js';
import { IChatSpeechToTextService } from './chatSpeechToTextService.js';
import { showDictationMicFeedback } from './dictationMicFeedback.js';
import { readDictationOptions, type DictationMenuOptions } from './dictationInput.js';
import { addMicButtonContextMenuListener, getDictationContextMenuActions, SELECT_MICROPHONE_COMMAND } from './micButtonMenuActions.js';

/** The toolbar item stays navigable when only its settings action is available. */
export class DictationToolbarAction implements IAction {
	constructor(readonly primary: MenuItemAction) { }
	get id(): string { return this.primary.id; }
	get label(): string { return this.primary.label; }
	get tooltip(): string { return this.primary.tooltip; }
	readonly enabled = true;
	run(): unknown { return this.primary.enabled ? this.primary.run() : undefined; }
}

/** The split button owns presentation; settings and capture retain their existing owners. */
export class DictationActionViewItem extends DropdownWithPrimaryActionViewItem {
	constructor(
		action: MenuItemAction,
		private readonly isActive: IObservable<boolean>,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IVoiceCodeTranscriptionBackendService private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
		@ISpeechService private readonly speechProviders: ISpeechService,
		@IChatSpeechToTextService private readonly speech: IChatSpeechToTextService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		const label = localize('dictation.openSettings', 'Dictation settings');
		const dropdown: IAction = { id: 'chat.dictation.settings', label, tooltip: label, enabled: true, run() { } };
		super(action, dropdown, [dropdown], {
			showContextMenu: delegate => {
				void this.openSettingsMenu(delegate).catch(error => {
					delegate.onHide?.(true);
					onUnexpectedError(error);
				});
			},
		}, { separateButtons: true });
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-mic');
		const button = this.primaryButton!;
		button.classList.add('ash-chat-input-action', 'ash-chat-input-mic-action');
		button.classList.toggle('disabled', !this.action.enabled);
		if (this.isActive.get() && this.speech.isPreparingModel) {
			const label = h(button.ownerDocument, 'span');
			label.textContent = this.action.label;
			button.classList.add('ash-dictation-preparing');
			button.setAttribute('aria-label', this.action.tooltip);
			button.append(createLoadingSpinner(button.ownerDocument), label);
		}
		this._register(autorun(reader => button.setAttribute('aria-pressed', String(this.isActive.read(reader)))));
		this._register(showDictationMicFeedback(button, this.isActive, this.speech, this.accessibility));
		this._register(addMicButtonContextMenuListener(container, () =>
			getDictationContextMenuActions(this.commands, this.configuration, this.keybindings, this.action.id), this.contextMenus));
	}

	private async openSettingsMenu(delegate: IContextMenuDelegate): Promise<void> {
		const anchor = delegate.getAnchor() as HTMLElement;
		const window = getWindow(anchor);
		const focused = anchor.ownerDocument.activeElement;
		const pending = new DisposableStore();
		const cancel = (): void => {
			if (pending.isDisposed) return;
			pending.dispose();
			delegate.onHide?.(true);
		};
		if (delegate.cancellationToken) pending.add(delegate.cancellationToken.onCancellationRequested(cancel));
		pending.add(addDisposableListener(anchor.ownerDocument, 'pointerdown', event => {
			if (!event.composedPath().includes(anchor)) cancel();
		}, true));
		pending.add(addDisposableListener(anchor.ownerDocument, 'keydown', event => {
			if (event.key === 'Escape') cancel();
		}, true));

		let options: DictationMenuOptions | undefined;
		try {
			options = await readDictationOptions(window, this.configuration, this.backend, this.speechProviders);
		} catch {
			// The full settings and device picker are still useful when the backend is offline.
		}
		if (pending.isDisposed) return;
		if (this.isDisposed || !anchor.isConnected || anchor.ownerDocument.activeElement !== focused) {
			cancel();
			return;
		}
		pending.dispose();

		const fallback = getDictationContextMenuActions(this.commands, this.configuration, this.keybindings, this.action.id);
		const actions = fallback.filter(action => action.id === 'dictation.openSettings' || !options && action.id === SELECT_MICROPHONE_COMMAND);
		if (options) actions.unshift(...this.inputChoices(window, options), new Separator());
		const level = { id: 'dictation.inputLevel', label: '', tooltip: '', enabled: false, run() { } };
		actions.unshift(level);
		const deviceId = options?.microphones.hasMicrophone ? options.microphones.selectedDeviceId : undefined;
		this.contextMenus.showContextMenu({
			...delegate,
			getActions: () => actions,
			getActionViewItem: action => action === level ? new DictationLevelViewItem(level, this.speech, this.isActive, deviceId) : undefined,
			getCheckedActionsRepresentation: () => 'radio',
			getMenuClassName: () => 'ash-dictation-settings-menu',
			iconPlacement: 'trailing',
			anchorAlignment: AnchorAlignment.Right,
			anchorPosition: AnchorPosition.Above,
		});
	}

	private inputChoices(window: Window & typeof globalThis, options: DictationMenuOptions): IAction[] {
		const { choices, selectedDeviceId, hasMicrophone } = options.microphones;
		const actions: IAction[] = [];
		if (hasMicrophone) {
			actions.push(...choices.map(({ id, label, disconnected }, index) => ({
				id: `dictation.microphone.${index}`, label, tooltip: label, enabled: !disconnected, checked: selectedDeviceId === id,
				run: async () => {
					if (disconnected) return;
					await this.configuration.updateValue(DictationConfiguration.inputDevice, id);
					if (this.isActive.get()) await this.speech.switchMicrophone(window, id);
				},
			})));
		} else {
			const label = localize({ bundle: 'ash', key: 'dictation.noDevicesFound' }, 'No devices found');
			actions.push({ id: 'dictation.noDevicesFound', label, tooltip: label, enabled: false, run() { } });
		}
		if (options.languages.length) {
			const currentLanguage = this.configuration.getValue<string>(DictationConfiguration.language) ?? 'auto';
			const names = new Intl.DisplayNames([window.document.documentElement.lang || 'en'], { type: 'language' });
			const languages = [
				{ id: 'auto', label: localize({ bundle: 'ash', key: 'dictation.autoLanguage' }, 'Automatic language detection') },
				...options.languages.map(id => ({ id, label: names.of(id) ?? id })),
			];
			actions.push(new Separator(), new SubmenuAction('dictation.language', localize({ bundle: 'ash', key: 'dictation.language' }, 'Transcription language'), languages.map(({ id, label }) => ({
				id: `dictation.language.${id}`, label, tooltip: label, enabled: true, checked: currentLanguage === id,
				run: () => this.configuration.updateValue(DictationConfiguration.language, id),
			}))));
		}
		return actions;
	}
}

class DictationLevelViewItem extends ActionViewItem {
	constructor(
		action: IAction,
		private readonly speech: IChatSpeechToTextService,
		private readonly ownsRecording: IObservable<boolean>,
		private readonly deviceId: string | undefined,
	) { super(action); }

	override render(container: HTMLElement): void {
		const row = h(container.ownerDocument, 'div', { className: 'ash-dictation-level' });
		appendIcon(Lxicon.mic, row);
		const meter = h(container.ownerDocument, 'meter');
		meter.setAttribute('aria-label', localize({ bundle: 'ash', key: 'dictation.inputLevel' }, 'Microphone input level'));
		const track = h(container.ownerDocument, 'div', { className: 'ash-dictation-level-track' });
		const fill = h(container.ownerDocument, 'div', { className: 'ash-dictation-level-fill', attributes: { 'aria-hidden': 'true' } });
		track.append(meter, fill);
		row.append(track);
		container.append(row);
		const setLevel = (level: number): void => {
			if (meter.value === level) return;
			meter.value = level;
			fill.style.inlineSize = `${Math.round(level * 100)}%`;
		};

		const analyser = observableFromEvent(container, this.speech.onDidChangeState, () => this.speech.analyserNode);
		const busy = observableFromEvent(container, this.speech.onDidChangeState, () => this.speech.isBusy);
		this._register(autorunWithStore((reader, store) => {
			const recordingAnalyser = this.ownsRecording.read(reader) ? analyser.read(reader) : undefined;
			if (recordingAnalyser) {
				this.showLevel(row, setLevel, recordingAnalyser, store);
			} else if (!busy.read(reader) && this.deviceId !== undefined) {
				void this.previewLevel(row, setLevel, this.deviceId, store.add(new DisposableStore()));
			}
		}));
	}

	private async previewLevel(row: HTMLElement, setLevel: (level: number) => void, deviceId: string, lifetime: DisposableStore): Promise<void> {
		const window = getWindow(row);
		try {
			const stream = await window.navigator.mediaDevices.getUserMedia({
				audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
			});
			// The system can resolve a permission prompt after the menu has closed.
			const stopTracks = () => stream.getTracks().forEach(track => track.stop());
			if (lifetime.isDisposed) {
				stopTracks();
				return;
			}
			lifetime.add(toDisposable(stopTracks));
			const context = new window.AudioContext();
			lifetime.add(toDisposable(() => { void context.close().catch(() => undefined); }));
			const source = context.createMediaStreamSource(stream);
			const analyser = context.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.5;
			source.connect(analyser);
			lifetime.add(toDisposable(() => source.disconnect()));
			await context.resume();
			if (!lifetime.isDisposed) this.showLevel(row, setLevel, analyser, lifetime);
		} catch {
			// Permission and device errors leave the menu usable and the meter empty.
			lifetime.dispose();
		}
	}

	private showLevel(row: HTMLElement, setLevel: (level: number) => void, analyser: AnalyserNode, lifetime: DisposableStore): void {
		const bins = new Uint8Array(analyser.frequencyBinCount);
		const timer = lifetime.add(new WindowIntervalTimer(row));
		// The fill interpolates between samples, so the preview does not need to sample every frame.
		timer.cancelAndSet(() => {
			analyser.getByteFrequencyData(bins);
			let total = 0;
			for (const bin of bins) total += bin;
			setLevel(Math.min(100, Math.round(total * 100 / (bins.length * 128))) / 100);
		}, 50);
		lifetime.add(toDisposable(() => setLevel(0)));
	}

	override setTabbable(): void { }
}
