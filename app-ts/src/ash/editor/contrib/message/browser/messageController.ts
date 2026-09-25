import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { MarkdownElement, renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { alert } from '../../../../base/browser/ui/aria/aria.js';
import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import type { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { isMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey, type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IOpenerService } from '../../../../platform/opener/common/openerService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { EditorCommand, EditorContributionInstantiation, registerEditorCommand, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type IPosition, Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import type { IEditorContribution } from '../../../common/editorCommon.js';
import { PositionAffinity } from '../../../common/model.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import './messageController.css';

/** Owns the active editor-positioned message and its dismissal lifecycle. */
export class MessageController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.messageController';
	public static readonly MESSAGE_VISIBLE = new RawContextKey<boolean>('messageVisible', false);

	public static get(editor: ICodeEditor): MessageController | null {
		return editor.getContribution<MessageController>(MessageController.ID);
	}

	private readonly visibleKey: IContextKey<boolean> | undefined;
	private readonly widget = this._register(new MutableDisposable<MessageWidget>());
	private readonly closeTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly blurTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly listeners = this._register(new DisposableStore());
	private visible = false;
	private mouseOver = false;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this.visibleKey = editor.invokeWithinContext(accessor => accessor.getOptional(IContextKeyService))?.createKey(MessageController.MESSAGE_VISIBLE.key, false);
		if (this.visibleKey) this._register(toDisposable(() => this.visibleKey?.reset()));
		const domNode = editor.getDomNode();
		if (!domNode) throw new ReferenceError('MessageController requires an editor DOM node');
		this._register(addDisposableListener<KeyboardEvent>(domNode, 'keydown', event => {
			if (!this.visible || event.defaultPrevented || event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			this.closeMessage();
		}));
	}

	public override dispose(): void {
		if (this.isDisposed) return;
		this.setVisible(false);
		this.mouseOver = false;
		this.listeners.clear();
		this.closeTimer.clear();
		this.blurTimer.clear();
		this.widget.clear();
		super.dispose();
	}

	public isVisible(): boolean {
		return this.visible;
	}

	public showMessage(message: IMarkdownString | string, position: IPosition): void {
		const text = isMarkdownString(message) ? message.value : message;
		if (typeof text !== 'string' || text.trim().length === 0) throw new TypeError('Editor message must not be empty');
		this.closeTimer.clear();
		this.blurTimer.clear();
		this.listeners.clear();
		this.widget.clear();
		this.mouseOver = false;

		let content: string | HTMLElement = text;
		let contentOwner: IDisposable | undefined;
		if (isMarkdownString(message)) {
			const markdown = new MarkdownElement({
				ownerDocument: this.editor.getContainerDomNode().ownerDocument,
				markdown: message,
				linkHandler: target => {
					this.closeMessage();
					if (target.startsWith('command:')) {
						const command = parseCommandLink(target);
						const commandService = this.editor.invokeWithinContext(accessor => accessor.getOptional(ICommandService));
						if (command && commandService) {
							void commandService.executeCommand(command.id, ...command.args).catch(error => console.error('Could not run Markdown command', error));
						}
						return;
					}
					if (isEditorResourceLink(target)) {
						const editorService = this.editor.invokeWithinContext(accessor => accessor.getOptional(ICodeEditorService));
						if (editorService) {
							void editorService.openCodeEditor({ resource: URI.parse(target) }, this.editor).catch(error => console.error('Could not open Markdown resource', error));
						}
						return;
					}
					if (target.startsWith(`${Schemas.internal}:`)) return;
					const opener = this.editor.invokeWithinContext(accessor => accessor.getOptional(IOpenerService));
					if (opener) void opener.openExternal(target).catch(error => console.error('Could not open Markdown link', error));
				},
			});
			content = markdown.element;
			contentOwner = markdown;
		}
		alert(isMarkdownString(message) ? renderAsPlaintext(message) : text);
		const widget = new MessageWidget(this.editor, position, content, contentOwner);
		this.widget.value = widget;
		this.setVisible(true);
		this.listenForDismissal(position, widget);
	}

	public closeMessage(): void {
		this.setVisible(false);
		this.mouseOver = false;
		this.listeners.clear();
		this.closeTimer.clear();
		this.blurTimer.clear();
		const widget = this.widget.value;
		if (!widget) return;
		widget.getDomNode().classList.add('fadeOut');
		const targetWindow = widget.getDomNode().ownerDocument.defaultView;
		if (!targetWindow) {
			this.widget.clear();
			return;
		}
		this.closeTimer.value = disposableWindowTimeout(targetWindow, () => this.widget.clear(), 100);
	}

	private listenForDismissal(position: IPosition, widget: MessageWidget): void {
		this.listeners.add(this.editor.onDidChangeCursorSelection(() => this.closeMessage()));
		const model = this.editor.getModel();
		if (model) this.listeners.add(model.onDidChangeContent(() => this.closeMessage()));
		this.listeners.add(addDisposableListener(widget.getDomNode(), 'mouseenter', () => { this.mouseOver = true; }));
		this.listeners.add(addDisposableListener(widget.getDomNode(), 'mouseleave', () => { this.mouseOver = false; }));
		const editorDomNode = this.editor.getDomNode()!;
		this.listeners.add(addDisposableListener<FocusEvent>(editorDomNode, 'focusout', () => {
			const targetWindow = editorDomNode.ownerDocument.defaultView;
			if (!targetWindow) return;
			this.blurTimer.value = disposableWindowTimeout(targetWindow, () => {
				const active = editorDomNode.ownerDocument.activeElement;
				if (!this.mouseOver && active !== null && !widget.getDomNode().contains(active)) this.closeMessage();
			}, 0);
		}));
		this.listeners.add(this.editor.onMouseMove(event => {
			const target = event.target.position;
			if (target && Math.abs(target.lineNumber - position.lineNumber) > 3) this.closeMessage();
		}));
	}

	private setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) this.visibleKey?.set(true);
		else this.visibleKey?.reset();
	}
}

