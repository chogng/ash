import { CancellationError } from '../../../../../base/common/errors.js';
import { AbstractDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { IChatPasteTargetService, type IChatPasteTarget } from '../chat.js';
import type { IChatInputEditor } from '../widget/input/chatInputEditorRegistry.js';
import type { ChatDynamicVariableModel } from './chatDynamicVariables.js';
import type { ChatAttachmentModel } from './chatAttachmentModel.js';

/** Binds paste admission to the original input without retaining another copy of its references. */
export class ChatWidgetPasteTarget extends AbstractDisposable implements IChatPasteTarget {
	private readonly inputUri: URI;
	private readonly registration: IDisposable;

	constructor(
		private readonly input: IChatInputEditor,
		private readonly references: ChatDynamicVariableModel,
		private readonly model: ChatAttachmentModel,
		@IChatPasteTargetService private readonly targets: IChatPasteTargetService,
	) {
		super();
		this.inputUri = input.getModel?.().uri ?? URI.from({ scheme: 'ash-chat-input', path: `/${createUuid()}` });
		this.registration = targets.registerTarget(this.inputUri, this);
	}

	public get attachments(): readonly ChatContextAttachment[] {
		return this.model.attachments;
	}

	public get inlineReferences(): readonly ChatContextAttachment[] {
		// All manually attached context is inline in Ash; positions stay with the reference model.
		return this.references.getInputState();
	}

	public addAttachments(entries: readonly ChatContextAttachment[], signal?: AbortSignal): readonly ChatContextAttachment[] {
		if (entries.length > 1 && entries.every(entry => entry.kind !== 'toolSelection' && entry.lifetime !== 'source')) {
			this.assertCurrent(signal);
			const selection = this.input.getSelection();
			const start = Math.min(selection.anchor, selection.active);
			const end = Math.max(selection.anchor, selection.active);
			const leading = start > 0 && !/\s/u.test(this.input.value[start - 1]!) ? ' ' : '';
			const trailing = end === this.input.value.length || !/\s/u.test(this.input.value[end]!) ? ' ' : '';
			const text = leading + entries.map(entry => entry.name).join(' ') + trailing;
			// One receive gesture is one text edit. Reference history stays bound to that model version.
			this.input.insertText(text);
			this.input.setSelection({ anchor: start + text.length, active: start + text.length });
			let offset = start + leading.length;
			return entries.map(entry => {
				this.assertCurrent(signal);
				const reference = { start: offset, end: offset + entry.name.length };
				offset = reference.end + 1;
				return this.references.addReference({ ...entry, reference }, false);
			});
		}
		return entries.map(entry => {
			this.assertCurrent(signal);
			if (entry.lifetime === 'source') {
				this.model.addContext(entry);
				return this.references.getInputState().find(reference => reference.id === entry.id)!;
			}
			return this.references.addReference({ ...entry, reference: undefined }, false);
		});
	}

	public removeAttachments(ids: readonly string[]): void {
		const attached = this.model.getAttachmentIDs();
		for (const id of ids) {
			this.assertCurrent();
			if (attached.has(id)) this.references.removeReference(id);
		}
	}

	public addInlineReference(reference: ChatContextAttachment): void {
		this.assertCurrent();
		this.references.addReference(reference, false);
	}

	private assertCurrent(signal?: AbortSignal): void {
		if (this.isDisposed || signal?.aborted || this.targets.getTarget(this.inputUri) !== this) {
			throw new CancellationError();
		}
	}

	protected override disposeCore(): void {
		this.registration.dispose();
	}
}
