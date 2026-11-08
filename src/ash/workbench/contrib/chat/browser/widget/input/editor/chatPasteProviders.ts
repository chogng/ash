import { CancellationError } from '../../../../../../../base/common/errors.js';
import { addDisposableListener } from '../../../../../../../base/browser/dom.js';
import { convertHtmlToMarkdown } from '../../../../../../../base/browser/htmlToMarkdown.js';
import { Disposable, DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { createStringDataTransferItem, VSDataTransfer, type IReadonlyVSDataTransfer } from '../../../../../../../base/common/dataTransfer.js';
import { HierarchicalKind } from '../../../../../../../base/common/hierarchicalKind.js';
import type { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { isRecord } from '../../../../../../../base/common/types.js';
import { URI, isUriComponents } from '../../../../../../../base/common/uri.js';
import { basename } from '../../../../../../../base/common/resources.js';
import { withSelection } from '../../../../../../../platform/opener/common/opener.js';
import { IOutputService } from '../../../../../../services/output/common/output.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { Mimes } from '../../../../../../../base/common/mime.js';
import { localize } from '../../../../../../../nls.js';
import { IChatPasteTargetService, type IChatPasteTarget } from '../../../chat.js';
import { restoreChatVariableEntry } from '../../../../common/attachments/chatVariableEntries.js';
import { LocalChatSessionUri } from '../../../../common/model/chatUri.js';
import { captureChatDraft } from '../../../../../../services/chat/common/chatContextService.js';
import type { IChatInputEditor } from '../chatInputEditorRegistry.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { validateOpenAgentsWindow, type IOpenAgentsWindowOptions } from '../../../../../../../platform/native/common/nativeHost.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { EndOfLinePreference, type ITextModel } from '../../../../../../../editor/common/model.js';
import { Range, type IRange } from '../../../../../../../editor/common/core/range.js';
import type {
	DocumentPasteContext,
	DocumentPasteEdit,
	DocumentPasteEditProvider,
	DocumentPasteEditsSession,
} from '../../../../../../../editor/common/languages.js';
import { DocumentPasteTriggerKind } from '../../../../../../../editor/common/languages.js';
import { CopyPasteController } from '../../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';

export const CHAT_ATTACHMENT_MIME_TYPE = 'application/vnd.chat.attachment+json';
const copiedEditorMime = 'application/vnd.code.additional-editor-data';

type PromptSnapshot = NonNullable<IOpenAgentsWindowOptions['draft']>;
type CopiedReference = PromptSnapshot['contexts'][number] & {
	readonly reference: { readonly start: number; readonly end: number; };
};
const pastePlan = Symbol('chat-reference-paste');
const maxClipboardLength = 32 * 1024 * 1024;

interface ReferencePastePlan {
	readonly model: ITextModel;
	readonly target: IChatPasteTarget;
	readonly beforeText: string;
	readonly beforeVersion: number;
	readonly ranges: readonly IRange[];
	readonly text: string;
	readonly references: readonly CopiedReference[];
	readonly lifecycle: AbortSignal;
	readonly resources: DisposableStore;
}

type ReferencePasteEdit = DocumentPasteEdit & { readonly [pastePlan]: ReferencePastePlan; };

/** Registers snapshot transfer for this composer; committed references stay with its original model. */
export class ChatPasteProvidersFeature extends Disposable {
	constructor(
		input: IChatInputEditor,
		currentLifecycle: () => AbortSignal,
		supportsImages: () => boolean,
		@IInstantiationService instantiation: IInstantiationService,
		@ILanguageFeaturesService features: ILanguageFeaturesService,
	) {
		super();
		const model = input.getModel!();
		const provider = instantiation.createInstance(CopyAttachmentsProvider, input, currentLifecycle, supportsImages);
		this._register(features.documentPasteEditProvider.register({
			scheme: model.uri.scheme,
			hasAccessToAllModels: true,
		}, provider));
		this._register(features.documentPasteEditProvider.register({
			scheme: model.uri.scheme,
			hasAccessToAllModels: true,
		}, instantiation.createInstance(PasteTextProvider, input, currentLifecycle)));
		this._register(features.documentPasteEditProvider.register({
			scheme: model.uri.scheme,
			hasAccessToAllModels: true,
		}, new PasteHtmlProvider(input, currentLifecycle)));
	}
}

/** Automatic rich paste is scoped to its owning draft; explicit paste choices keep precedence. */
class PasteHtmlProvider implements DocumentPasteEditProvider {
	readonly kind = new HierarchicalKind('chat.paste.html');
	readonly providedPasteEditKinds = [this.kind];
	readonly copyMimeTypes = [];
	readonly pasteMimeTypes = [Mimes.html];

	constructor(private readonly input: IChatInputEditor, private readonly currentLifecycle: () => AbortSignal) { }

	async provideDocumentPasteEdits(model: ITextModel, _ranges: readonly IRange[], transfer: IReadonlyVSDataTransfer,
		context: DocumentPasteContext, token: CancellationToken): Promise<DocumentPasteEditsSession | undefined> {
		const lifecycle = this.currentLifecycle();
		if (model !== this.input.getModel?.() || lifecycle.aborted || token.isCancellationRequested || context.triggerKind !== DocumentPasteTriggerKind.Automatic
			|| transfer.has(CHAT_ATTACHMENT_MIME_TYPE) || transfer.has(copiedEditorMime) || transfer.has('vscode-editor-data')
			|| [...transfer].some(([, item]) => !!item.asFile())) { return undefined; }
		// Editors already supply literal source text; their HTML only adds syntax highlighting.
		const html = await transfer.get(Mimes.html)?.asString();
		if (!html || token.isCancellationRequested || lifecycle.aborted || this.currentLifecycle() !== lifecycle || model !== this.input.getModel?.()
			|| !/<(?:a|strong|b|em|i|h[1-6]|code|pre|ul|ol|li|blockquote|del|s|strike|img|hr|table)\b/i.test(html)) { return undefined; }
		const markdown = convertHtmlToMarkdown(html);
		if (!markdown) { return undefined; }
		return {
			edits: [{
				title: localize('pasteHtmlAsMarkdown', 'Paste as Markdown'), kind: this.kind, handledMimeType: Mimes.html,
				insertText: markdown, yieldTo: [{ kind: new HierarchicalKind('chat.attach') }]
			}], dispose() { }
		};
	}
}

class CopyAttachmentsProvider implements DocumentPasteEditProvider {
	readonly kind = new HierarchicalKind('chat.attach.attachments');
	readonly providedPasteEditKinds = [this.kind];
	readonly copyMimeTypes = [CHAT_ATTACHMENT_MIME_TYPE];
	readonly pasteMimeTypes = [CHAT_ATTACHMENT_MIME_TYPE];

	constructor(
		private readonly input: IChatInputEditor,
		private readonly currentLifecycle: () => AbortSignal,
		private readonly supportsImages: () => boolean,
		@IChatPasteTargetService private readonly targets: IChatPasteTargetService,
	) { }

	async prepareDocumentPaste(
		model: ITextModel,
		ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		token: CancellationToken,
	): Promise<IReadonlyVSDataTransfer | undefined> {
		const target = model === this.input.getModel?.() ? this.targets.getTarget(model.uri) : undefined;
		const textValue = transfer.get(Mimes.text)?.value;
		if (!target || token.isCancellationRequested || typeof textValue !== 'string') return undefined;
		// Capture identities and source coordinates before an asynchronous read or the cut itself.
		const copied = target.getCopiedInlinePrompt(ranges, textValue);
		if (!copied || copied.references.length === 0 || copied.references.length > 1000) return undefined;
		try {
			const draft = await captureChatDraft(copied.text, 'agent', copied.references.map(({ attachment, reference }) => ({
				...attachment, reference,
			})));
			const raw = JSON.stringify({ version: 1, draft });
			if (token.isCancellationRequested || raw.length > maxClipboardLength) return undefined;
			const result = new VSDataTransfer();
			result.append(CHAT_ATTACHMENT_MIME_TYPE, createStringDataTransferItem(raw));
			return result;
		} catch {
			// The normal text copy remains usable if one captured context cannot be read.
			return undefined;
		}
	}

	async provideDocumentPasteEdits(
		model: ITextModel,
		ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		_context: DocumentPasteContext,
		token: CancellationToken,
	): Promise<DocumentPasteEditsSession | undefined> {
		return createReferencePasteSession({
			input: this.input,
			model,
			ranges,
			token,
			lifecycle: this.currentLifecycle(),
			supportsImages: this.supportsImages,
			targets: this.targets,
			kind: this.kind,
			title: localize('pastedChatAttachments', 'Insert Prompt & Attachments'),
			mime: CHAT_ATTACHMENT_MIME_TYPE,
			readSnapshot: async () => {
				const [raw, text] = await Promise.all([
					transfer.get(CHAT_ATTACHMENT_MIME_TYPE)?.asString(),
					transfer.get(Mimes.text)?.asString(),
				]);
				return parseCopiedPrompt(raw, text);
			},
		});
	}

	async resolveDocumentPasteEdit(edit: DocumentPasteEdit, token: CancellationToken): Promise<DocumentPasteEdit> {
		return resolveReferencePasteEdit(edit, token, this.targets, this.supportsImages);
	}
}

/** Captures source coordinates while copy or cut still owns the editor selection. */
export class CopyTextProvider implements DocumentPasteEditProvider {
	readonly providedPasteEditKinds = [];
	readonly copyMimeTypes = [copiedEditorMime];
	readonly pasteMimeTypes = [];

	constructor(@IOutputService private readonly output: IOutputService) { }

	async prepareDocumentPaste(
		model: ITextModel,
		ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		token: CancellationToken,
	): Promise<IReadonlyVSDataTransfer | undefined> {
		if (token.isCancellationRequested || model.getLanguageId() === 'ash-chat-input' || model.uri.scheme === 'inmemory' || ranges.length !== 1) return undefined;
		const text = transfer.get(Mimes.text)?.value;
		if (typeof text !== 'string' || !text.trim() || text.length > maxClipboardLength) return undefined;
		const range = Range.lift(ranges[0]!);
		if (range.isEmpty()) return undefined;
		const selectedText = model.getValueInRange(range, EndOfLinePreference.LF);
		const copiedText = text.replace(/\r\n|\r/g, '\n');
		if (copiedText !== selectedText) return undefined;
		const label = model.uri.scheme === 'output'
			? this.output.getChannel(model.uri.path.slice(1))?.label
			: model.getLanguageId() === 'debug-repl' ? localize('chat.context.debugConsole', 'Debug Console') : basename(model.uri);
		if (!label) return undefined;
		const data = new VSDataTransfer();
		data.append(copiedEditorMime, createStringDataTransferItem(JSON.stringify({
			uri: model.uri.toJSON(), range, sourceName: label.replace(/\s/gu, ' '),
		})));
		return data;
	}
}

/** Offers a frozen code reference alongside the editor's normal plain-text paste. */
export class PasteTextProvider implements DocumentPasteEditProvider {
	readonly kind = new HierarchicalKind('chat.attach.text');
	readonly providedPasteEditKinds = [this.kind];
	readonly copyMimeTypes = [];
	readonly pasteMimeTypes = [copiedEditorMime];

	constructor(
		private readonly input: IChatInputEditor,
		private readonly currentLifecycle: () => AbortSignal,
		@IChatPasteTargetService private readonly targets: IChatPasteTargetService,
	) { }

	async provideDocumentPasteEdits(
		model: ITextModel,
		ranges: readonly IRange[],
		transfer: IReadonlyVSDataTransfer,
		_context: DocumentPasteContext,
		token: CancellationToken,
	): Promise<DocumentPasteEditsSession | undefined> {
		return createReferencePasteSession({
			input: this.input,
			model,
			ranges,
			token,
			lifecycle: this.currentLifecycle(),
			supportsImages: () => false,
			targets: this.targets,
			kind: this.kind,
			title: localize('pastedCodeAttachment', 'Pasted Code Attachment'),
			mime: copiedEditorMime,
			yieldTo: [{ kind: new HierarchicalKind('text.plain') }],
			readSnapshot: async () => {
				const [raw, text] = await Promise.all([
					transfer.get(copiedEditorMime)?.asString(),
					transfer.get(Mimes.text)?.asString(),
				]);
				return parseCopiedCode(raw, text);
			},
		});
	}

	async resolveDocumentPasteEdit(edit: DocumentPasteEdit, token: CancellationToken): Promise<DocumentPasteEdit> {
		return resolveReferencePasteEdit(edit, token, this.targets, () => false);
	}
}

interface ReferencePasteRequest {
	readonly input: IChatInputEditor;
	readonly model: ITextModel;
	readonly ranges: readonly IRange[];
	readonly token: CancellationToken;
	readonly lifecycle: AbortSignal;
	readonly supportsImages: () => boolean;
	readonly targets: IChatPasteTargetService;
	readonly kind: HierarchicalKind;
	readonly title: string;
	readonly mime: string;
	readonly yieldTo?: DocumentPasteEdit['yieldTo'];
	readSnapshot(): Promise<PromptSnapshot | undefined>;
}

async function createReferencePasteSession(request: ReferencePasteRequest): Promise<DocumentPasteEditsSession | undefined> {
	const { input, model, ranges, token, lifecycle, supportsImages, targets } = request;
	const target = model === input.getModel?.() ? targets.getTarget(model.uri) : undefined;
	if (!target || token.isCancellationRequested || lifecycle.aborted) return undefined;
	const resources = new DisposableStore();
	resources.add(addDisposableListener(lifecycle, 'abort', () => CopyPasteController.get(input.codeEditor!)?.clearWidgets()));
	try {
		const snapshot = await request.readSnapshot();
		if (token.isCancellationRequested || lifecycle.aborted || targets.getTarget(model.uri) !== target
			|| !snapshot || snapshot.contexts.some(context => context.kind === 'image') && !supportsImages()) {
			resources.dispose();
			return undefined;
		}
		const edit: ReferencePasteEdit = {
			title: request.title,
			kind: request.kind,
			handledMimeType: request.mime,
			insertText: snapshot.text,
			yieldTo: request.yieldTo,
			[pastePlan]: {
				model,
				target,
				beforeText: model.getValue(),
				beforeVersion: model.getAlternativeVersionId(),
				ranges: ranges.map(range => Range.lift(range)),
				text: snapshot.text,
				references: snapshot.contexts as readonly CopiedReference[],
				lifecycle,
				resources,
			},
		};
		return { edits: [edit], dispose: () => resources.dispose() };
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

async function resolveReferencePasteEdit(
	edit: DocumentPasteEdit,
	token: CancellationToken,
	targets: IChatPasteTargetService,
	supportsImages: () => boolean,
): Promise<DocumentPasteEdit> {
	const plan = (edit as Partial<ReferencePasteEdit>)[pastePlan];
	if (!plan) return edit;
	const { model, target, resources } = plan;
	if (token.isCancellationRequested || plan.lifecycle.aborted || resources.isDisposed
		|| targets.getTarget(model.uri) !== target
		|| model.getValue() !== plan.beforeText || model.getAlternativeVersionId() !== plan.beforeVersion) {
		throw new CancellationError();
	}
	if (plan.references.some(reference => reference.kind === 'image') && !supportsImages()) {
		throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
	}
	const text = plan.text.replace(/\n/g, model.getEOL());
	const operations = plan.ranges.map(range => ({
		start: model.getOffsetAt(Range.getStartPosition(range)),
		end: model.getOffsetAt(Range.getEndPosition(range)),
	})).sort((a, b) => a.start - b.start);
	let expected = plan.beforeText;
	for (const operation of [...operations].reverse()) {
		expected = expected.slice(0, operation.start) + text + expected.slice(operation.end);
	}
	const version = model.getVersionId();
	// Binding is part of the chosen edit, not of offering an alternative. The original
	// reference model records these entries on the inserted text's alternative version.
	const binding = model.onDidChangeContent(() => {
		binding.dispose();
		if (resources.isDisposed || plan.lifecycle.aborted || model.getVersionId() !== version + 1
			|| model.getValue() !== expected || targets.getTarget(model.uri) !== target) return;
		let precedingDelta = 0;
		for (const operation of operations) {
			const insertionStart = operation.start + precedingDelta;
			for (const reference of plan.references) {
				const start = insertionStart + plan.text.slice(0, reference.reference.start).replace(/\n/g, model.getEOL()).length;
				target.addInlineReference(restoreChatVariableEntry({
					...reference,
					id: createUuid(),
					reference: { start, end: start + reference.name.length },
				}));
			}
			precedingDelta += text.length - (operation.end - operation.start);
		}
	});
	resources.add(binding);
	return edit;
}

function parseCopiedCode(raw: string | undefined, clipboardText: string | undefined): PromptSnapshot | undefined {
	if (!raw || raw.length > 64 * 1024 || !clipboardText?.trim() || clipboardText.length > maxClipboardLength) return undefined;
	try {
		const data: unknown = JSON.parse(raw);
		if (!isRecord(data) || !isUriComponents(data.uri) || !isRecord(data.range)) return undefined;
		const range = data.range;
		const coordinates = [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn];
		if (!coordinates.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return undefined;
		if (!Range.isIRange(range)) return undefined;
		const selection = Range.lift(range);
		if (selection.isEmpty() || !Range.equalsRange(selection, range)) return undefined;
		const source = URI.from(data.uri);
		if (source.scheme === 'inmemory') return undefined;
		const label = data.sourceName === undefined ? basename(source) : data.sourceName;
		if (typeof label !== 'string' || !label.trim() || label.length > 1024 || /[\r\n\0]/u.test(label)) return undefined;
		const lastLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const name = selection.startLineNumber === lastLine
			? localize('chat.context.selectionLine', '{0} ({1})', label, selection.startLineNumber)
			: localize('chat.context.selectionLines', '{0} ({1}-{2})', label, selection.startLineNumber, lastLine);
		const resource = withSelection(source, selection).toString();
		return {
			mode: 'agent', text: name,
			contexts: [{
				id: createUuid(),
				kind: 'codeSelection',
				name,
				resource,
				reference: { start: 0, end: name.length },
				// Snapshots use LF independently of the source editor and destination model's EOL.
				content: `Source: ${resource}\n\n${clipboardText.replace(/\r\n|\r/g, '\n')}`,
			}],
		};
	} catch {
		return undefined;
	}
}

function parseCopiedPrompt(raw: string | undefined, clipboardText: string | undefined): PromptSnapshot | undefined {
	if (!raw || raw.length > maxClipboardLength || clipboardText === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || value.version !== 1 || Object.keys(value).sort().join(',') !== 'draft,version') return undefined;
		const draft = validateOpenAgentsWindow({ draft: value.draft })?.draft;
		if (!draft || draft.text !== clipboardText.replace(/\r\n|\r/g, '\n') || draft.contexts.length === 0 || draft.contexts.length > 1000) return undefined;
		let end = 0;
		for (const context of [...draft.contexts].sort((a, b) => (a.reference?.start ?? -1) - (b.reference?.start ?? -1))) {
			if (context.kind === 'toolSelection') return undefined;
			if (!context.reference || context.reference.start < end) return undefined;
			end = context.reference.end;
			const resource = context.resource ? URI.parse(context.resource) : undefined;
			if (context.chatReference && (!resource || !LocalChatSessionUri.parse(resource))) return undefined;
			if (context.kind === 'image' && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/u.test(context.content)) return undefined;
		}
		return draft;
	} catch {
		return undefined;
	}
}

/** Prepares one atomic file batch for any composer; the caller owns its draft and cancellation. */
