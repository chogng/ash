import './media/chatInlineAnchorWidget.css';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { appendLabelIcon } from '../../../../../../base/browser/ui/iconlabel/iconLabels.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { localize2 } from '../../../../../../nls.js';
import { Action2 } from '../../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { parseInlineFileReference } from '../../../common/widget/annotations.js';
import { getEditorOverrideForChatResource } from '../chatEditorAssociations.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';

type FileReference = NonNullable<ReturnType<typeof parseInlineFileReference>>;

export function renderFileAnchor(anchor: HTMLAnchorElement, instantiation: IInstantiationService, store: DisposableStore): boolean {
	const href = anchor.getAttribute('href');
	const reference = href && parseInlineFileReference(href);
	if (!reference) return false;
	store.add(instantiation.createInstance(InlineAnchorWidget, anchor, reference));
	return true;
}

/** Adds file commands to the original link and leaves primary activation with Markdown. */
export class InlineAnchorWidget extends Disposable {
	static readonly className = 'ash-chat-inline-anchor';

	constructor(
		readonly element: HTMLAnchorElement,
		readonly reference: FileReference,
		@IChatMarkdownAnchorService anchors: IChatMarkdownAnchorService,
		@ICommandService commands: ICommandService,
	) {
		super();
		element.classList.add(InlineAnchorWidget.className);
		const icon = appendLabelIcon(element, Lxicon.file);
		element.prepend(icon);
		this._register(toDisposable(() => {
			icon.remove();
			element.classList.remove(InlineAnchorWidget.className);
		}));
		this._register(anchors.register(this));
		this._register(addDisposableListener(element, 'keydown', event => {
			if (event.defaultPrevented || event.altKey || event.shiftKey) return;
			const copyModifier = isMacintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			const selection = element.ownerDocument.getSelection();
			const copy = copyModifier && event.key.toLowerCase() === 'c' && (!selection || selection.isCollapsed);
			const openToSide = event.ctrlKey && !event.metaKey && event.key === 'Enter';
			if (!copy && !openToSide) return;
			event.preventDefault();
			event.stopPropagation();
			void commands.executeCommand(copy ? CopyInlineResourceAction.id : OpenInlineResourceToSideAction.id).catch(onUnexpectedError);
		}));
	}
}

export class CopyInlineResourceAction extends Action2 {
	static readonly id = 'chat.inlineResourceAnchor.copyResource';

	constructor() {
		super({ id: CopyInlineResourceAction.id, title: localize2('chat.fileAnchor.copy', 'Copy File Reference') });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const anchor = accessor.get(IChatMarkdownAnchorService).lastFocusedAnchor;
		if (anchor) await accessor.get(IClipboardService).writeResources([anchor.reference.uri], 'copy');
	}
}

export class OpenInlineResourceToSideAction extends Action2 {
	static readonly id = 'chat.inlineResourceAnchor.openToSide';

	constructor() {
		super({ id: OpenInlineResourceToSideAction.id, title: localize2('chat.fileAnchor.openToSide', 'Open File Reference to the Side') });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const reference = accessor.get(IChatMarkdownAnchorService).lastFocusedAnchor?.reference;
		if (!reference) return;
		const { uri, selection } = reference;
		const range = selection && new Range(selection.startLineNumber, selection.startColumn,
			selection.endLineNumber ?? selection.startLineNumber, selection.endColumn ?? selection.startColumn);
		const preferredEditorId = getEditorOverrideForChatResource(uri, accessor.get(IConfigurationService));
		await accessor.get(IEditorService).openEditor({ resource: uri }, { selection: range, ...(preferredEditorId ? { preferredEditorId } : {}) }, 'sideGroup');
	}
}
