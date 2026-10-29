import './media/binaryEditor.css';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import type { IEditorPaneDescriptor } from '../../editor.js';
import { h } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { BinaryEditorModel } from '../../../common/editor/binaryEditorModel.js';
import { localize } from '../../../../nls.js';
import { EditorPaneMatch, EditorPane } from './editorPane.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { IModelDeltaDecoration } from '../../../../editor/common/model.js';

export const BINARY_EDITOR_ID = 'ash.editor.binary';
const MAX_BINARY_EDITOR_BYTES = 128 * 1024 * 1024;
const MAX_RENDERED_BYTES = 64 * 1024;

/** Read-only hexadecimal/ascii projection for resources that are not safe text. */
export class BaseBinaryResourceEditor extends EditorPane implements IEditorPane {
	readonly id = BINARY_EDITOR_ID;
	protected container: HTMLElement | undefined;
	private content: HTMLElement | undefined;
	private summary: HTMLElement | undefined;
	private metadata: string | undefined;
	private readonly model = this._register(new MutableDisposable<BinaryEditorModel>());
	private readonly projection = this._register(new MutableDisposable<TextModel>());
	private readonly editor = this._register(new MutableDisposable<CodeEditorWidget>());
	private bytes: Uint8Array = new Uint8Array();
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		private readonly projectionMode: 'standalone' | 'comparison',
		@IFileService protected readonly files: IFileService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(BINARY_EDITOR_ID, themeService, storageService);
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError('Binary editor pane has already been created');
		const container = h(parent.ownerDocument, 'div');
		container.className = 'ash-binary-editor';
		container.setAttribute('role', 'region');
		const summary = h(parent.ownerDocument, 'div');
		summary.className = 'ash-binary-editor-summary';
		const content = h(parent.ownerDocument, 'div');
		content.className = 'ash-binary-editor-content';
		container.append(summary, content);
		parent.append(container);
		super.create(container);
		this.container = container;
		this.updateAriaLabel();
		this.summary = summary;
		this.content = content;
		this._register(toDisposable(() => container.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		const summary = this.requireSummary();
		this.requireContent();
		throwIfCancelled(signal, 'Binary editor loading was cancelled');
		const model = this.instantiationService.createInstance(BinaryEditorModel, input.resource, input.label ?? basename(input.resource), input.initialBytes?.length);
		try {
			await raceCancellationError(model.resolve(), signal, 'Binary editor loading was cancelled');
			const size = model.getSize();
			if (size !== undefined && size > MAX_BINARY_EDITOR_BYTES) {
				throw new Error(localize('binaryEditor.tooLarge', 'Binary file is too large to preview ({0})', formatByteCount(size)));
			}
			const resolved = input.initialBytes ? { bytes: input.initialBytes } : await raceCancellationError(this.files.readFileBytes(input.resource), signal, 'Binary editor loading was cancelled');
			throwIfCancelled(signal, 'Binary editor loading was cancelled');
			// Keep only the preview, rather than retaining a large file's backing buffer.
			const visible = resolved.bytes.slice(0, MAX_RENDERED_BYTES);
			this.editor.clear();
			this.projection.clear();
			this.model.value = model;
			this.bytes = visible;
			this.metadata = formatByteCount(resolved.bytes.length);
			this.updateAriaLabel();
			summary.textContent =
				resolved.bytes.length > visible.length
					? localize('binaryEditor.truncatedSummary', '{0} · read-only hexadecimal preview · first {1}', this.metadata, formatByteCount(visible.length))
					: localize('binaryEditor.summary', '{0} · read-only hexadecimal preview', this.metadata);
			// A comparison waits for both byte ranges, avoiding a second full
			// projection and initial line-width scan when the shorter side is padded.
			if (this.projectionMode === 'standalone') this.createProjection(visible.length);
		} catch (error) {
			model.dispose();
			throw error;
		}
	}

	private createProjection(length: number): void {
		const content = this.requireContent();
		const projection = new TextModel(renderHexDump(this.bytes, length), {
			isForSimpleWidget: true,
			resource: this.model.value!.resource.with({ scheme: 'ash-binary-preview' }),
		});
		try {
			const font = content.ownerDocument.defaultView!.getComputedStyle(content);
			const fontSize = Number.parseFloat(font.fontSize);
			const lineHeight = Number.parseFloat(font.lineHeight);
			this.editor.value = this.instantiationService.createInstance(CodeEditorWidget, {
				container: content,
				model: projection,
				readOnly: true,
				ariaLabel: this.container!.getAttribute('aria-label')!,
				presentation: 'embedded',
				contributions: [],
				lineNumbers: 'off',
				glyphMargin: false,
				lineDecorationsWidth: 0,
				wordWrap: 'off',
				fontLigatures: false,
				fontFamily: font.fontFamily || undefined,
				fontSize: Number.isFinite(fontSize) ? fontSize : undefined,
				lineHeight: Number.isFinite(lineHeight) ? lineHeight : undefined,
				scrollBeyondLastLine: false,
				minimap: { enabled: false },
			});
			this.projection.value = projection;
		} catch (error) {
			projection.dispose();
			throw error;
		}
	}

	public override clearInput(): void {
		this.editor.clear();
		this.projection.clear();
		this.model.clear();
		this.bytes = new Uint8Array();
		this.metadata = undefined;
		this.updateAriaLabel();
		if (this.summary) this.summary.textContent = '';
		if (this.content) this.content.textContent = '';
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (this.content) this.editor.value?.layout({ width: this.content.clientWidth, height: this.content.clientHeight });
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) {
			this.editor.value?.onVisible();
			this.layout(this.dimension);
		} else {
			this.editor.value?.onHide();
		}
	}

