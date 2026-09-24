import { h } from '../../../../base/browser/dom.js';
import { sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';
import { type VSDataTransfer } from '../../../../base/common/dataTransfer.js';
import { Mimes } from '../../../../base/common/mime.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type Range } from '../../../common/core/range.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type IViewModel } from '../../../common/viewModel.js';
import { type ILogService } from '../../../../platform/log/common/log.js';
import { toExternalVSDataTransfer } from '../../dataTransfer.js';

export interface ClipboardDataToCopy {
	readonly isFromEmptySelection: boolean;
	readonly sourceRanges: Range[];
	readonly multicursorText: string[] | null | undefined;
	readonly text: string;
	readonly html: string | null | undefined;
	readonly mode: string | null;
}

export interface ClipboardStoredMetadata {
	readonly version: 1;
	readonly id: string | undefined;
	readonly isFromEmptySelection: boolean | undefined;
	readonly multicursorText: string[] | null | undefined;
	readonly mode: string | null;
}

export const CopyOptions = {
	forceCopyWithSyntaxHighlighting: false,
	electronBugWorkaroundCopyEventHasFired: false,
	cutEventHasFired: false,
};

export function generateDataToCopyAndStoreInMemory(viewModel: IViewModel, id: string | undefined, useFirefoxLineEndings: boolean): { dataToCopy: ClipboardDataToCopy; metadata: ClipboardStoredMetadata } {
	const { dataToCopy, metadata } = generateDataToCopy(viewModel, id);
	const storedText = useFirefoxLineEndings ? dataToCopy.text.replaceAll('\r\n', '\n') : dataToCopy.text;
	InMemoryClipboardMetadataManager.INSTANCE.set(storedText, metadata);
	return { dataToCopy, metadata };
}

interface InMemoryClipboardMetadata {
	readonly lastCopiedValue: string;
	readonly data: ClipboardStoredMetadata;
}

export class InMemoryClipboardMetadataManager {
	public static readonly INSTANCE = new InMemoryClipboardMetadataManager();
	private lastState: InMemoryClipboardMetadata | null = null;

	public set(lastCopiedValue: string, data: ClipboardStoredMetadata): void {
		this.lastState = { lastCopiedValue, data };
	}

	public get(pastedText: string): ClipboardStoredMetadata | null {
		if (this.lastState?.lastCopiedValue === pastedText) return this.lastState.data;
		this.lastState = null;
		return null;
	}
}

/** Clipboard data readable by an editor input adapter. */
export interface IReadableClipboardData {
	types: string[];
	readonly files: readonly File[];
	getData(type: string): string;
}

/** Clipboard data writable by an editor input adapter. */
export interface IWritableClipboardData {
	setData(type: string, value: string): void;
}

/** A copy or cut event exposed before the clipboard contribution handles it. */
export interface IClipboardCopyEvent {
	readonly isCut: boolean;
	readonly clipboardData: IWritableClipboardData;
	readonly dataToCopy: ClipboardDataToCopy;
	ensureClipboardGetsEditorData(): void;
	setHandled(): void;
	readonly isHandled: boolean;
}

/** A paste event exposed before the clipboard contribution handles it. */
export interface IClipboardPasteEvent {
	readonly clipboardData: IReadableClipboardData;
	readonly metadata: ClipboardStoredMetadata | null;
	readonly text: string;
	readonly browserEvent: ClipboardEvent | undefined;
	toExternalVSDataTransfer(): VSDataTransfer | undefined;
	setHandled(): void;
	readonly isHandled: boolean;
}

export function createClipboardCopyEvent(
	browserEvent: ClipboardEvent,
	isCut: boolean,
	context: Pick<ViewContext, 'configuration' | 'viewModel'>,
	logService: Pick<ILogService, 'trace'> | undefined,
	useFirefoxLineEndings: boolean,
): IClipboardCopyEvent {
	const { dataToCopy, metadata } = generateDataToCopy(context.viewModel);
	let handled = browserEvent.defaultPrevented;
	return {
		isCut,
		clipboardData: createWritableClipboardData(browserEvent.clipboardData),
		dataToCopy,
		ensureClipboardGetsEditorData: () => {
			browserEvent.preventDefault();
			if (browserEvent.clipboardData) {
				ClipboardEventUtils.setTextData(browserEvent.clipboardData, dataToCopy.text, dataToCopy.html, metadata);
			}
			const storedText = useFirefoxLineEndings ? dataToCopy.text.replaceAll('\r\n', '\n') : dataToCopy.text;
			InMemoryClipboardMetadataManager.INSTANCE.set(storedText, metadata);
			logService?.trace('Stored editor clipboard metadata', metadata.id, dataToCopy.text.length);
		},
		setHandled: () => {
			if (handled) return;
			handled = true;
			browserEvent.preventDefault();
			browserEvent.stopImmediatePropagation();
		},
		get isHandled(): boolean {
			return handled;
		},
	};
}

function generateDataToCopy(viewModel: IViewModel, id?: string): { dataToCopy: ClipboardDataToCopy; metadata: ClipboardStoredMetadata } {
	const emptySelectionClipboard = viewModel.getEditorOption(EditorOption.emptySelectionClipboard);
	const copyWithSyntaxHighlighting = viewModel.getEditorOption(EditorOption.copyWithSyntaxHighlighting);
	const selections = viewModel.getCursorStates().map(cursor => cursor.modelState.selection);
	const { sourceRanges, sourceText } = viewModel.getPlainTextToCopy(selections, emptySelectionClipboard, isWindows);
	const text = Array.isArray(sourceText) ? sourceText.join(isWindows ? '\r\n' : '\n') : sourceText;
	const richText = CopyOptions.forceCopyWithSyntaxHighlighting || (copyWithSyntaxHighlighting && text.length < 65_536)
		? viewModel.getRichTextToCopy(selections, emptySelectionClipboard)
		: null;
	const dataToCopy: ClipboardDataToCopy = Object.freeze({
		isFromEmptySelection: emptySelectionClipboard && selections.length === 1 && selections[0]!.isEmpty(),
		sourceRanges,
		multicursorText: Array.isArray(sourceText) ? sourceText : null,
		text,
		html: richText?.html,
		mode: richText?.mode ?? null,
	});
	return {
		dataToCopy,
		metadata: Object.freeze({
			version: 1,
			id: id ?? generateUuid(),
			isFromEmptySelection: dataToCopy.isFromEmptySelection,
			multicursorText: dataToCopy.multicursorText,
			mode: dataToCopy.mode,
		}),
	};
}

export function createClipboardPasteEvent(browserEvent: ClipboardEvent): IClipboardPasteEvent {
	let handled = false;
	const clipboardData = createReadableClipboardData(browserEvent.clipboardData);
	let [text, metadata] = ClipboardEventUtils.getTextData(clipboardData);
	metadata ||= InMemoryClipboardMetadataManager.INSTANCE.get(text);
	return {
		clipboardData,
		metadata,
		text,
		browserEvent,
		toExternalVSDataTransfer: () => browserEvent.clipboardData ? toExternalVSDataTransfer(browserEvent.clipboardData) : undefined,
		setHandled: () => {
			if (handled) return;
			handled = true;
			browserEvent.preventDefault();
			browserEvent.stopImmediatePropagation();
		},
		get isHandled(): boolean {
			return handled;
		},
	};
}

const ClipboardEventUtils = {
	getTextData(clipboardData: IReadableClipboardData | DataTransfer): [string, ClipboardStoredMetadata | null] {
		const text = clipboardData.getData(Mimes.text);
		let metadata: ClipboardStoredMetadata | null = null;
		const rawMetadata = clipboardData.getData('vscode-editor-data');
		if (typeof rawMetadata === 'string' && rawMetadata.length > 0) {
			try {
				const parsed = JSON.parse(rawMetadata) as ClipboardStoredMetadata;
				if (parsed.version === 1) metadata = parsed;
			} catch {
				// Invalid metadata is ignored; plain text remains authoritative.
			}
		}
		if (text.length === 0 && metadata === null && clipboardData.files.length > 0) {
			return [[...clipboardData.files].map(file => file.name).join('\n'), null];
		}
		return [text, metadata];
	},

	setTextData(clipboardData: IWritableClipboardData, text: string, html: string | null | undefined, metadata: ClipboardStoredMetadata): void {
		clipboardData.setData(Mimes.text, text);
		if (typeof html === 'string') clipboardData.setData(Mimes.html, html);
		clipboardData.setData('vscode-editor-data', JSON.stringify(metadata));
	},
};

export function createReadableClipboardData(dataTransfer: DataTransfer | undefined | null): IReadableClipboardData {
	return {
		types: Array.from(dataTransfer?.types ?? []),
		files: Array.prototype.slice.call(dataTransfer?.files ?? [], 0),
		getData: (type: string) => dataTransfer?.getData(type) ?? '',
	};
}

export function createWritableClipboardData(dataTransfer: DataTransfer | undefined | null): IWritableClipboardData {
	return {
		setData: (type: string, value: string) => {
			if (!dataTransfer) throw new Error('Clipboard data is unavailable');
			dataTransfer.setData(type, value);
		},
	};
}

export function readEditorClipboardText(clipboardData: IReadableClipboardData, ownerDocument: Document): string {
	try {
		const text = clipboardData.getData(Mimes.text);
		if (text.length > 0) return text;
	} catch {
		// A browser transfer may expose HTML without allowing plain-text access.
	}
	try {
		return readEditorHtmlText(clipboardData.getData(Mimes.html), ownerDocument);
	} catch {
		return '';
	}
}

/** Reduces untrusted HTML to inert deterministic text for paste and drop paths. */
export function readEditorHtmlText(html: string, ownerDocument: Document): string {
	if (html.length === 0) return '';
	const fragment = sanitizeHtmlToFragment(html, { ownerDocument, config: {} });
	// Block boundaries separate content; explicit breaks and text whitespace are retained.
	const parts: Array<string | null> = [];
	appendHtmlClipboardText(fragment, parts);
	let text = '';
	let blockBoundary = false;
	for (const part of parts) {
		if (part === null) {
			blockBoundary = true;
		} else if (part.length > 0) {
			if (blockBoundary && text.length > 0 && !text.endsWith('\n')) {
				text += '\n';
			}
			text += part;
			blockBoundary = false;
		}
	}
	return text.replaceAll('\u00a0', ' ');
}

function appendHtmlClipboardText(node: Node, parts: Array<string | null>): void {
	if (node.nodeType === node.TEXT_NODE) {
		parts.push(node.textContent ?? '');
		return;
	}
	if (node.nodeType !== node.ELEMENT_NODE && node.nodeType !== node.DOCUMENT_FRAGMENT_NODE) return;
	const element = node.nodeType === node.ELEMENT_NODE ? node as HTMLElement : undefined;
	if (element && (element.localName === 'script' || element.localName === 'style' || element.localName === 'noscript')) return;
	if (element?.localName === 'br') {
		parts.push('\n');
		return;
	}
	const block = element !== undefined && HTML_CLIPBOARD_BLOCK_ELEMENTS.has(element.localName);
	if (block) parts.push(null);
	for (const child of node.childNodes) appendHtmlClipboardText(child, parts);
	if (block) parts.push(null);
}

const HTML_CLIPBOARD_BLOCK_ELEMENTS = new Set([
	'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption',
	'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
	'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
