import { h, type IDimension } from '../../../../base/browser/dom.js';
import './media/emptyFileEditor.css';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import type { IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** The file tree remains in Details; the landing tab explains where to open a document. */
export class EmptyFileEditor extends Disposable implements IEditorPane {
	public readonly id = 'ash.sessions.emptyFileEditor';
	private domNode!: HTMLElement;
	constructor(
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
	}
	public create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'p');
		this.domNode.className = 'ash-sessions-editor-message';
		this.domNode.tabIndex = 0;
		this.domNode.textContent = localize('sessions.layout.chooseFile', 'Choose a file in Details to open it here.');
		parent.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('sessionsFilesLandingFocused', true);
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Explorer);
			if (hint) {
				this.domNode.setAttribute('aria-description', hint);
			} else {
				this.domNode.removeAttribute('aria-description');
			}
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Explorer)) {
				updateHint();
			}
		}));
		updateHint();
	}
	public async setInput(_input: EditorInput, _signal: AbortSignal): Promise<void> { }
	public clearInput(): void { }
	public setVisible(): void { }
	public layout(_dimension: IDimension): void { }
	public focus(): void { this.domNode.focus(); }
}
