import './terminalVoice.css';
import { h, addDisposableListener } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IDictationOnboardingService } from '../../../chat/browser/speechToText/dictationOnboarding.js';
import { DictationSession, DictationAccessibilityHelp } from '../../../chat/browser/speechToText/dictationSession.js';
import { localize } from '../../../../../nls.js';

/** Speech only edits shell input. Enter and terminal control sequences must stay user actions. */
export function postProcessTerminalDictation(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** Capture remains bound to the instance selected at start; switching or hiding discards it. */
export class TerminalVoiceSession extends Disposable {
	private readonly session: DictationSession;
	private readonly targetState = this._register(new MutableDisposable<DisposableStore>());
	private target: ITerminalInstance | undefined;
	private readonly element: HTMLElement;
	constructor(
		container: HTMLElement,
		private readonly isVisible: () => boolean,
		private readonly focus: () => void,
		@IInstantiationService instantiation: IInstantiationService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IChatSpeechToTextService speech: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IPreferencesService preferences: IPreferencesService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.element = h(container.ownerDocument, 'div');
		this.element.className = 'ash-terminal-dictation';
		container.prepend(this.element);
		const controls = h(container.ownerDocument, 'div');
		controls.className = 'ash-terminal-dictation-controls';
		const preview = h(container.ownerDocument, 'p');
		preview.setAttribute('role', 'status');
		this.element.append(controls, preview);
		this.session = this._register(instantiation.createInstance(
			DictationSession,
			{
				insertText: (text: string) => { this.target!.write(postProcessTerminalDictation(text)); },
				focus,
			},
			preview,
			() => isVisible() && this.target === terminals.activeInstance && this.target?.state === 'running',
			async () => { await preferences.openSettings('dictation'); },
		));
		this._register(instantiation.createInstance(DictationAccessibilityHelp, this.session, container, controls));
		this._register(onboarding.registerHost({ container: this.element, focusTarget: container, isVisible }));
		const stop = this._register(new Button(controls, { label: localize({ bundle: 'ash', key: 'dictation.stop' }, 'Stop dictation') }));
		const cancel = this._register(new Button(controls, { label: localize({ bundle: 'ash', key: 'dictation.cancel' }, 'Cancel dictation'), presentation: 'quiet' }));
		this._register(stop.onDidClick(() => { void this.stop().catch(error => notifications.error(String(error))); }));
		this._register(cancel.onDidClick(() => this.hide()));
		this._register(this.session.onDidEnd(error => { if (error) { notifications.error(error); } }));
		controls.hidden = true;
		this._register(speech.onDidChangeState(() => {
			controls.hidden = !this.session.isActive;
			stop.enabled = !speech.isStarting && speech.state !== ChatSpeechToTextState.Transcribing;
		}));
		this._register(terminals.onDidChangeActiveInstance(() => this.hide()));
		this._register(terminals.onDidDisposeInstance(instance => { if (instance === this.target) { this.hide(); } }));
		this._register(terminals.onDidChangeInstances(() => { if (this.target?.state !== 'running') { this.hide(); } }));
		this._register(addDisposableListener(container, 'keydown', event => {
			if (event.key === 'Escape' && this.session.isActive) {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
			}
		}, true));
	}
	public async start(): Promise<void> {
		if (!this.isVisible() || this.terminals.activeInstance?.state !== 'running') { return; }
		this.focus();
		this.target = this.terminals.activeInstance;
		const lifetime = new DisposableStore();
		this.targetState.value = lifetime;
		lifetime.add(this.target.onDidChangeState(state => { if (state !== 'running') { this.hide(); } }));
		lifetime.add(this.target.onDidExit(() => this.hide()));
		await this.session.action.run();
	}
	public stop(): Promise<void> { return this.session.stop(); }
	public hide(): void {
		this.targetState.clear();
		this.onboarding.hide(this.element);
		void this.session.cancel().catch(error => this.notifications.error(String(error)));
	}
	protected override disposeCore(): void {
		this.hide();
		this.element.remove();
		super.disposeCore();
	}
}
