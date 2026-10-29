import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditor, BrowserEditorContribution } from '../browserEditor.js';
import { BrowserWelcomeFeature } from './browserWelcomeFeature.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { WebContentsViewHost } from '../webContentsViewHost.js';

/** Owns page presentation policy; the host owns compositor bounds, overlap and focus coordination. */
export class WebContentsViewRendererFeature extends BrowserEditorContribution {
	private readonly host: WebContentsViewHost;
	private model: IBrowserViewModel | undefined;
	private visible = false;
	private readonly welcome: BrowserWelcomeFeature;
	constructor(
		editor: BrowserEditor,
		@IInstantiationService instantiation: IInstantiationService,
		@IEditorPart private readonly editors: IEditorPart,
		@ICommandService private readonly commands: ICommandService,
	) {
		super(editor);
		this.host = this._register(
			instantiation.createInstance(WebContentsViewHost, editor.browserContainer.ownerDocument.defaultView!),
		);
		this.welcome = this._register(new BrowserWelcomeFeature(editor.browserContainer));
	}
	override onContainerCreated(container: HTMLElement): void {
		this.host.onContainerCreated(container);
	}
	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this.model = model;
		this.host.setModel(model);
		store.add(model.onDidChangeState(() => this.update()));
		store.add(
			model.onDidEvent(event => {
				if (event.type === 'focusAddress' && this.host.isActive) {
					this.editor.focus();
				}
				if (event.type !== 'keyDown' || !this.host.isActive) {
					return;
				}
				const group = this.editors.groups.find(group => group.activePane === this.editor);
				if (group) {
					this.editors.activateGroup(group.id);
				}
				const key = event.event;
				if (key.key === 'F6' || ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === 'l')) {
					this.editor.focus();
				} else if ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === 'f') {
					void this.commands
						.executeCommand(BrowserViewCommandId.ShowFind)
						.catch(error => this.editor.report(error));
				} else if (key.key === 'F3') {
					void this.commands
						.executeCommand(
							key.shiftKey ? BrowserViewCommandId.FindPrevious : BrowserViewCommandId.FindNext,
						)
						.catch(error => this.editor.report(error));
				} else {
					this.editor.browserContainer.dispatchEvent(
						new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }),
					);
				}
			}),
		);
		this.update();
	}
	override onModelDetached(): void {
		this.model = undefined;
		this.host.setModel(undefined);
		this.update();
	}
	override onPaneVisibilityChanged(visible: boolean): void {
		this.visible = visible;
		this.update();
	}
	override afterContainerLayout(): void {
		this.host.layout();
	}
	private update(): void {
		this.welcome.update(this.model?.state);
		// Chromium paints above the DOM: the welcome content requires hiding the blank native view.
		this.host.setVisible(
			this.visible && !!this.model && (this.model.state.url !== 'about:blank' || this.model.state.loading),
		);
	}
}
