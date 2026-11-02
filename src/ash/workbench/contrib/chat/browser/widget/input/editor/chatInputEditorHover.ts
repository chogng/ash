import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../../../../../editor/browser/editorBrowser.js';
import { onActivate } from '../../../../../../../editor/browser/editorFeatureRegistration.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { HoverParticipantRegistry, type HoverAnchor, type IEditorHoverParticipant, type IEditorHoverRenderContext, type IHoverPart, type IRenderedHoverParts } from '../../../../../../../editor/contrib/hover/browser/hoverTypes.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import type { ChatContextAttachment } from '../../../../../../services/chat/common/chatContextService.js';
import '../../../attachments/chatAttachmentWidgets.css';

/** Reads image references from the input's existing decoration projection. */
export class ChatAttachmentReferenceHoverParticipant implements IEditorHoverParticipant {
	constructor(private readonly editor: ICodeEditor) { }

	public suggestHoverAnchor(mouseEvent: IEditorMouseEvent): HoverAnchor | null {
		if (mouseEvent.target.type !== MouseTargetType.CONTENT_WIDGET) { return null; }
		for (const decoration of this.editor.getModel()?.getAllDecorations() ?? []) {
			if (decoration.options.description !== 'chat-context-reference') { continue; }
			const reference = decoration.options.before?.attachedData as string | ChatContextAttachment | undefined;
			if (reference && typeof reference !== 'string' && reference.kind === 'image'
				&& mouseEvent.target.detail === `chat-context-${reference.id}`) {
				return { position: Range.lift(decoration.range).getStartPosition(), target: mouseEvent.target.element ?? undefined, source: 'mouse' };
			}
		}
		return null;
	}

	public computeSync(anchor: HoverAnchor): ChatAttachmentReferenceHoverPart[] {
		const result: ChatAttachmentReferenceHoverPart[] = [];
		for (const decoration of this.editor.getLineDecorations(anchor.position.lineNumber) ?? []) {
			if (decoration.options.description !== 'chat-context-reference' || !Range.containsPosition(decoration.range, anchor.position)) {
				continue;
			}
			// This payload is borrowed from ChatInputEditor's typed reference projection.
			const reference = decoration.options.before?.attachedData as string | ChatContextAttachment | undefined;
			if (reference && typeof reference !== 'string' && reference.kind === 'image') {
				result.push(new ChatAttachmentReferenceHoverPart(this, Range.lift(decoration.range), reference, decoration.id));
			}
		}
		return result;
	}

	public renderHoverParts(context: IEditorHoverRenderContext, parts: IHoverPart[]): IRenderedHoverParts {
		const resources = new DisposableStore();
		const document = context.container.ownerDocument;
		// Share the existing preview association with Chat's accessible view, including its close action.
		const content = h(document, 'div');
		content.className = 'ash-chat-context-reference-preview ash-chat-image-reference-preview ash-chat-image-reference-hover';
		content.setAttribute('role', 'group');
		content.tabIndex = -1;
		const part = parts.find((candidate): candidate is ChatAttachmentReferenceHoverPart =>
			candidate instanceof ChatAttachmentReferenceHoverPart && candidate.owner === this);
		if (part) {
			content.dataset.attachmentId = part.attachment.id;
			content.setAttribute('aria-label', localize('chat.context.previewImage', 'Preview {0}', part.attachment.name));
			content.setAttribute('aria-busy', 'true');
			const header = h(document, 'div');
			header.className = 'ash-chat-context-reference-preview-header';
			const name = h(document, 'span');
			name.textContent = part.attachment.name;
			header.append(name);
			const close = resources.add(new Button(header, {
				...defaultButtonStyles,
				label: '',
				icon: Lxicon.close,
				ariaLabel: localize('chat.context.closeImagePreview', 'Close image preview'),
				title: localize('chat.context.closeImagePreview', 'Close image preview'),
				size: 'small', presentation: 'quiet',
			}));
			resources.add(close.onDidClick(() => { context.hide(); this.editor.focus(); }));
			const status = h(document, 'p');
			status.setAttribute('role', 'status');
			status.textContent = localize('chat.context.imageLoading', 'Loading preview: {0}', part.attachment.name);
			const image = h(document, 'img');
			image.alt = part.attachment.name;
			image.draggable = false;
			content.append(header, status);
			const isCurrent = (): boolean => !resources.isDisposed
				&& this.editor.getModel()?.getDecorationOptions(part.decorationId)?.before?.attachedData === part.attachment;
			const unavailable = (): void => {
				if (!isCurrent()) { return; }
				image.removeAttribute('src');
				image.remove();
				content.setAttribute('aria-busy', 'false');
				status.hidden = false;
				status.textContent = localize('chat.context.previewFailed', 'Preview unavailable: {0}', part.attachment.name);
				context.onContentsChanged();
			};
			resources.add(addDisposableListener(image, 'error', unavailable));
			resources.add(addDisposableListener(image, 'load', () => {
				if (!isCurrent()) { return; }
				if (!image.naturalWidth) { unavailable(); return; }
				content.append(image);
				status.hidden = true;
				content.setAttribute('aria-busy', 'false');
				context.onContentsChanged();
			}));
			resources.add(this.editor.onDidChangeModelDecorations(() => {
				if (!isCurrent()) { context.hide(); }
			}));
			resources.add(toDisposable(() => image.removeAttribute('src')));
			// Resolution stays with the canonical capture. Closing a hover only retires its rendering.
			void part.attachment.resolve().then(resolved => {
				if (!isCurrent()) { return; }
				// Only captured raster bytes may reach this image sink; never request a source URL.
				if (!/^data:image\/(png|jpeg|gif|webp);base64,/u.test(resolved.content)) { unavailable(); return; }
				image.src = resolved.content;
			}, unavailable);
		}
		context.container.append(content);
		resources.add(toDisposable(() => content.remove()));
		return Object.assign(resources, {
			focus: () => content.focus({ preventScroll: true }),
			isUpdatingEditor: () => false,
		});
	}
}

/** A borrowed capture and the decoration identity that bounds its hover lifetime. */
export class ChatAttachmentReferenceHoverPart implements IHoverPart {
	constructor(
		public readonly owner: ChatAttachmentReferenceHoverParticipant,
		public readonly range: Range,
		public readonly attachment: ChatContextAttachment,
		public readonly decorationId: string,
	) { }
}

onActivate(() => HoverParticipantRegistry.register(ChatAttachmentReferenceHoverParticipant));
