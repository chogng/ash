import './media/chatDiffBlockPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatEditDiff, IChatEditFileDiff, IChatEditPresentation } from './chatEditPresentation.js';
import { DefaultChatEditPresentation } from './defaultChatEditPresentation.js';
import { ChatMultiDiffContentPart } from './chatMultiDiffContentPart.js';

/** Reads unified diff hunks and the headerless snippets used in Chat. */
export function parseUnifiedDiff(diffText: string): { before: string; after: string; } {
	const lines = diffText.split(/\r\n|\r|\n/u);
	const before: string[] = [];
	const after: string[] = [];
	let inHunk = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith('diff --git ')) {
			inHunk = false;
			continue;
		}
		if (/^@@(?:\s|$)/u.test(line)) {
			inHunk = true;
			continue;
		}
		if (line === '\\ No newline at end of file') continue;
		if (!inHunk && line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
			index++;
			continue;
		}
		if (!inHunk && /^(?:index [0-9a-f]+\.\.|(?:new file|deleted file|old|new) mode \d+|(?:rename|copy) (?:from|to) |(?:dis)?similarity index )/u.test(line)) continue;
		switch (line[0]) {
			case '-': before.push(line.slice(1)); break;
			case '+': after.push(line.slice(1)); break;
			default: {
				const context = line[0] === ' ' ? line.slice(1) : line;
				before.push(context);
				after.push(context);
			}
		}
	}
	return { before: before.join('\n'), after: after.join('\n') };
}

export interface IMarkdownDiffBlockData extends IChatEditDiff {
	readonly source: string;
	readonly files?: readonly IChatEditFileDiff[];
}

/** Git's file header is outside hunks, whose lines always carry a context or edit prefix. */
export function parseUnifiedDiffFiles(source: string, languageId: string): readonly IChatEditFileDiff[] | undefined {
	const sections = source.split(/(?=^diff --git )/mu).filter(section => section.startsWith('diff --git '));
	if (sections.length < 2) return undefined;
	return sections.map(section => {
		const header = section.split(/^@@(?:\s|$)/mu, 1)[0];
		const beforePath = /^--- ([^\r\n\t]+)/mu.exec(header)?.[1];
		const afterPath = /^\+\+\+ ([^\r\n\t]+)/mu.exec(header)?.[1];
		const path = (afterPath === '/dev/null' ? beforePath : afterPath)?.replace(/^[ab]\//u, '');
		const { before, after } = parseUnifiedDiff(section);
		return { path, languageId, beforeContent: before, afterContent: after };
	});
}

/** Owns the two transient editor documents of one read-only Markdown comparison. */
export class MarkdownDiffBlockPart extends Disposable {
	readonly element: HTMLElement;
	private readonly source: HTMLPreElement;
	private readonly host: HTMLElement;
	private readonly comparison = this._register(new MutableDisposable<IChatEditPresentation>());
	private data: IMarkdownDiffBlockData | undefined;
	private visible = false;
	private selectedFile = 0;

	constructor(
		document: Document,
		private readonly onDidChangeHeight: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.element = h(document, 'div', { className: 'ash-chat-markdown-diff' });
		this.source = h(document, 'pre', { className: 'ash-chat-markdown-diff-source' });
		this.host = h(document, 'div', { className: 'ash-chat-markdown-diff-editor' });
		this.host.hidden = true;
		this.element.append(this.source, this.host);
	}

	get languageId(): string | undefined { return this.data?.languageId; }

	render(data: IMarkdownDiffBlockData): void {
		if (this.data?.source === data.source && this.data.languageId === data.languageId) return;
		const previousPath = this.data?.files?.[this.selectedFile]?.path;
		this.selectedFile = previousPath ? Math.max(0, data.files?.findIndex(file => file.path === previousPath) ?? -1) : 0;
		this.data = data;
		this.source.textContent = data.source;
		this.comparison.clear();
		if (this.visible) this.showComparison();
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) {
			this.showComparison();
		} else {
			this.comparison.clear();
			this.host.hidden = true;
			this.source.hidden = false;
		}
	}

	focus(original = false): void {
		this.setVisible(true);
		this.comparison.value?.focus(original);
	}

	private showComparison(): void {
		if (!this.data || this.comparison.value) return;
		this.host.hidden = false;
		this.source.hidden = true;
		const layout = (height: number) => {
			const size = `${height}px`;
			if (this.element.style.blockSize !== size) {
				this.element.style.blockSize = size;
				this.onDidChangeHeight();
			}
		};
		this.comparison.value = this.data.files
			? this.instantiation.createInstance(ChatMultiDiffContentPart, this.host, this.data.files, this.selectedFile, (index: number) => { this.selectedFile = index; }, layout)
			: this.instantiation.createInstance(DefaultChatEditPresentation, this.host, this.data, layout);
	}
}
