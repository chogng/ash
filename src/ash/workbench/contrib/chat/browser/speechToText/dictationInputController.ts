import { isCancellationError } from '../../../../../base/common/errors.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { observableFromEvent } from '../../../../../base/common/observable.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import type { ICommandAction } from '../../../../../platform/action/common/action.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { isModelPreparing } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { IDictationOnboardingService } from './dictationOnboarding.js';
import {
	IChatSpeechToTextService,
	ChatSpeechToTextState,
	isDictationActiveOnSurface,
	type ChatDictationSurface,
} from './chatSpeechToTextService.js';

import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	startDictation,
	stopDictationForEditor,
	isDictationActiveForEditor,
	onDidChangeDictationEditor,
	cancelDictation,
} from './dictationSession.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	ILocalTranscriptionModelService,
	type ILocalTranscriptionModelSnapshot,
} from '../../../../../platform/localTranscription/common/localTranscription.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { localize } from '../../../../../nls.js';

import { readDictationPreparation } from './dictationInput.js';
/** The target editor owns text and undo history; interim recognition stays outside its model. */
interface DictationTarget {
	readonly codeEditor?: ICodeEditor;
	insertText(text: string): void;
	focus(): void;
}

export class DictationInput extends Disposable {
	private active = false;
	private recordingGeneration = 0;
	private readonly recordingEvents = this._register(new MutableDisposable());
	private preparing = false;
	private committedText = '';
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	public getAccessibleContent(): string {
		return this.committedText + this.preview.textContent;
	}
	public get isActive(): boolean {
		return this.editor.codeEditor
			? isDictationActiveForEditor(this.editor.codeEditor)
			: this.active && isDictationActiveOnSurface(this.service, this.surface);
	}
	public readonly activeState = observableFromEvent(this, onDidChangeDictationEditor, () => this.isActive);
	public readonly onDidChange = onDidChangeDictationEditor;
	public get showButton(): boolean {
		return (
			this.configuration.getValue<boolean>('dictation.enabled') !== false &&
			this.configuration.getValue<boolean>('dictation.showButton') !== false
		);
	}
	public get isStarting(): boolean {
		return this.isActive && this.service.isBusy && this.service.state === ChatSpeechToTextState.Idle;
	}
	private get isAvailable(): boolean {
		return this.service.isConfigured;
	}
	public get action(): MenuItemAction {
		const active = this.isActive;
		const label = active
			? localize('chat.input.dictationStop', 'Stop dictation')
			: localize('chat.input.dictate', 'Dictate message');
		return new DictationInputAction(
			{
				id: 'workbench.action.chat.toggleSpeechToText',
				title: label,
				icon: active ? Lxicon.stopCircle : Lxicon.mic,
				tooltip:
					active || this.isAvailable
						? label
						: localize('chat.input.dictationUnavailable', 'Dictation is unavailable'),
				precondition:
					this.isAvailable &&
					(!this.service.isBusy || active) &&
					!this.isStarting &&
					this.service.state !== ChatSpeechToTextState.Transcribing
						? ContextKeyExpr.true()
						: ContextKeyExpr.false(),
				toggled:
					active && this.service.state === ChatSpeechToTextState.Recording
						? ContextKeyExpr.true()
						: ContextKeyExpr.false(),
			},
			this.contextKeys,
			this.commands,
			() => this.toggle(),
		);
	}

	constructor(
		private readonly editor: DictationTarget,
		private readonly preview: HTMLElement,
		private readonly isVisible: () => boolean,
		private readonly showPreparation: (snapshot: ILocalTranscriptionModelSnapshot) => Promise<void>,
		private readonly surface: ChatDictationSurface,
		@IChatSpeechToTextService private readonly service: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@ILocalTranscriptionModelService private readonly localTranscription: ILocalTranscriptionModelService,
		@ISpeechService private readonly speechProviders: ISpeechService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		const clearPreview = (): void => {
			preview.textContent = '';
			preview.hidden = true;
		};
		this._register(
			service.onDidChangeState(state => {
				if (state === ChatSpeechToTextState.Idle && !service.isBusy) {
					this.finish();
					clearPreview();
				}
			}),
		);
	}