	public override getControl(): CodeEditorWidget | undefined {
		return this.editor.value;
	}

	/** Bounded projection bytes, shared only with the owning binary comparison. */
	getPreviewBytes(): Uint8Array {
		return this.bytes;
	}

	/** Compare identical byte offsets, padding the shorter side so scrolling stays aligned. */
	setComparison(other: Uint8Array, side: 'original' | 'modified'): void {
		if (!this.model.value) throw new ReferenceError('Binary comparison has not loaded');
		this.createProjection(Math.max(this.bytes.length, other.length));
		const projection = this.projection.value!;
		const editor = this.editor.value!;
		const decorations: IModelDeltaDecoration[] = [];
		let changed = 0;
		for (let offset = 0; offset < Math.max(this.bytes.length, other.length); offset += 16) {
			let start = -1;
			const flush = (end: number): void => {
				if (start < 0) return;
				const options = { description: 'binary-byte-difference', inlineClassName: `ash-binary-byte-${side}` };
				const line = offset / 16 + 1;
				decorations.push({ range: new Range(line, 11 + start * 3, line, 11 + end * 3 - 1), options });
				decorations.push({ range: new Range(line, 61 + start, line, 61 + end), options });
				start = -1;
			};
			for (let index = 0; index < 16; index++) {
				if (this.bytes[offset + index] !== other[offset + index]) {
					changed++;
					if (start < 0) start = index;
				} else flush(index);
			}
			flush(16);
		}
		projection.deltaDecorations([], decorations);
		const label = side === 'original' ? localize('binaryEditor.original', 'Original') : localize('binaryEditor.modified', 'Modified');
		this.requireSummary().textContent = localize('binaryEditor.comparisonSummary', '{0} · {1} · {2} differing bytes in preview (by offset)', label, this.metadata!, changed);
		editor.updateOptions({
			ariaLabel: localize(
				'binaryEditor.comparisonLabel',
				'{0}: {1}. {2} differing bytes by offset. Scrolling is synchronized. Missing bytes are shown as dashes.',
				label,
				this.model.value!.getName(),
				changed,
			),
		});
	}

	public override focus(): void {
		this.editor.value?.focus();
	}

	getMetadata(): string | undefined {
		return this.metadata;
	}

	private updateAriaLabel(): void {
		const model = this.model.value;
		this.container?.setAttribute('aria-label', model ? localize('binaryEditor.resourceLabel', 'Binary editor: {0}', model.getName()) : localize('binaryEditor.label', 'Binary editor'));
	}

	private requireSummary(): HTMLElement {
		if (!this.summary) throw new ReferenceError('Binary editor pane has not been created');
		return this.summary;
	}

	private requireContent(): HTMLElement {
		if (!this.content) throw new ReferenceError('Binary editor pane has not been created');
		return this.content;
	}
}

export function binaryEditorDescriptor(): IEditorPaneDescriptor {
	return {
		id: BINARY_EDITOR_ID,
		name: 'Binary Editor',
		canOpen: input => {
			if (input.initialBytes === undefined && input.resource.scheme !== 'file' && !isRemoteResource(input.resource)) return EditorPaneMatch.None;
			return input.contentType?.toLowerCase().startsWith('application/octet-stream') ? EditorPaneMatch.Default : EditorPaneMatch.Optional;
		},
		create: options => {
			if (!options.instantiationService) throw new Error('Binary editor requires Workbench instantiation services');
			return options.instantiationService.createInstance(BaseBinaryResourceEditor, 'standalone');
		},
	};
}

function renderHexDump(bytes: Uint8Array, length = bytes.length): string {
	const rows: string[] = [];
	for (let offset = 0; offset < length; offset += 16) {
		const row = bytes.subarray(offset, offset + 16);
		const address = offset.toString(16).padStart(8, '0');
		const count = Math.min(16, length - offset);
		const hex = Array.from({ length: count }, (_, index) => (row[index] === undefined ? '--' : row[index].toString(16).padStart(2, '0')))
			.join(' ')
			.padEnd(47, ' ');
		const ascii = Array.from({ length: count }, (_, index) => (row[index] === undefined ? '-' : row[index] >= 0x20 && row[index] <= 0x7e ? String.fromCharCode(row[index]) : '.')).join('');
		rows.push(`${address}  ${hex}  |${ascii}|`);
	}
	return rows.join('\n');
}

function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
