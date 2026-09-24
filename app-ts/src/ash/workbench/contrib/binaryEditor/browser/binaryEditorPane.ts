import "./media/binaryEditorPane.css";
import { h } from "../../../../base/browser/dom.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import { raceCancellationError } from "../../../../base/common/async.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { EditorPaneMatch, EditorPaneVisibility, type IEditorPane, type IEditorPaneDescriptor } from "../../../browser/parts/editor/editorPane.js";

export const BINARY_EDITOR_ID = "ash.editor.binary";
const MAX_BINARY_EDITOR_BYTES = 128 * 1024 * 1024;
const MAX_RENDERED_BYTES = 64 * 1024;

/** Read-only hexadecimal/ascii projection for resources that are not safe text. */
export class BinaryEditorPane extends Disposable implements IEditorPane {
	readonly id = BINARY_EDITOR_ID;
	private container: HTMLElement | undefined;
	private content: HTMLPreElement | undefined;
	private summary: HTMLElement | undefined;

	constructor(private readonly files: IFileService) {
		super();
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("Binary editor pane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "ash-binary-editor";
		container.tabIndex = 0;
		container.setAttribute("role", "region");
		container.setAttribute("aria-label", "Binary editor");
		const summary = h(parent.ownerDocument, "div");
		summary.className = "ash-binary-editor-summary";
		const content = h(parent.ownerDocument, "pre");
		content.className = "ash-binary-editor-content";
		container.append(summary, content);
		parent.append(container);
		this.container = container;
		this.summary = summary;
		this.content = content;
		this._register(toDisposable(() => container.remove()));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		const summary = this.requireSummary();
		const content = this.requireContent();
		throwIfCancelled(signal, "Binary editor loading was cancelled");
		const stat = await raceCancellationError(this.files.stat(input.resource), signal, "Binary editor loading was cancelled");
		if (stat.sizeBytes > MAX_BINARY_EDITOR_BYTES) {
			throw new Error(`Binary file is too large to preview (${formatByteCount(stat.sizeBytes)})`);
		}
		const resolved = await raceCancellationError(this.files.readFileBytes(input.resource), signal, "Binary editor loading was cancelled");
		throwIfCancelled(signal, "Binary editor loading was cancelled");
		const visible = resolved.bytes.subarray(0, MAX_RENDERED_BYTES);
		summary.textContent = `${formatByteCount(resolved.bytes.length)} · read-only hexadecimal preview${resolved.bytes.length > visible.length ? ` · first ${formatByteCount(visible.length)}` : ""}`;
		content.textContent = renderHexDump(visible);
	}

	clearInput(): void {
		if (this.summary) this.summary.textContent = "";
		if (this.content) this.content.textContent = "";
	}

	layout(_dimension: IDimension): void {}

	setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) this.container.hidden = visibility === EditorPaneVisibility.Hidden;
	}

	focus(): void { this.container?.focus(); }

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
			if (!options.fileService) throw new Error("Binary editor requires the Workbench file service");
			return new BinaryEditorPane(options.fileService);
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
