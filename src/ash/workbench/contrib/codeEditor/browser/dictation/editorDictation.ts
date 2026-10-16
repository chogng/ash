import { Event } from '../../../../../base/common/event.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { localize2, localize } from '../../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import './editorDictation.css';
import { h, addDisposableListener } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor, OverlayWidgetPositionPreference, type IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { EditorAction2, EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { DictationInput, DictationAccessibilityHelp } from '../../../chat/browser/speechToText/dictationInputController.js';
import { IDictationOnboardingService } from '../../../chat/browser/speechToText/dictationOnboarding.js';


/** Editing and undo remain with the target code editor, including asynchronous finalization. */
export class EditorDictation extends Disposable {
	public static readonly ID = 'editorDictation';
	private readonly session: DictationInput;
	private readonly widget: IOverlayWidget;
	private readonly dictationHost = this._register(new MutableDisposable());
	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService instantiation: IInstantiationService,
		@IChatSpeechToTextService speech: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IEditorService editorService: IEditorService,
		@IPreferencesService preferences: IPreferencesService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const domNode = h(editor.getContainerDomNode().ownerDocument, 'div');
		domNode.className = 'ash-editor-dictation';
		const controls = h(domNode.ownerDocument, 'div');
		controls.className = 'ash-editor-dictation-controls';
		const preview = h(domNode.ownerDocument, 'p');
		preview.setAttribute('role', 'status');
		domNode.append(controls, preview);
		const target = {
			codeEditor: editor,
			insertText: (text: string): void => {
				const selection = editor.getSelection();
				if (!selection || editor.getOption(EditorOption.readOnly)) { return; }
				editor.pushUndoStop();
				editor.executeEdits('dictation', [{ range: selection, text }], inverseEdits =>
					inverseEdits.map(edit => Selection.fromPositions(edit.range.getEndPosition())));
				editor.pushUndoStop();
			},
			focus: (): void => editor.focus(),
		};
		this.session = this._register(instantiation.createInstance(
			DictationInput,
			target,
			preview,
			() => !this.isDisposed && !editor.getContainerDomNode().closest('[hidden]') && !editor.getOption(EditorOption.readOnly),
			async () => { await preferences.openSettings({ section: 'dictation' }); },
			'editor',
		));
		this._register(instantiation.createInstance(DictationAccessibilityHelp, this.session, editor.getContainerDomNode(), controls));
		const stop = this._register(new Button(controls, { label: localize({ bundle: 'ash', key: 'dictation.stop' }, 'Stop dictation') }));
		const cancel = this._register(new Button(controls, { label: localize({ bundle: 'ash', key: 'dictation.cancel' }, 'Cancel dictation'), presentation: 'quiet' }));
		this._register(stop.onDidClick(() => { void this.session.stop().catch(error => notifications.error(String(error))); }));
		this._register(cancel.onDidClick(() => { void this.session.cancel().catch(error => notifications.error(String(error))); }));
		this._register(this.session.onDidEnd(error => { if (error) notifications.error(error); controls.hidden = !this.session.isActive; stop.enabled = !this.session.isStarting && speech.state !== ChatSpeechToTextState.Transcribing; }));
		this._register(Event.any(speech.onDidChangeState, Event.map(this.session.onDidChange, () => speech.state))(() => {
			controls.hidden = !this.session.isActive;
			stop.enabled = !this.session.isStarting && speech.state !== ChatSpeechToTextState.Transcribing;
		}));
		controls.hidden = true;
		this.widget = {
			getId: () => `ash.dictation.${editor.getId()}`,
			getDomNode: () => domNode,
			getPosition: () => ({ preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }),
		};
		editor.addOverlayWidget(this.widget);
		this._register(addDisposableListener(editor.getContainerDomNode(), 'keydown', event => {
			if (event.key === 'Escape' && this.session.isActive) {
				event.preventDefault();
				event.stopPropagation();
				void this.session.cancel().catch(error => notifications.error(String(error)));
			}
		}, true));
		this._register(editorService.onDidVisibleEditorsChange(() => {
			if (editor.getContainerDomNode().closest('[hidden]')) {
				this.dictationHost.clear();
				void this.session.cancel().catch(error => notifications.error(String(error)));
			}
		}));
		this._register(editor.onWillChangeModel(() => {
			this.dictationHost.clear();
			void this.session.cancel().catch(error => notifications.error(String(error)));
		}));
	}
	public async start(): Promise<void> {
		if (!this.editor.isSimpleWidget && !this.editor.getOption(EditorOption.readOnly)) {
			if (!this.dictationHost.value) this.dictationHost.value = this.onboarding.registerHost({ container: this.widget.getDomNode(), focusRoot: this.editor.getContainerDomNode(), focus: () => this.editor.focus() });
			this.editor.focus(); await this.session.action.run();
		}
	}
	public stop(): Promise<void> { return this.session.stop(); }
	protected override disposeCore(): void {
		this.dictationHost.clear();
		this.editor.removeOverlayWidget(this.widget);
		super.disposeCore();
	}
}

registerEditorContribution(EditorDictation.ID, EditorDictation, EditorContributionInstantiation.Lazy);
registerAction2(class EditorDictationStartAction extends EditorAction2 {
	constructor() {
		super({
			id: 'workbench.action.editorDictation.start',
			title: localize2({ bundle: 'ash', key: 'dictation.editorStart' }, 'Editor: Start dictation'),
			f1: true,
			precondition: EditorContextKeys.writable,
			keybinding: {
				primary: Keybinding.single(logicalKey('v', { primaryKey: true, altKey: true })),
				when: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
			menu: { id: MenuId.EditorContext, group: '1_modification', order: 6, when: EditorContextKeys.writable },
		});
	}
	public override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> | undefined { return editor.getContribution<EditorDictation>(EditorDictation.ID)?.start(); }
});
registerAction2(class EditorDictationStopAction extends EditorAction2 {
	constructor() {
		super({
			id: 'workbench.action.editorDictation.stop',
			title: localize2({ bundle: 'ash', key: 'dictation.editorStop' }, 'Editor: Stop dictation'),
			f1: true,
		});
	}
	public override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> | undefined { return editor.getContribution<EditorDictation>(EditorDictation.ID)?.stop(); }
});
