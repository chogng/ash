import './media/dictationActionViewItem.css';
import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { createLoadingSpinner } from '../../../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { autorun, type IObservable } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import type { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoiceCodeTranscriptionBackendService, type IDictationInputOptions } from '../../../../../platform/dictation/common/dictation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { DictationConfiguration } from '../../common/constants.js';
import { IChatSpeechToTextService } from './chatSpeechToTextService.js';
import { getDictationMicrophoneChoices, readDictationOptions } from './dictationInput.js';
import { IDictationOnboardingService } from './dictationOnboarding.js';
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
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
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

		let options: IDictationInputOptions | undefined;
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
		this.contextMenus.showContextMenu({
			...delegate,
			getActions: () => actions,
			getActionViewItem: action => action === level ? new DictationLevelViewItem(level, () => this.isActive.get() ? this.speech.analyserNode : undefined) : undefined,
			getCheckedActionsRepresentation: () => 'radio',
			getMenuClassName: () => 'ash-dictation-settings-menu',
			anchorAlignment: AnchorAlignment.Right,
			anchorPosition: AnchorPosition.Above,
		});
	}

	private inputChoices(window: Window & typeof globalThis, options: IDictationInputOptions): IAction[] {
		const currentDevice = this.configuration.getValue<string>(DictationConfiguration.inputDevice) ?? '';
		const devices = getDictationMicrophoneChoices(options.inputDevices, currentDevice);
		const actions: IAction[] = devices.map(({ id, label, disconnected }, index) => ({
			id: `dictation.microphone.${index}`, label, tooltip: label, enabled: !disconnected, checked: currentDevice === id,
			run: async () => {
				if (disconnected) return;
				await this.configuration.updateValue(DictationConfiguration.inputDevice, id);
				if (this.isActive.get()) await this.speech.switchMicrophone(window, id);
				this.onboarding.refreshMicrophones(this.speech.analyserNode);
			},
		}));
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
	constructor(action: IAction, private readonly getAnalyser: () => AnalyserNode | undefined) { super(action); }

	override render(container: HTMLElement): void {
		container.setAttribute('aria-hidden', 'true');
		const row = h(container.ownerDocument, 'div', { className: 'ash-dictation-level' });
		appendIcon(Lxicon.mic, row);
		const meter = h(container.ownerDocument, 'meter');
		row.append(meter);
		container.append(row);
		const analyser = this.getAnalyser();
		if (!analyser) return;
		const window = getWindow(container);
		const samples = new Uint8Array(analyser.fftSize);
		let frame = 0;
		const update = (): void => {
			if (this.getAnalyser() !== analyser) { meter.value = 0; return; }
			analyser.getByteTimeDomainData(samples);
			meter.value = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
			frame = window.requestAnimationFrame(update);
		};
		frame = window.requestAnimationFrame(update);
		this._register(toDisposable(() => window.cancelAnimationFrame(frame)));
	}

	override setTabbable(): void { }
}