function isEditorResourceLink(target: string): boolean {
	const scheme = URI.parse(target).scheme;
	return scheme === Schemas.file
		|| scheme === Schemas.ashRemote
		|| scheme === Schemas.vscodeFileResource
		|| scheme === Schemas.vscodeRemote
		|| scheme === Schemas.vscodeRemoteResource
		|| scheme === Schemas.vscodeNotebookCell;
}

function parseCommandLink(target: string): { readonly id: string; readonly args: readonly unknown[] } | undefined {
	const match = /^command:(?:\/\/\/)?([^/?#]+)(?:\?([^#]*))?$/i.exec(target);
	if (!match) return undefined;
	let id: string;
	try { id = decodeURIComponent(match[1]!); }
	catch { return undefined; }
	if (!id) return undefined;
	if (!match[2]) return { id, args: [] };
	try {
		const args: unknown = JSON.parse(decodeURIComponent(match[2]));
		return Array.isArray(args) ? { id, args } : undefined;
	} catch {
		return undefined;
	}
}

class MessageWidget extends Disposable implements IContentWidget {
	public readonly allowEditorOverflow = true;
	public readonly suppressMouseDown = false;
	private readonly domNode: HTMLDivElement;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly position: IPosition,
		content: HTMLElement | string,
		contentOwner?: IDisposable,
	) {
		super();
		if (contentOwner) this._register(contentOwner);
		editor.revealRange(Range.fromPositions(Position.lift(position)));
		const document = editor.getContainerDomNode().ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'stanza-editor-overlay-message fadeIn';
		const message = h(document, 'div');
		message.className = 'message';
		if (typeof content === 'string') message.textContent = content;
		else message.append(content);
		this.domNode.append(message);
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
		editor.layoutContentWidget(this);
	}

	public getId(): string {
		return 'messageoverlay';
	}

	public getDomNode(): HTMLElement {
		return this.domNode;
	}

	public getPosition(): IContentWidgetPosition {
		return {
			position: this.position,
			preference: [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW],
			positionAffinity: PositionAffinity.Right,
		};
	}

	public afterRender(position: ContentWidgetPositionPreference | null): void {
		this.domNode.classList.toggle('below', position === ContentWidgetPositionPreference.BELOW);
	}
}

const MessageCommand = EditorCommand.bindToContribution<MessageController>(MessageController.get);
registerEditorCommand(new MessageCommand({
	id: 'leaveEditorMessage',
	precondition: MessageController.MESSAGE_VISIBLE.isEqualTo(true),
	handler: controller => controller.closeMessage(),
}));

registerEditorContribution(MessageController.ID, MessageController, EditorContributionInstantiation.Lazy);
