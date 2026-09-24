import './findOptionsWidget.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { type IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../browser/editorBrowser.js';
import { FIND_IDS } from './findModel.js';
import { FindReplaceState } from './findState.js';

/** Briefly shows active find options when the main find widget is closed. */
export class FindOptionsWidget extends Disposable implements IOverlayWidget {
	private readonly root: HTMLDivElement;
	private readonly caseButton: HTMLButtonElement;
	private readonly wordButton: HTMLButtonElement;
	private readonly regexButton: HTMLButtonElement;
	private readonly hideSoon = this._register(new RunOnceScheduler(() => this.hide(), 2000));

	constructor(private readonly editor: ICodeEditor, private readonly state: FindReplaceState, keybindingService: IKeybindingService, hoverService: IHoverService) {
		super();
		const ownerDocument = editor.getContainerDomNode().ownerDocument;
		this.root = h(ownerDocument, 'div');
		this.root.className = 'stanza-editor-find-options-widget';
		this.root.hidden = true;
		this.root.setAttribute('role', 'group');
		this.root.setAttribute('aria-label', localize('findOptions.label', 'Find options'));
		this.caseButton = this.button(ownerDocument, localize('label.matchCase', 'Match case'), 'Aa', () => state.change({ matchCase: !state.matchCase }, false));
		this.wordButton = this.button(ownerDocument, localize('label.wholeWord', 'Match whole word'), 'W', () => state.change({ wholeWord: !state.wholeWord }, false));
		this.regexButton = this.button(ownerDocument, localize('label.regex', 'Use regular expression'), '.*', () => state.change({ isRegex: !state.isRegex }, false));
		const buttonHovers = [
			{ button: this.caseButton, command: FIND_IDS.ToggleCaseSensitiveCommand },
			{ button: this.wordButton, command: FIND_IDS.ToggleWholeWordCommand },
			{ button: this.regexButton, command: FIND_IDS.ToggleRegexCommand },
		].map(({ button, command }) => ({
			button,
			command,
			hover: this._register(hoverService.setupHover({
				target: button,
				content: button.getAttribute('aria-label')!,
				groupId: 'find-options-widget',
			})),
		}));
		const updateHoverLabels = (): void => {
			for (const { button, command, hover } of buttonHovers) {
				const binding = keybindingService.lookupKeybinding(command);
				hover.update(`${button.getAttribute('aria-label')}${binding ? ` (${getKeybindingLabel(binding)})` : ''}`);
			}
		};
		updateHoverLabels();
		this._register(keybindingService.onDidUpdateKeybindings(updateHoverLabels));
		this.root.append(this.caseButton, this.wordButton, this.regexButton);
		this._register(state.onFindReplaceStateChange(event => {
			this.checked(this.caseButton, state.matchCase);
			this.checked(this.wordButton, state.wholeWord);
			this.checked(this.regexButton, state.isRegex);
			if (event.isRevealed && state.isRevealed) this.hide();
			else if (!state.isRevealed && (event.matchCase || event.wholeWord || event.isRegex)) this.highlightFindOptions();
		}));
		this._register(addDisposableListener(this.root, 'mouseenter', () => this.hideSoon.cancel()));
		this._register(addDisposableListener(this.root, 'mouseleave', () => this.hideSoon.schedule()));
		editor.addOverlayWidget(this);
		this._register(toDisposable(() => editor.removeOverlayWidget(this)));
	}

	public getId(): string { return `${this.editor.getId()}.findOptionsWidget`; }
	public getDomNode(): HTMLElement { return this.root; }
	public getPosition(): IOverlayWidgetPosition { return { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }; }
	public highlightFindOptions(): void {
		if (this.state.isRevealed) return;
		this.root.hidden = false;
		this.hideSoon.schedule();
		this.editor.layoutOverlayWidget(this);
	}

	private hide(): void { this.root.hidden = true; }
	private button(ownerDocument: Document, label: string, text: string, onClick: () => void): HTMLButtonElement {
		const button = h(ownerDocument, 'button');
		button.type = 'button';
		button.textContent = text;
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-pressed', 'false');
		this._register(addDisposableListener(button, 'click', onClick));
		return button;
	}
	private checked(button: HTMLButtonElement, value: boolean): void { button.setAttribute('aria-pressed', String(value)); }
}