	private async toggle(): Promise<void> {
		if (this.preparing) {
			return;
		}
		try {
			if (this.isActive) {
				await this.stop();
				return;
			}
			if (!this.isAvailable) {
				throw new Error(localize('chat.input.dictationUnavailable', 'Dictation is unavailable'));
			}
			if (this.service.isBusy) {
				return;
			}
			this.preparing = true;
			const preparation = await readDictationPreparation(
				this.configuration,
				this.localTranscription,
				this.speechProviders,
			);
			if (this.isDisposed || !this.isVisible() || this.service.isBusy) {
				return;
			}
			if (preparation && (!preparation.available || isModelPreparing(preparation.status))) {
				await this.showPreparation(preparation);
				return;
			}
			this.onboarding.showIfNeeded();
			await this.start();
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) {
				this.ended.fire(String(error));
			}
		} finally {
			this.preparing = false;
		}
	}

	public async start(): Promise<void> {
		if (this.service.isBusy) {
			return;
		}
		this.active = true;
		this.committedText = '';
		this.recordingEvents.clear();
		const owner = ++this.recordingGeneration;
		try {
			const events = new DisposableStore();
			this.recordingEvents.value = events;
			events.add(
				this.service.onDidUpdateTranscript(event => {
					if (!this.active || this.recordingGeneration !== owner || !this.isVisible()) return;
					const phrase = event.finalizedText.slice(this.committedText.length);
					this.committedText = event.finalizedText;
					this.preview.textContent = this.service.showTranscriptWhileDictating
						? event.text.slice(event.finalizedText.length)
						: '';
					this.preview.hidden = !this.preview.textContent;
					if (phrase && !this.editor.codeEditor) {
						this.editor.insertText(phrase);
						this.editor.focus();
						status(localize('chat.input.dictationInserted', 'Dictation added to message'));
					}
				}),
			);
			const window = this.preview.ownerDocument.defaultView as Window & typeof globalThis;
			if (this.editor.codeEditor)
				await startDictation(this.service, this.editor.codeEditor, window, this.logService, this.surface);
			else await this.service.start(window, this.surface);
		} catch (error) {
			this.active = false;
			throw error;
		}
	}

	private finish(error?: string): void {
		if (!this.active) return;
		this.active = false;
		this.recordingGeneration++;
		this.preview.textContent = '';
		this.preview.hidden = true;
		this.recordingEvents.clear();
		this.ended.fire(error);
	}

	public async stop(): Promise<void> {
		if (this.isActive) {
			if (this.editor.codeEditor) await stopDictationForEditor(this.editor.codeEditor);
			else await this.service.stopAndTranscribe();
		}
	}

	public async cancel(): Promise<void> {
		if (!this.active && !this.isActive) {
			return;
		}
		this.active = false;
		this.preview.textContent = '';
		this.preview.hidden = true;
		this.recordingGeneration++;
		this.recordingEvents.clear();
		if (this.editor.codeEditor && isDictationActiveForEditor(this.editor.codeEditor)) {
			cancelDictation();
			await stopDictationForEditor(this.editor.codeEditor);
		} else await this.service.cancel();
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}

/** Toolbar actions stay bound to their input even when clicking the button moves focus. */
class DictationInputAction extends MenuItemAction {
	constructor(
		item: ICommandAction,
		contextKeys: IContextKeyService,
		commands: ICommandService,
		private readonly toggle: () => Promise<void>,
	) {
		super(item, undefined, undefined, contextKeys, commands);
	}
	public override run(): Promise<void> {
		return this.toggle();
	}
}

/** Shared help follows the focused capture target, while its binding remains the transcript owner. */
export class DictationAccessibilityHelp extends Disposable {
	constructor(
		session: DictationInput,
		target: HTMLElement,
		surface: HTMLElement,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const focused = contextKeys.createKey<boolean>('dictationTargetFocused', false);
		focused.set(true);
		this._register(toDisposable(() => focused.reset()));
		const id = generateUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(
				AccessibleViewRegistry.register({
					type,
					priority: 115,
					name: `dictation-target-${id}-${type}`,
					when: ContextKeyExpr.has('dictationTargetFocused'),
					getProvider: () => {
						const focused = target.ownerDocument.activeElement as HTMLElement;
						if (!session.isActive || !target.contains(focused)) {
							return undefined;
						}
						return new AccessibleContentProvider(
							AccessibleViewProviderId.Dictation,
							{ type },
							() =>
								type === AccessibleViewType.Help
									? localize(
											'dictation.targetHelp',
											'Dictation is active. Completed phrases are inserted at the current editor selection or into terminal input. Terminal dictation never presses Enter. Use Tab to reach Stop and Cancel. Escape cancels recording and discards unfinished text. Use <keybinding:editor.action.accessibleView> to read the transcript.',
										)
									: session.getAccessibleContent(),
							() => focused.focus(),
							AccessibilityVerbositySettingId.Dictation,
						);
					},
				}),
			);
		}
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Dictation);
		surface.setAttribute('role', 'region');
		surface.setAttribute('aria-label', localize('dictation.controls', 'Dictation controls'));
		if (hint) {
			surface.setAttribute('aria-description', hint);
		}
	}
}
