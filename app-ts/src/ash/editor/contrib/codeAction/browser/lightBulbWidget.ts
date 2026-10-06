import './lightBulbWidget.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { localize } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ContentWidgetPositionPreference, type IContentWidget, type IContentWidgetPosition, type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption, ShowLightbulbIconMode } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { type CodeActionSet, type CodeActionTrigger } from '../common/types.js';

/** Anchors the automatic suggestion beside code and opens the same action menu as Quick Fix. */
export class LightBulbWidget extends Disposable implements IContentWidget {
	public static readonly ID = 'editor.contrib.lightbulbWidget';
	public readonly suppressMouseDown = true;
	private readonly element: HTMLElement;
	private readonly button: Button;
	private position: Position | undefined;
	private trigger: CodeActionTrigger | undefined;
	private readonly clicked = this._register(new Emitter<CodeActionTrigger>());
	public readonly onClick = this.clicked.event;

	constructor(private readonly editor: ICodeEditor, @IKeybindingService private readonly keybindings: IKeybindingService) {
		super();
		this.element = h(editor.getDomNode()!.ownerDocument, 'div');
		this.element.className = 'ash-editor-lightbulb';
		this.button = this._register(new Button(this.element, {
			label: localize('codeAction.lightbulb', 'Show code actions'), icon: Lxicon.lightning, iconOnly: true,
			presentation: 'quiet', size: 'small', onClick: () => { if (this.trigger) { this.clicked.fire(this.trigger); } },
		}));
		this._register(keybindings.onDidUpdateKeybindings(() => this.updateLabel()));
		this.updateLabel();
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
	}

	public getId(): string { return LightBulbWidget.ID; }
	public getDomNode(): HTMLElement { return this.element; }
	public getPosition(): IContentWidgetPosition | null {
		return this.position ? { position: this.position, preference: [ContentWidgetPositionPreference.EXACT] } : null;
	}
	public update(actions: CodeActionSet, trigger: CodeActionTrigger, atPosition: Position): void {
		const model = this.editor.getModel();
		const mode = this.editor.getOption(EditorOption.lightbulb).enabled;
		if (!model || actions.validActions.length === 0 || mode === ShowLightbulbIconMode.Off
			|| (mode === ShowLightbulbIconMode.OnCode && model.getLineContent(atPosition.lineNumber).trim().length === 0)) {
			this.hide();
			return;
		}
		this.position = new Position(atPosition.lineNumber, model.getLineMaxColumn(atPosition.lineNumber));
		this.trigger = trigger;
		this.element.classList.toggle('has-preferred-fix', actions.hasAutoFix);
		this.editor.layoutContentWidget(this);
	}
	public hide(): void { this.position = undefined; this.trigger = undefined; this.editor.layoutContentWidget(this); }
	private updateLabel(): void {
		const binding = this.keybindings.lookupKeybinding('editor.action.quickFix');
		const shortcut = binding ? getKeybindingLabel(binding) : undefined;
		this.button.domNode.title = shortcut
			? localize('codeAction.lightbulbShortcut', 'Show code actions ({0})', shortcut)
			: localize('codeAction.lightbulb', 'Show code actions');
	}
}
