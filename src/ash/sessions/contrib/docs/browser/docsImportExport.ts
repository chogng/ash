import { convertHtmlToMarkdown } from '../../../../base/browser/htmlToMarkdown.js';
import { escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { lexer, walkTokens, type Token } from '../../../../base/common/marked/marked.js';
import { basename, dirname, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { DocumentTextFormat } from '../../../../workbench/services/documentEditor/common/documentCodec.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileTextModelService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IUntitledTextEditorService } from '../../../../workbench/services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../workbench/services/untitled/common/untitledTextEditorInput.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { DocumentEditorPane } from '../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { saveResourceAs } from '../../../../workbench/services/files/browser/resourceSave.js';
import type { ArkdownDocsEditorPane } from './arkdownDocsEditorPane.js';
import { createDocsOpener, newDocsResource } from './documentActions.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isNative } from '../../../../base/common/platform.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import type { IEditorPane } from '../../../../workbench/common/editor.js';
import { DOCS_ARKDOWN_EDITOR_ID } from '../common/docs.js';

/** Writing blocks use the same inert HTML conversion as clipboard imports. */
export function importDocsHtml(html: string, ownerDocument: Document): string | undefined {
	return convertHtmlToMarkdown(html, ownerDocument) || undefined;
}

/** Preserve Markdown source; only image tokens referencing local resources change. */
export async function importDocsText(text: string, format: DocumentTextFormat, resource: URI, readResource: (resource: URI) => Promise<Uint8Array>): Promise<string> {
	if (format === 'text') return text.replace(/\r\n?/g, '\n').split('\n').map(line => escapeMarkdownSyntaxTokens(line)).join('\n');
	// Marked normalizes line endings. Keep an offset map so edits preserve the
	// original file's CRLFs and every character outside the image tokens.
	const offsets: number[] = [];
	let normalized = '';
	for (let index = 0; index < text.length; index++) {
		offsets.push(index);
		normalized += text[index] === '\r' ? '\n' : text[index];
		if (text[index] === '\r' && text[index + 1] === '\n') index++;
	}
	offsets.push(text.length);
	const tokens = lexer(normalized);
	let hasLocalImages = false;
	walkTokens(tokens, token => { if (token.type === 'image' && !/^(?:https?:|data:)/i.test(token.href)) hasLocalImages = true; });
	if (!hasLocalImages) return text;
	const edits: { start: number; end: number; target: URI; mime: string; label: string; title?: string | null; }[] = [];
	const consumed = new Set<Token>();
	let cursor = 0;
	walkTokens(tokens, token => {
		if (consumed.has(token)) return;
		if (token.type === 'image' && token.tokens) walkTokens(token.tokens, child => { consumed.add(child); });
		// Parents overlap their children. Consume leaves in source order so identical
		// image syntax in a code span or fenced block is never replaced.
		if (token.type !== 'image' && ('tokens' in token && token.tokens || token.type === 'list' || token.type === 'table')) return;
		const start = normalized.indexOf(token.raw, cursor);
		if (start < 0) {
			// Container prefixes can make code tokens non-contiguous in the source.
			// Refuse conversion rather than mistake their contents for an image.
			if (token.type === 'code' || token.type === 'codespan' || token.type === 'image') throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImport' }, 'This document contains content that Docs cannot import.'));
			return;
		}
		cursor = start + token.raw.length;
		if (token.type !== 'image' || /^(?:https?:|data:)/i.test(token.href)) return;
		const href = token.href;
		const target = /^[a-z][a-z\d+.-]*:/i.test(href) ? URI.parse(href) : URI.joinPath(dirname(resource), decodeURIComponent(href));
		const mime = getMediaMime(target.path);
		if (!mime || !/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImport' }, 'This document contains content that Docs cannot import.'));
		edits.push({ start: offsets[start], end: offsets[cursor], target, mime, label: token.text, title: token.title });
	});
	// Complete source validation before starting IO; a later conversion error must
	// not leave resource reads and rejected promises without an owner.
	const images = new Map<string, Promise<string>>();
	const replacements = await Promise.all(edits.map(async edit => {
		let embedded = images.get(edit.target.toString());
		if (!embedded) {
			embedded = readResource(edit.target).then(bytes => {
				let binary = '';
				for (const byte of bytes) binary += String.fromCharCode(byte);
				return `data:${edit.mime};base64,${btoa(binary)}`;
			});
			images.set(edit.target.toString(), embedded);
		}
		const content = `![${escapeMarkdownSyntaxTokens(edit.label)}](${await embedded}${edit.title ? ` "${edit.title.replace(/["\\]/g, '\\$&')}"` : ''})`;
		return { ...edit, content };
	}));
	for (const edit of replacements.reverse()) text = text.slice(0, edit.start) + edit.content + text.slice(edit.end);
	return text;
}


