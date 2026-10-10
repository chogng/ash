import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { localize } from '../../../../nls.js';
import type { RenderableMatch } from './searchTreeModel/searchResult.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContentSearchConfiguration } from '../common/searchConfiguration.js';

interface SearchResultRenderOptions {
	readonly treeView: boolean;
	readonly showWorkspace: boolean;
	readonly folderNames?: readonly string[];
}

/** Owns result-row presentation and row resources, without altering retained data or editor ranges. */
export class SearchResultsRenderer extends Disposable {
	private readonly rows = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private lineNumberDigits = 1;

	constructor(
		private readonly document: Document,
		private readonly showContextMenu: (element: RenderableMatch, anchor: ContextMenuAnchor) => void,
		private readonly onRemoveElement: (element: RenderableMatch) => void,
		@IHoverService private readonly hover: IHoverService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	public setLineNumberBudget(maximumLineNumber: number): void {
		this.lineNumberDigits = String(maximumLineNumber).length;
	}

	public render(element: RenderableMatch, options: SearchResultRenderOptions): HTMLElement {
		const content = h(this.document, 'span');
		content.className = 'ash-search-result';
		const resources = new DisposableStore();
		this.rows.set(content, resources);
		if (element.kind === 'match') {
			content.classList.add('ash-search-match');
			const showLineNumbers = this.configuration.getValue<boolean>(ContentSearchConfiguration.showLineNumbers);
			const extraLines = element.range.endLineNumber - element.range.startLineNumber;
			const lineLabel = (showLineNumbers ? `${element.range.startLineNumber}:` : '') + (extraLines > 0 ? `+${extraLines}` : '');
			if (lineLabel) {
				// A shared budget aligns numbered results; a multiline hint remains visible without line numbers.
				const digits = showLineNumbers ? Math.max(this.lineNumberDigits + 1, lineLabel.length) : lineLabel.length;
				content.style.gridTemplateColumns = `calc(${digits}ch + 4px) minmax(0, 1fr)`;
				const line = h(this.document, 'span');
				line.className = 'ash-search-line-number';
				line.textContent = lineLabel;
				content.append(line);
			} else {
				content.style.gridTemplateColumns = 'minmax(0, 1fr)';
			}
			const preview = h(this.document, 'code');
			preview.className = 'ash-search-preview';
			appendPreview(this.document, preview, element);
			content.append(preview);
			content.setAttribute('aria-label', localize('search.matchLabel', 'Line {0}, column {1}: {2}', element.range.startLineNumber, element.range.startColumn, element.preview));
		} else {
			content.classList.add('ash-search-file-heading');
			const labelContainer = h(this.document, 'span');
			labelContainer.className = element.kind === 'file' ? 'ash-search-file-path' : 'ash-search-folder-path';
			content.append(labelContainer);
			const parent = element.kind === 'file' ? element.path.slice(0, Math.max(0, element.path.lastIndexOf('/'))) : '';
			const description = element.kind === 'file' && !options.treeView ? [options.showWorkspace ? element.folder?.name : '', parent].filter(Boolean).join(' • ') : undefined;
			const label = options.folderNames?.join('/') ?? element.name;
			resources.add(new IconLabel(labelContainer, {
				label,
				description,
				title: element.resource.toString(),
				ariaLabel: description ? `${label}, ${description}` : label,
			}));
			if (element.kind === 'file') {
				const badge = resources.add(new CountBadge(content, { count: element.matches.length, size: 'small' }));
				badge.domNode.classList.add('ash-search-file-count');
			}
		}
		resources.add(this.hover.setupHover({ target: content, content: element.kind === 'match' ? element.preview : element.resource.toString() }));
		resources.add(addDisposableListener(content, 'contextmenu', event => {
			event.preventDefault();
			event.stopPropagation();
			this.showContextMenu(element, { x: event.clientX, y: event.clientY, targetWindow: this.document.defaultView ?? undefined });
		}));
		// A removed or virtualized row cannot retain an actionable context menu.
		resources.add(toDisposable(() => this.onRemoveElement(element)));
		return content;
	}

	public releaseRow(row: HTMLElement): void {
		const content = row.querySelector<HTMLElement>('.ash-search-result');
		if (content) { this.rows.deleteAndDispose(content); }
	}
}

function appendPreview(document: Document, container: HTMLElement, match: Extract<RenderableMatch, { kind: 'match'; }>): void {
	const text = match.preview;
	const hitStart = Math.max(0, Math.min(text.length, match.previewRange.start));
	const hitEnd = Math.max(hitStart, Math.min(text.length, match.previewRange.end));
	const display = (value: string): string => value.replace(/\r\n|\r|\n/g, ' ↵ ');
	const before = display(text.slice(0, hitStart));
	const hit = display(text.slice(hitStart, hitEnd));
	const after = display(text.slice(hitEnd));
	let start = Math.max(0, before.length - 26);
	// Only presentation boundaries change. The complete hit and backend UTF-16 range stay intact,
	// even when one unusually long match exceeds the surrounding-text budget.
	if (start > 0 && isLowSurrogate(before.charCodeAt(start))) { start++; }
	// Reserve the ellipses and rendered context separators within the existing preview text limit.
	let end = Math.min(after.length, Math.max(0, 246 - (before.length - start) - hit.length));
	if (end < after.length && isLowSurrogate(after.charCodeAt(end))) { end--; }
	// Context yields width before the hit so narrow result rows still show what matched.
	const prefix = h(document, 'span');
	prefix.className = 'ash-search-preview-context';
	prefix.textContent = (start ? '…' : '') + before.slice(start);
	const mark = h(document, 'mark');
	mark.textContent = hit;
	const suffix = h(document, 'span');
	suffix.className = 'ash-search-preview-context';
	suffix.textContent = after.slice(0, end) + (end < after.length ? '…' : '');
	container.append(prefix, mark, suffix);
}

function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }
