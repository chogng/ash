import { convertHtmlToMarkdown } from '../../../../base/browser/htmlToMarkdown.js';
import { escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { basename, extUri } from '../../../../base/common/resources.js';
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
import { saveResourceAs } from '../../../../workbench/browser/download.js';
import type { DocsEditorPane } from './docsEditorPane.js';
import { createDocsOpener, newDocsResource } from './documentActions.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isNative } from '../../../../base/common/platform.js';
import type { IEditorPane } from '../../../../workbench/common/editor.js';
import { DOCS_ARKDOWN_EDITOR_ID } from '../common/docs.js';

import { unzipFiles } from '../../../../base/browser/zip.js';
import { createZip } from '../../../../base/common/zip.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { createImagePdf } from '../../../../base/common/pdf.js';
import { readDocsCommentEvent } from '../../../../workbench/contrib/markdown/common/arkdownComments.js';
import { defaultDocsTypography, DocsFontFamily, readDocsTypography, type DocsTypography } from '../../../../workbench/contrib/markdown/common/arkdownTypography.js';
import { readDocsDropdown } from '../../../../workbench/contrib/markdown/common/arkdownDropdown.js';
import { checkDocsImageSize, isArkdownImageSource, readArkdownImage, readArkdownImageLayout, writeArkdownImage, type ArkdownImageSource } from '../../../../workbench/contrib/markdown/browser/arkdown/arkdownImages.js';
import type { ArkdownNode } from '../../../../workbench/contrib/markdown/browser/arkdown/arkdownRuntime.js';

/** Writing blocks use the same inert HTML conversion as clipboard imports. */
export function importDocsHtml(html: string, ownerDocument: Document): string | undefined {
	return convertHtmlToMarkdown(html, ownerDocument) || undefined;
}

/** Only parsed image ranges change; the source outside them stays byte-for-byte intact. */
export async function importDocsText(text: string, format: DocumentTextFormat, resource: URI, readResource: (resource: URI) => Promise<Uint8Array>): Promise<string> {
	if (format === 'text') return text.replace(/\r\n?/g, '\n').split('\n').map(line => escapeMarkdownSyntaxTokens(line)).join('\n');
	if (!text.includes('![')) return text;
	const { loadArkdown } = await import('../../../../workbench/contrib/markdown/browser/arkdown/arkdownRuntime.js');
	const runtime = await loadArkdown();
	const images: ArkdownNode[] = [];
	const collect = (nodes: readonly ArkdownNode[]): void => {
		for (const node of nodes) {
			if (node.kind === 'image') {
				if (node.destination && !/^(?:https?:|data:)/i.test(node.destination)) images.push(node);
			} else collect(node.children);
		}
	};
	{
		using projection = runtime.createProjection();
		collect(projection.parse(text));
	}
	// Resolve all source destinations before starting IO. Each resource is read
	// once even if reference syntax or repeated images refer to the same bytes.
	const edits = images.map(node => ({ node, target: URI.parse(new URL(node.destination!, resource.toString()).href) }));
	const resources = new Map<string, Promise<ArkdownImageSource>>();
	const description = (node: ArkdownNode): string => node.text ?? node.children.map(description).join('');
	const replacements = await Promise.all(edits.map(async ({ node, target }) => {
		let image = resources.get(target.toString());
		if (!image) {
			image = readResource(target).then(bytes => readArkdownImage(bytes, basename(target)));
			resources.set(target.toString(), image);
		}
		const layout = readArkdownImageLayout(node.title);
		const content = writeArkdownImage({ ...(await image), description: description(node), title: layout.title }, layout);
		return { range: node.range, content };
	}));
	for (const edit of replacements.sort((a, b) => b.range.start - a.range.start)) text = text.slice(0, edit.range.start) + edit.content + text.slice(edit.range.end);
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
	const typography = readDocsTypography(source)?.value ?? defaultDocsTypography;
	const content = await createDocsExportContent(source, typography, owner, signal);
	if (format === 'docx') {
		return exportDocsDocx(content, typography, signal);
	}
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

function isDocumentPane(pane: IEditorPane | undefined): pane is DocumentEditorPane | DocsEditorPane {
	return pane instanceof DocumentEditorPane || pane?.id === DOCS_ARKDOWN_EDITOR_ID;
}

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const decodeDocxXml = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function unsupportedDocxImport(): never { throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImport' }, 'This document contains content that Docs cannot import.')); }

/** Read interoperable OOXML only. Extension snapshots never select a model or editor. */
export async function importDocsDocx(bytes: Uint8Array, owner: Document, signal: AbortSignal): Promise<string> {
	const files = await unzipFiles(bytes, signal);
	const parse = (path: string): XMLDocument => {
		const data = files.get(path);
		if (!data) return unsupportedDocxImport();
		const text = decodeDocxXml(data);
		if (/<!DOCTYPE|<!ENTITY/i.test(text)) return unsupportedDocxImport();
		const xml = new owner.defaultView!.DOMParser().parseFromString(text, 'application/xml');
		if (xml.getElementsByTagName('parsererror').length) return unsupportedDocxImport();
		return xml;
	};
	const relationships = (path: string) => {
		const slash = path.lastIndexOf('/');
		const relPath = path.slice(0, slash + 1) + '_rels/' + path.slice(slash + 1) + '.rels';
		const result = new Map<string, { type: string; target: string; external: boolean; }>();
		if (!files.has(relPath)) return result;
		const root = parse(relPath).documentElement;
		if (root.namespaceURI !== packageNamespace || root.localName !== 'Relationships') return unsupportedDocxImport();
		for (const element of root.children) {
			const id = element.getAttribute('Id'), type = element.getAttribute('Type'), target = element.getAttribute('Target');
			if (element.namespaceURI !== packageNamespace || element.localName !== 'Relationship' || !id || !type || !target || result.has(id)) return unsupportedDocxImport();
			const external = element.getAttribute('TargetMode') === 'External';
			const resolved = new URL(target, 'https://package.invalid/' + path);
			if (!external && (resolved.origin !== 'https://package.invalid' || resolved.search || resolved.hash)) return unsupportedDocxImport();
			result.set(id, { type, external, target: external ? target : decodeURIComponent(resolved.pathname.slice(1)) });
		}
		return result;
	};
	if ([...files.keys()].some(path => /vbaProject|\/embeddings\/|\/activeX\//i.test(path))) return unsupportedDocxImport();
	const main = [...relationships('').values()].find(rel => rel.type === office + '/officeDocument');
	if (!main || main.external) return unsupportedDocxImport();
	const rels = relationships(main.target);
	const document = parse(main.target);
	if (document.documentElement.namespaceURI !== word || document.documentElement.localName !== 'document') return unsupportedDocxImport();
	const body = document.getElementsByTagNameNS(word, 'body');
	if (body.length !== 1) return unsupportedDocxImport();
	const images = new Map<string, string>();
	for (const blip of body[0].getElementsByTagNameNS(drawing, 'blip')) {
		const id = blip.getAttributeNS(office, 'embed') ?? '';
		if (images.has(id)) continue;
		const relation = rels.get(id);
		if (!relation || relation.external || relation.type !== office + '/image') return unsupportedDocxImport();
		const data = files.get(relation.target);
		if (!data) return unsupportedDocxImport();
		images.set(id, (await readArkdownImage(data, relation.target)).source);
		signal.throwIfAborted();
	}
	const value = (element: Element | undefined, attr = 'val') => element?.getAttributeNS(word, attr);
	const child = (element: Element, name: string) => [...element.children].find(node => node.namespaceURI === word && node.localName === name);
	const numbering = new Map<string, { ordered: boolean; start: number; }>();
	const numberPart = [...rels.values()].find(rel => rel.type === office + '/numbering');
	if (numberPart) {
		if (numberPart.external) return unsupportedDocxImport();
		const root = parse(numberPart.target).documentElement;
		for (const number of [...root.children].filter(node => node.localName === 'num')) {
			const abstractId = value(child(number, 'abstractNumId'));
			const abstract = [...root.children].find(node => node.localName === 'abstractNum' && value(node, 'abstractNumId') === abstractId);
			if (!abstract) return unsupportedDocxImport();
			for (const level of [...abstract.children].filter(node => node.localName === 'lvl')) {
				const format = value(child(level, 'numFmt'));
				if (format !== 'decimal' && format !== 'bullet') return unsupportedDocxImport();
				const index = value(level, 'ilvl') ?? '0';
				const override = [...number.children].find(node => node.localName === 'lvlOverride' && value(node, 'ilvl') === index);
				const start = Number(value(override ? child(override, 'startOverride') : undefined) ?? value(child(level, 'start')) ?? '1');
				if (!Number.isSafeInteger(start) || start < 0) return unsupportedDocxImport();
				numbering.set(`${value(number, 'numId')}:${index}`, { ordered: format === 'decimal', start });
			}
		}
	}
	const output = owner.createElement('article');
	const enabled = (element: Element, name: string) => { const property = child(element, name); return !!property && !['0', 'false', 'off'].includes(value(property) ?? ''); };
	const append = (source: Element, parent: HTMLElement, depth: number): void => {
		signal.throwIfAborted();
		if (depth > 100) return unsupportedDocxImport();
		const lists: { id: string; list: HTMLElement; }[] = [];
		for (const node of source.children) {
			if (node.namespaceURI !== word) return unsupportedDocxImport();
			const name = node.localName;
			if (['pPr', 'rPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'sectPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'lastRenderedPageBreak'].includes(name)) continue;
			if (name === 't') { parent.append(owner.createTextNode(node.textContent ?? '')); continue; }
			if (name === 'tab') { parent.append(owner.createTextNode('\t')); continue; }
			if (name === 'br' || name === 'cr') { parent.append(owner.createElement('br')); continue; }
			if (name === 'drawing') {
				const blips = node.getElementsByTagNameNS(drawing, 'blip');
				if (blips.length !== 1) return unsupportedDocxImport();
				const source = images.get(blips[0].getAttributeNS(office, 'embed') ?? '');
				if (!source) return unsupportedDocxImport();
				const image = owner.createElement('img');
				image.src = source;
				image.alt = [...node.getElementsByTagName('*')].find(element => element.localName === 'docPr')?.getAttribute('descr') || '';
				parent.append(image); continue;
			}
			if (name === 'hyperlink') {
				const anchor = value(node, 'anchor');
				const rel = rels.get(node.getAttributeNS(office, 'id') ?? '');
				const href = anchor ? '#' + anchor : rel?.external && rel.type === office + '/hyperlink' ? rel.target : undefined;
				if (!href || !/^(https?:|mailto:|#)/i.test(href)) return unsupportedDocxImport();
				const link = owner.createElement('a'); link.setAttribute('href', href); append(node, link, depth + 1); parent.append(link); continue;
			}
			if (name !== 'p') lists.length = 0;
			if (name === 'r') {
				const run = owner.createElement('span'), properties = child(node, 'rPr');
				append(node, run, depth + 1);
				let formatted: HTMLElement = run;
				for (const [property, tag] of [['b', 'strong'], ['i', 'em'], ['strike', 'del']] as const) if (properties && enabled(properties, property)) {
					const wrapper = owner.createElement(tag); wrapper.append(formatted); formatted = wrapper;
				}
				parent.append(formatted); continue;
			}
			if (name === 'p') {
				const properties = child(node, 'pPr');
				const num = properties && child(properties, 'numPr');
				const numId = num && value(child(num, 'numId'));
				if (numId && numId !== '0') {
					const level = Number(value(child(num!, 'ilvl')) ?? '0');
					const definition = numbering.get(`${numId}:${level}`);
					if (!definition || !Number.isInteger(level) || level < 0 || level > 8 || level > lists.length) return unsupportedDocxImport();
					lists.length = Math.min(lists.length, level + 1);
					if (lists[level]?.id !== numId) {
						const list = owner.createElement(definition.ordered ? 'ol' : 'ul');
						if (definition.ordered) list.setAttribute('start', String(definition.start));
						const container = level === 0 ? parent : lists[level - 1].list.lastElementChild;
						if (!container) return unsupportedDocxImport();
						container.append(list); lists[level] = { id: numId, list };
					}
					const item = owner.createElement('li'); append(node, item, depth + 1); lists[level].list.append(item); continue;
				}
				lists.length = 0;
				const style = properties && value(child(properties, 'pStyle'));
				const heading = style?.match(/^Heading([1-6])$/i)?.[1];
				const paragraph = owner.createElement(heading ? `h${heading}` : 'p'); append(node, paragraph, depth + 1); parent.append(paragraph); continue;
			}
			const tag = name === 'tbl' ? 'table' : name === 'tr' ? 'tr' : name === 'tc' ? 'td' : undefined;
			if (!tag) return unsupportedDocxImport();
			if (name === 'tc') {
				const properties = child(node, 'tcPr');
				if (properties && (child(properties, 'vMerge') || Number(value(child(properties, 'gridSpan')) ?? '1') !== 1)) return unsupportedDocxImport();
			}
			const element = owner.createElement(tag); append(node, element, depth + 1); parent.append(element);
		}
	};
	append(body[0], output, 0);
	// The shared HTML converter is bounded for clipboard input. Reject a larger
	// projection explicitly instead of creating an empty document.
	if (output.innerHTML.length > 200_000) return unsupportedDocxImport();
	return convertHtmlToMarkdown(output.innerHTML, owner);
}

const escapeDocxXml = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
const encodeDocxXml = (text: string) => new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text);

/** Standard OOXML paragraphs, runs, numbering, tables and drawings; no private snapshot. */
function exportDocsDocx(content: HTMLElement, typography: DocsTypography, signal: AbortSignal): Uint8Array {
	const files = new Map<string, Uint8Array>();
	const fonts = (family: DocsFontFamily): string => family === DocsFontFamily.Serif
		? '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun"/>'
		: '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/>';
	const relationships: string[] = [], numbering: string[] = [], imageTypes = new Set<string>();
	let nextRelation = 1, nextList = 1, nextImage = 1;
	const relation = (type: string, target: string, external = false) => {
		const id = `rId${nextRelation++}`;
		relationships.push(`<Relationship Id="${id}" Type="${office}/${type}" Target="${escapeDocxXml(target)}"${external ? ' TargetMode="External"' : ''}/>`);
		return id;
	};
	const run = (text: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${text.split(/\n/).map(line => `<w:t xml:space="preserve">${escapeDocxXml(line)}</w:t>`).join('<w:br/>')}</w:r>`;
	const inline = (node: Node, properties = ''): string => {
		signal.throwIfAborted();
		if (node.nodeType === 3) return run(node.textContent ?? '', properties);
		if (node.nodeType !== 1) return '';
		const element = node as HTMLElement, tag = element.tagName;
		if (tag === 'BR') return '<w:r><w:br/></w:r>';
		if (tag === 'IMG') {
			const image = element as HTMLImageElement;
			const match = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(image.src)!;
			const id = nextImage++, extension = match[1], name = `media/image${id}.${extension}`;
			files.set('word/' + name, decodeBase64(match[2]).buffer); imageTypes.add(extension);
			const rel = relation('image', name);
			const width = Math.round(Number(image.dataset.exportWidth) * 9525), height = Math.round(Number(image.dataset.exportHeight) * 9525);
			return `<w:r><w:drawing><wp:inline><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${id}" name="image${id}" descr="${escapeDocxXml(image.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
		}
		const property = tag === 'STRONG' || tag === 'B' ? '<w:b/>' : tag === 'EM' || tag === 'I' ? '<w:i/>' : tag === 'S' ? '<w:strike/>' : tag === 'U' ? '<w:u w:val="single"/>' : tag === 'MARK' ? '<w:highlight w:val="yellow"/>' : tag === 'SUP' || tag === 'SUB' ? `<w:vertAlign w:val="${tag === 'SUP' ? 'superscript' : 'subscript'}"/>` : tag === 'CODE' ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '';
		const color = element.style.color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
		const colorProperty = color ? `<w:color w:val="${color.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}"/>` : '';
		const children = [...element.childNodes].map(child => inline(child, properties + property + colorProperty)).join('');
		if (tag !== 'A' || !element.getAttribute('href')) return children;
		const href = element.getAttribute('href')!;
		return href.startsWith('#') ? children : `<w:hyperlink r:id="${relation('hyperlink', href, true)}">${children}</w:hyperlink>`;
	};
	type List = { id: number; depth: number; };
	const paragraph = (children: string, properties = '', list?: List) => `<w:p><w:pPr>${properties}${list ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${list.id}"/></w:numPr>` : ''}</w:pPr>${children}</w:p>`;
	const blocks = (container: HTMLElement, list?: List, depth = 0): string => {
		const output: string[] = [];
		let pending = '', first = true;
		const flush = () => { if (pending) { output.push(paragraph(pending, '', first ? list : undefined)); pending = ''; first = false; } };
		for (const child of container.childNodes) {
			signal.throwIfAborted();
			if (child.nodeType !== 1) { pending += inline(child); continue; }
			const element = child as HTMLElement, tag = element.tagName;
			if (!/^(P|H[1-6]|PRE|BLOCKQUOTE|UL|OL|TABLE|HR|DL|DT|DD)$/.test(tag)) { pending += inline(element); continue; }
			flush();
			if (tag === 'UL' || tag === 'OL') {
				const id = nextList++, ordered = tag === 'OL', start = element.getAttribute('start') ?? '1';
				numbering.push(`<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="${escapeDocxXml(start)}"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? '%1.' : '•'}"/><w:pPr><w:ind w:left="${(depth + 1) * 360}" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`);
				for (const item of element.children) output.push(blocks(item as HTMLElement, { id, depth }, depth + 1));
			} else if (tag === 'TABLE') {
				const rows = [...(element as HTMLTableElement).rows];
				const spans = new Map<number, { remaining: number; columns: number; }>();
				const columns = Math.max(1, ...rows.map(row => [...row.cells].reduce((sum, cell) => sum + cell.colSpan, 0)));
				const grid = '<w:tblGrid>' + Array.from({ length: columns }, () => '<w:gridCol w:w="2000"/>').join('') + '</w:tblGrid>';
				const tableRows = rows.map(row => {
					const cells: string[] = []; let column = 0;
					const continued = () => {
						while (spans.has(column)) {
							const span = spans.get(column)!;
							cells.push(`<w:tc><w:tcPr><w:gridSpan w:val="${span.columns}"/><w:vMerge/></w:tcPr><w:p/></w:tc>`);
							if (--span.remaining === 0) spans.delete(column);
							column += span.columns;
						}
					};
					for (const cell of row.cells) {
						continued();
						const merge = cell.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '';
						cells.push(`<w:tc><w:tcPr><w:gridSpan w:val="${cell.colSpan}"/>${merge}</w:tcPr>${blocks(cell)}<w:p/></w:tc>`);
						if (cell.rowSpan > 1) spans.set(column, { remaining: cell.rowSpan - 1, columns: cell.colSpan });
						column += cell.colSpan;
					}
					continued();
					return `<w:tr>${cells.join('')}</w:tr>`;
				});
				output.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="B8B8B8"/>`).join('')}</w:tblBorders></w:tblPr>${grid}${tableRows.join('')}</w:tbl>`);
			} else if (tag === 'BLOCKQUOTE' || tag === 'DL' || tag === 'DD') output.push(blocks(element, undefined, depth));
			else {
				const heading = /^H[1-6]$/.test(tag) ? `<w:pStyle w:val="Heading${tag[1]}"/>` : '';
				const rule = tag === 'HR' ? '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>' : '';
				const contents = tag === 'PRE' ? run(element.textContent ?? '', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>') : [...element.childNodes].map(child => inline(child)).join('');
				output.push(paragraph(contents, heading + rule, first ? list : undefined)); first = false;
			}
		}
		flush(); return output.join('');
	};
	const body = blocks(content) || '<w:p/>';
	relation('styles', 'styles.xml');
	if (numbering.length) { relation('numbering', 'numbering.xml'); files.set('word/numbering.xml', encodeDocxXml(`<w:numbering xmlns:w="${word}">${numbering.join('')}</w:numbering>`)); }
	files.set('word/document.xml', encodeDocxXml(`<w:document xmlns:w="${word}" xmlns:r="${office}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="960" w:bottom="960" w:left="960" w:right="960"/></w:sectPr></w:body></w:document>`));
	files.set('word/styles.xml', encodeDocxXml(`<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts(typography.text)}<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${Array.from({ length: 6 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr>${fonts(typography.headings)}<w:b/><w:sz w:val="${40 - index * 3}"/></w:rPr></w:style>`).join('')}</w:styles>`));
	files.set('_rels/.rels', encodeDocxXml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`));
	files.set('word/_rels/document.xml.rels', encodeDocxXml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`));
	files.set('[Content_Types].xml', encodeDocxXml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...imageTypes].map(type => `<Default Extension="${type}" ContentType="image/${type}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${numbering.length ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ''}</Types>`));
	return createZip([...files].map(([path, bytes]) => ({ path, contents: VSBuffer.wrap(new Uint8Array(bytes)) }))).buffer;
}

/** A detached, presentation-only snapshot shared by the two binary codecs. */
async function createDocsExportContent(source: string, typography: DocsTypography, owner: Document, signal: AbortSignal): Promise<HTMLElement> {
	const { loadArkdown } = await import('../../../../workbench/contrib/markdown/browser/arkdown/arkdownRuntime.js');
	const runtime = await loadArkdown();
	signal.throwIfAborted();
	using projection = runtime.createProjection();
	const nodes = projection.parse(source);
	const root = owner.createElement('article');
	root.style.cssText = 'font:16px/1.6 sans-serif;color:#171717;background:white;overflow-wrap:anywhere;';
	root.style.fontFamily = typography.text === DocsFontFamily.Serif ? 'serif' : 'sans-serif';
	const tags: Readonly<Record<string, string>> = {
		paragraph: 'p', block_quote: 'blockquote', strong: 'strong', emphasis: 'em', strikethrough: 's', underline: 'u', highlight: 'mark',
		superscript: 'sup', subscript: 'sub', code: 'code', code_block: 'pre', item: 'li', link: 'a', rule: 'hr',
		definition_list: 'dl', definition_list_title: 'dt', definition_list_definition: 'dd', comment: 'span', text_color: 'span',
	};
	const colors = { red: '#bc3030', yellow: '#916500', green: '#237040', teal: '#14767b', purple: '#8040a0' };
	const text = (node: ArkdownNode): string => node.text ?? node.children.map(text).join('');
	const append = (parent: HTMLElement, node: ArkdownNode): void => {
		const raw = source.slice(node.range.start, node.range.end);
		if (node.kind === 'metadata_block' || node.kind === 'code_block' && (readDocsCommentEvent(raw) || node.range.start === 0 && readDocsTypography(source))) return;
		if (node.kind === 'text') { parent.append(owner.createTextNode(node.text ?? '')); return; }
		if (node.kind === 'soft_break') { parent.append(owner.createTextNode('\n')); return; }
		if (node.kind === 'hard_break') { parent.append(owner.createElement('br')); return; }
		if (node.kind === 'task_list_marker') { parent.append(owner.createTextNode(node.checked ? '☑ ' : '☐ ')); return; }
		if (node.kind === 'code_block') {
			const dropdown = readDocsDropdown(raw);
			if (dropdown) { const paragraph = owner.createElement('p'); paragraph.textContent = `${dropdown.label}: ${dropdown.options[dropdown.selected]}`; parent.append(paragraph); return; }
		}
		if (node.kind === 'table') {
			const table = owner.createElement('table');
			table.style.cssText = 'border-collapse:collapse;width:100%;table-layout:fixed;margin:12px 0;';
			const colgroup = owner.createElement('colgroup');
			for (const width of node.tableLayout!.widths) { const col = owner.createElement('col'); if (width) col.style.width = `${width}px`; colgroup.append(col); }
			table.append(colgroup);
			for (const [rowIndex, row] of node.children.entries()) {
				const tr = owner.createElement('tr'); table.append(tr);
				for (const [column, cell] of row.children.entries()) {
					if (cell.tableCellMissing) continue;
					const layout = node.tableLayout!.cells.find(value => value.row === rowIndex && value.column === column);
					const element = owner.createElement(rowIndex === 0 && node.tableLayout!.header ? 'th' : 'td');
					element.style.cssText = 'border:1px solid #b8b8b8;padding:7px;vertical-align:top;';
					if (layout) { element.rowSpan = layout.rowspan; element.colSpan = layout.colspan; }
					const alignment = node.alignments?.[column];
					if (alignment && alignment !== 'none') element.style.textAlign = alignment;
					for (const child of cell.children) append(element, child);
					tr.append(element);
				}
			}
			parent.append(table); return;
		}
		if (node.kind === 'image') {
			if (!node.destination || !isArkdownImageSource(node.destination)) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			const layout = readArkdownImageLayout(node.title);
			const image = owner.createElement('img');
			image.src = node.destination; image.alt = text(node);
			image.style.cssText = 'max-width:100%;height:auto;';
			if (layout.width) image.style.width = `${layout.width}px`;
			if (layout.alignment !== 'left') { image.style.display = 'block'; image.style.marginLeft = 'auto'; if (layout.alignment === 'center') image.style.marginRight = 'auto'; }
			parent.append(image); return;
		}
		const tag = node.kind === 'heading' ? `h${node.level}` : node.kind === 'list' ? node.start === undefined ? 'ul' : 'ol' : tags[node.kind] ?? 'span';
		const element = owner.createElement(tag);
		if (node.kind === 'heading') element.style.fontFamily = typography.headings === DocsFontFamily.Serif ? 'serif' : 'sans-serif';
		if (tag === 'p') element.style.cssText = 'margin:0 0 12px;';
		if (tag === 'pre') element.style.cssText = 'white-space:pre-wrap;font:13px/1.5 monospace;background:#f4f4f4;padding:12px;';
		if (tag === 'blockquote') element.style.cssText = 'margin:12px 0;padding-left:16px;border-left:3px solid #aaa;';
		if (tag === 'a' && node.destination && /^(?:https?:|mailto:|#)/i.test(node.destination)) { element.setAttribute('href', node.destination); element.style.color = '#185abc'; }
		if (tag === 'ol') element.setAttribute('start', String(node.start));
		if (node.color) element.style.color = colors[node.color];
		if (node.text !== undefined) element.textContent = node.text;
		else if (node.children.length) for (const child of node.children) append(element, child);
		else if (!['rule', 'comment'].includes(node.kind)) element.textContent = raw;
		parent.append(element);
	};
	for (const node of nodes) append(root, node);
	// Freeze image resources as bytes, so neither codec needs the live editor or
	// a network-capable document while serializing the captured version.
	for (const image of root.querySelectorAll('img')) {
		signal.throwIfAborted();
		if (!image.src.startsWith('data:')) {
			const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
			const response = await fetch(image.src, { signal: timeout, credentials: 'omit' });
			const mime = response.headers.get('content-type')?.split(';')[0];
			if (!response.ok || !mime || !/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			checkDocsImageSize(Number(response.headers.get('content-length') ?? 0));
			const bytes = new Uint8Array(await response.arrayBuffer());
			checkDocsImageSize(bytes.length);
			image.src = (await readArkdownImage(bytes, image.alt)).source;
		}
		await raceCancellationError(image.decode(), signal);
		if (/^data:image\/(?:gif|webp);/i.test(image.src)) {
			const canvas = owner.createElement('canvas');
			canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
			if (canvas.width * canvas.height > 32 * 1024 * 1024) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			try { canvas.getContext('2d')!.drawImage(image, 0, 0); image.src = canvas.toDataURL('image/png'); }
			finally { canvas.width = canvas.height = 0; }
			await raceCancellationError(image.decode(), signal);
		}
		if (!image.style.width) image.style.width = `${Math.min(666, image.naturalWidth)}px`;
		const width = Math.min(666, Number.parseFloat(image.style.width));
		image.style.width = `${width}px`;
		image.dataset.exportWidth = String(width);
		image.dataset.exportHeight = String(width * image.naturalHeight / image.naturalWidth);
	}
	return root;
}

/** Render a detached snapshot on white A4 pages in both Desktop and Browser hosts. */
async function exportDocsPdf(content: HTMLElement, signal: AbortSignal): Promise<Uint8Array> {
	const pageWidth = 794, pageHeight = 1123, margin = 64, scale = 2;
	signal.throwIfAborted();
	const owner = content.ownerDocument;
	const frame = owner.createElement('section');
	frame.inert = true; frame.setAttribute('aria-hidden', 'true');
	frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${pageWidth - margin * 2}px;pointer-events:none;`;
	frame.append(content); owner.body.append(frame);
	try {
		await raceCancellationError(owner.fonts.ready, signal);
		const height = content.getBoundingClientRect().height;
		if (height > 256 * (pageHeight - margin * 2)) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
		// Freeze browser defaults too: the SVG image has no host stylesheets.
		for (const element of [content, ...content.querySelectorAll<HTMLElement>('*')]) {
			const style = owner.defaultView!.getComputedStyle(element);
			for (const property of style) element.style.setProperty(property, style.getPropertyValue(property));
		}
		const origin = content.getBoundingClientRect().top;
		const breaks = [...content.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote')]
			.map(element => element.getBoundingClientRect().bottom - origin).sort((a, b) => a - b);
		const html = new owner.defaultView!.XMLSerializer().serializeToString(content);
		if (html.length > 16 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
		const pages: { width: number; height: number; bytes: Uint8Array; pixelWidth: number; pixelHeight: number; }[] = [];
		let top = 0, size = 0;
		do {
			signal.throwIfAborted();
			if (pages.length === 256) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
			const available = pageHeight - margin * 2;
			const limit = Math.min(height, top + available);
			// Prefer a completed block near the page end; tall blocks still advance
			// by a full page rather than leaving a mostly empty page or looping.
			const candidates = breaks.filter(value => value > top + available * 0.6 && value <= limit);
			const bottom = limit < height && candidates.length ? candidates.at(-1)! : limit;
			const sliceHeight = Math.max(1, bottom - top);
			const canvas = owner.createElement('canvas');
			canvas.width = pageWidth * scale; canvas.height = pageHeight * scale;
			try {
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${pageWidth} ${pageHeight}"><rect width="100%" height="100%" fill="white"/><svg x="${margin}" y="${margin}" width="${pageWidth - margin * 2}" height="${sliceHeight}" viewBox="0 ${top} ${pageWidth - margin * 2} ${sliceHeight}"><foreignObject width="${pageWidth - margin * 2}" height="${Math.max(1, height)}">${html}</foreignObject></svg></svg>`;
				const image = new owner.defaultView!.Image();
				image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
				await raceCancellationError(image.decode(), signal);
				const context = canvas.getContext('2d')!;
				context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
				const blob = await raceCancellationError(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(localize({ bundle: 'ash.docs', key: 'exportPdfFailed' }, 'The PDF document could not be rendered.'))), 'image/jpeg', 0.95)), signal);
				const bytes = new Uint8Array(await blob.arrayBuffer());
				size += bytes.length;
				if (size > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
				pages.push({ width: pageWidth * 0.75, height: pageHeight * 0.75, bytes, pixelWidth: canvas.width, pixelHeight: canvas.height });
			} finally { canvas.width = canvas.height = 0; }
			top = Math.max(top + 1, bottom);
		} while (top < height);
		signal.throwIfAborted();
		return createImagePdf(pages);
	} finally { frame.remove(); }
}