export async function openWritingDraft(accessor: ServicesAccessor, html: string, title?: string): Promise<void> {
	const open = createDocsOpener(accessor);
	const editors = accessor.get(IEditorPart);
	const document = importDocsHtml(html, editors.domNode.ownerDocument);
	if (!document) throw new Error(localize('sessions.artifacts.writingImportFailed', 'This writing block could not be opened in Docs.'));
	// Provider titles are untrusted display text, but this name also becomes the proposed filename.
	const safeTitle = title?.replace(/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').trim();
	const name = safeTitle && Array.from(safeTitle).slice(0, 60).join('').trimEnd();
	await open(newDocsResource(name || localize('sessions.artifacts.untitledDocument', 'Untitled document')), { initialText: document });
}

export async function convertActiveTextToDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const open = createDocsOpener(accessor);
	const editors = accessor.get(IEditorPart);
	const input = editors.activeInput;
	const model = input && accessor.get(IFileTextModelService).getModel(input.resource);
	const files = accessor.get(IFileService);
	if (!input || !model) throw new Error(localize('document.conversion.textRequired', 'Open a text editor before converting its content.'));
	// Module loading and image reads may outlive navigation or further typing.
	const sourceText = model.getValue();
	const markdown = await importDocsText(sourceText, format, input.resource, async resource => (await files.readFileBytes(resource)).bytes);
	await open(newDocsResource(basename(input.resource).replace(/\.[^.]+$/, '')), { initialText: markdown });
}

