import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import type { IEditorPaneDescriptor } from '../../editor.js';
import { h } from "../../../../base/browser/dom.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import { raceCancellationError } from "../../../../base/common/async.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { basename } from '../../../../base/common/resources.js';
import { IFileService } from "../../../../platform/files/common/files.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { BinaryEditorModel } from '../../../common/editor/binaryEditorModel.js';
import { localize } from '../../../../nls.js';
import { EditorPaneMatch, EditorPane } from './editorPane.js';

export const BINARY_EDITOR_ID = "ash.editor.binary";
const MAX_BINARY_EDITOR_BYTES = 128 * 1024 * 1024;
const MAX_RENDERED_BYTES = 64 * 1024;

/** Read-only hexadecimal/ascii projection for resources that are not safe text. */
export class BaseBinaryResourceEditor extends EditorPane implements IEditorPane {
	readonly id = BINARY_EDITOR_ID;
	protected container: HTMLElement | undefined;
	private content: HTMLPreElement | undefined;
	private summary: HTMLElement | undefined;
	private metadata: string | undefined;
	private readonly model = this._register(new MutableDisposable<BinaryEditorModel>());

	constructor(
		@IFileService protected readonly files: IFileService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("Binary editor pane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "ash-binary-editor";
		container.tabIndex = 0;
		container.setAttribute("role", "region");
		const summary = h(parent.ownerDocument, "div");
		summary.className = "ash-binary-editor-summary";
		const content = h(parent.ownerDocument, "pre");
		content.className = "ash-binary-editor-content";
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
		const content = this.requireContent();
		throwIfCancelled(signal, "Binary editor loading was cancelled");
		const model = this.instantiationService.createInstance(BinaryEditorModel, input.resource, input.label ?? basename(input.resource));
		try {
			await raceCancellationError(model.resolve(), signal, "Binary editor loading was cancelled");
			const size = model.getSize();
			if (size !== undefined && size > MAX_BINARY_EDITOR_BYTES) {
				throw new Error(`Binary file is too large to preview (${formatByteCount(size)})`);
			}
			const resolved = await raceCancellationError(this.files.readFileBytes(input.resource), signal, "Binary editor loading was cancelled");
			throwIfCancelled(signal, "Binary editor loading was cancelled");
			const visible = resolved.bytes.subarray(0, MAX_RENDERED_BYTES);
			this.model.value = model;
			this.metadata = formatByteCount(resolved.bytes.length);
			this.updateAriaLabel();
			summary.textContent = `${formatByteCount(resolved.bytes.length)} · read-only hexadecimal preview${resolved.bytes.length > visible.length ? ` · first ${formatByteCount(visible.length)}` : ""}`;
			content.textContent = renderHexDump(visible);
		} catch (error) {
			model.dispose();
			throw error;
		}
	}

	public override clearInput(): void {
		this.model.clear();
		this.metadata = undefined;
		this.updateAriaLabel();
		if (this.summary) this.summary.textContent = "";
		if (this.content) this.content.textContent = "";
	}

	public override layout(_dimension: IDimension): void { }

	public override focus(): void { this.container?.focus(); }

	getMetadata(): string | undefined { return this.metadata; }

	private updateAriaLabel(): void {
		const model = this.model.value;
		this.container?.setAttribute('aria-label', model
			? localize('binaryEditor.resourceLabel', 'Binary editor: {0}', model.getName())
			: localize('binaryEditor.label', 'Binary editor'));
	}

	private requireSummary(): HTMLElement {
		if (!this.summary) throw new ReferenceError("Binary editor pane has not been created");
		return this.summary;
	}

	private requireContent(): HTMLPreElement {
		if (!this.content) throw new ReferenceError("Binary editor pane has not been created");
		return this.content;
	}
}

export function binaryEditorDescriptor(): IEditorPaneDescriptor {
	return {
		id: BINARY_EDITOR_ID,
		name: "Binary Editor",
		canOpen: input => {
			if (input.resource.scheme !== "file" && !isRemoteResource(input.resource)) return EditorPaneMatch.None;
			return input.contentType?.toLowerCase().startsWith("application/octet-stream") ? EditorPaneMatch.Default : EditorPaneMatch.Optional;
		},
		create: options => {
			if (!options.instantiationService) throw new Error("Binary editor requires Workbench instantiation services");
			return options.instantiationService.createInstance(BaseBinaryResourceEditor);
		},
	};
}

function renderHexDump(bytes: Uint8Array): string {
	const rows: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const row = bytes.subarray(offset, offset + 16);
		const address = offset.toString(16).padStart(8, "0");
		const hex = [...row].map(byte => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
		const ascii = [...row].map(byte => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".").join("");
		rows.push(`${address}  ${hex}  |${ascii}|`);
	}
	return rows.join("\n");
}

function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