export async function exportActiveDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const pane = editors.activePane;
	if (!isDocumentPane(pane)) throw new Error(localize('document.conversion.documentRequired', 'Open a document before exporting its content.'));
	const copy = pane.workingCopy;
	if (!copy) return;
	const text = pane.exportText(format);
	const extension = format === 'markdown' ? '.md' : '.txt';
	const name = basename(copy.resource).replace(/\.[^.]+$/, '') + extension;
	const untitled = await accessor.get(IUntitledTextEditorService).resolve({
		untitledResource: URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}` }),
		initialValue: text, languageId: format === 'markdown' ? 'markdown' : 'plaintext',
	});
	await editors.openEditor(new UntitledTextEditorInput(untitled), { pinned: true });
}

/** Host-owned target selection and binary IO; the admitted package owns all format semantics. */
export async function exportDocumentArtifact(accessor: ServicesAccessor, formatId?: string): Promise<void> {
	const editors = accessor.get(IEditorPart), dialogs = accessor.get(IFileDialogService);
	const instantiation = accessor.get(IInstantiationService);
	const pane = editors.activePane;
	if (!isDocumentPane(pane) || !pane.workingCopy) throw new Error(localize('document.conversion.documentRequired', 'Open a document before exporting its content.'));
	const copy = pane.workingCopy, resource = copy.resource;
	const source = pane.id === DOCS_ARKDOWN_EDITOR_ID ? pane.exportText('markdown') : '';
	const formats = pane.getArtifactFormats();
	const id = formatId ?? await chooseArtifactFormat(accessor, formats);
	const format = formats.find(format => format.id === id); if (!format) return;
	if (editors.activePane !== pane || pane.workingCopy !== copy) return;
	if (pane.id === DOCS_ARKDOWN_EDITOR_ID) {
		await instantiation.invokeFunction(exportDocsFile, source, resource, format.id, editors.domNode.ownerDocument,
			() => editors.activePane === pane && pane.workingCopy === copy);
		return;
	}
	const bytes = await pane.exportArtifact(format.id, new AbortController().signal);
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const defaultUri = resource.scheme === 'file' ? resource.with({ path: resource.path.replace(/\.[^/.]+$/, '') + '.' + format.extension }) : URI.file('/' + basename(resource).replace(/\.[^/.]+$/, '') + '.' + format.extension);
	await instantiation.invokeFunction(saveResourceAs, bytes, basename(defaultUri), editors.domNode.ownerDocument, {
		selectTarget: async () => {
			const target = await dialogs.showSaveDialog({ defaultUri, filters: [{ name: format.label, extensions: [format.extension] }] });
			if (!target || pane.workingCopy !== copy) return undefined;
			if (extUri.isEqual(target, resource)) throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
			return target;
		},
	});
}

export async function importDocumentArtifact(accessor: ServicesAccessor): Promise<void> {
	const open = createDocsOpener(accessor);
	const files = accessor.get(IFileService), dialogs = accessor.get(IFileDialogService), editors = accessor.get(IEditorPart);
	const resource = (await dialogs.showOpenDialog({
		canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
		filters: [{ name: localize('document.output.docx', 'Word document (DOCX)'), extensions: ['docx'] }]
	}))?.[0];
	if (!resource) return;
	if (!resource.path.toLowerCase().endsWith('.docx')) throw new Error(localize('document.output.unsupportedInput', 'The selected file format is not supported by this document provider.'));
	if ((await files.stat(resource)).sizeBytes > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const bytes = (await files.readFileBytes(resource)).bytes;
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const { importDocsDocx } = await import('./docsDocxImport.js');
	const markdown = await importDocsDocx(bytes, editors.domNode.ownerDocument, new AbortController().signal);
	await open(newDocsResource(basename(resource).replace(/\.[^.]+$/, '')), { initialText: markdown });
}

async function chooseArtifactFormat(accessor: ServicesAccessor, formats: ReturnType<DocumentEditorPane['getArtifactFormats']>): Promise<string | undefined> {
	using store = new DisposableStore();
	const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: string; readonly label: string; }>());
	const icons: Readonly<Record<string, string | undefined>> = {
		docx: ThemeIcon.asClassName(Lxicon.docxBlue),
		pdf: ThemeIcon.asClassName(Lxicon.pdfRed),
		markdown: ThemeIcon.asClassName(Lxicon.markdown),
	};
	picker.items = formats.map(format => ({ id: format.id, label: format.label, iconClass: icons[format.id] }));
	picker.placeholder = picker.ariaLabel = localize('document.output.choose', 'Choose document output format');
	return await new Promise(resolve => {
		store.add(picker.onDidAccept(() => { resolve((picker.selectedItems[0] ?? picker.activeItems[0])?.id); picker.hide(); }));
		store.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}

/** Ordered once for the title menu, command picker and file extension selection. */
export function getDocsExportFormats() {
	return [
		{
			id: 'docx', label: localize({ bundle: 'ash.docs', key: 'exportDocx' }, 'Word document (.docx)'),
			extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', canImport: true, icon: Lxicon.docxBlue,
		},
		{
			id: 'pdf', label: localize({ bundle: 'ash.docs', key: 'exportPdf' }, 'PDF document (.pdf)'),
			extension: 'pdf', mimeType: 'application/pdf', canImport: false, icon: Lxicon.pdfRed,
		},
		{
			id: 'markdown', label: localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'),
			extension: 'md', mimeType: 'text/markdown', canImport: true, icon: Lxicon.markdown,
		},
	] as const;
}

/** Source is captured by the caller before loading codecs or waiting for resources. */
export async function exportDocsDocument(source: string, format: string, owner: Document, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted();
	if (format === 'markdown') return new TextEncoder().encode(source);
	if (format !== 'docx' && format !== 'pdf') throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
	const { createDocsExportContent } = await import('./docsExportContent.js');
	const content = await createDocsExportContent(source, owner, signal);
	if (format === 'docx') {
		const { exportDocsDocx } = await import('./docsDocxExport.js');
		return exportDocsDocx(content, signal);
	}
	const { exportDocsPdf } = await import('./docsPdfExport.js');
	return exportDocsPdf(content, signal);
}

/** Both title actions and command exports use this destination and source-protection policy. */
export async function exportDocsFile(accessor: ServicesAccessor, source: string, resource: URI, formatId: string, owner: Document, isCurrent: () => boolean): Promise<void> {
	const instantiation = accessor.get(IInstantiationService);
	const dialogs = accessor.get(IFileDialogService);
	const format = getDocsExportFormats().find(format => format.id === formatId);
	if (!format) throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
	const bytes = await exportDocsDocument(source, format.id, owner, new AbortController().signal);
	if (!isCurrent()) return;
	if (bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const name = basename(resource).replace(/\.[^/.]+$/, '') + '.' + format.extension;
	await instantiation.invokeFunction(saveResourceAs, bytes, name, owner, {
		selectTarget: isNative ? async () => {
			const target = await dialogs.showSaveDialog({
				defaultUri: resource.scheme === 'file' ? resource.with({ path: resource.path.replace(/\.[^/.]+$/, '') + '.' + format.extension }) : URI.file('/' + name),
				filters: [{ name: format.label, extensions: [format.extension] }],
			});
			if (!isCurrent()) return undefined;
			if (target && extUri.isEqual(target, resource)) throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
			return target;
		} : undefined,
	});
}

function isDocumentPane(pane: IEditorPane | undefined): pane is DocumentEditorPane | ArkdownDocsEditorPane {
	return pane instanceof DocumentEditorPane || pane?.id === DOCS_ARKDOWN_EDITOR_ID;
}
