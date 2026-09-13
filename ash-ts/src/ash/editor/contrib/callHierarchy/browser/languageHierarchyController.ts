import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Selection } from "../../../common/core/selection.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type LanguageLocation } from "../../../common/languages.js";
import { EditorPeekViewWidget } from "../../peekView/browser/editorPeekViewWidget.js";
import { type LanguageHierarchyItem, type LanguageHierarchyService, type PreparedCallHierarchy, type PreparedTypeHierarchy } from "../common/languageHierarchy.js";

type HierarchyKind = "call" | "type";
type HierarchyDirection = "incoming" | "outgoing" | "supertypes" | "subtypes";

interface HierarchySession {
	readonly kind: HierarchyKind;
	readonly roots: readonly LanguageHierarchyItem[];
	readonly query: (item: LanguageHierarchyItem, direction: HierarchyDirection) => Promise<readonly LanguageHierarchyItem[]>;
}

/** Owns user-visible Call Hierarchy and Type Hierarchy Peek sessions for one editor. */
export class LanguageHierarchyController extends Disposable {
	private readonly peek = this._register(new DisposableStore());
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly service: LanguageHierarchyService,
		private readonly resource: URI,
		private readonly languageId: string,
		private readonly openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void = error => console.error("Editor language hierarchy failed", error),
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Language hierarchy dependencies must share one text model');
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.closePeek()));
		this._register(toDisposable(() => this.cancelRequest()));
	}

	showCallHierarchy(): Promise<void> { return this.prepare("call"); }
	showTypeHierarchy(): Promise<void> { return this.prepare("type"); }

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph") || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
		const key = event.key.toLowerCase();
		if (key !== "h" && key !== "t") return;
		stopEvent(event);
		void this.prepare(key === "h" ? "call" : "type");
	}

	private async prepare(kind: HierarchyKind): Promise<void> {
		this.cancelRequest();
		const request = this.request = new AbortController();
		const anchor = this.editor.getSelections()![0]!.getPosition();
		try {
			const sessions = kind === "call"
				? (await this.service.prepareCallHierarchy(this.languageId, anchor, request.signal)).map(callSession)
				: (await this.service.prepareTypeHierarchy(this.languageId, anchor, request.signal)).map(typeSession);
			if (request.signal.aborted) return;
			if (sessions.length === 0) {
				this.viewport.announceAccessibilityStatus(`No ${kind} hierarchy found.`);
				return;
			}
			this.showSessions(anchor, sessions);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private showSessions(anchor: Position, sessions: readonly HierarchySession[]): void {
		this.closePeek();
		const widget = this.peek.add(new EditorPeekViewWidget(this.editor, anchor, `${sessions[0]!.kind === "call" ? "Call" : "Type"} Hierarchy`));
		const body = h(widget.element.ownerDocument, "div");
		body.className = "stanza-editor-language-hierarchy";
		widget.setBody(body);
		for (const session of sessions) for (const root of session.roots) body.append(this.createNode(widget, session, root, [], defaultDirection(session.kind)));
		widget.show();
		(body.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
		this.peek.add(addDisposableListener(widget.element, "keydown", event => {
			if (event.key !== "Escape") return;
			stopEvent(event);
			this.closePeek();
			this.input.focus({ preventScroll: true });
		}));
	}

	private createNode(widget: EditorPeekViewWidget, session: HierarchySession, item: LanguageHierarchyItem, ancestors: readonly LanguageHierarchyItem[], direction: HierarchyDirection): HTMLElement {
		const document = widget.element.ownerDocument;
		const node = h(document, "section");
		node.className = "stanza-editor-language-hierarchy-node";
		const row = h(document, "div");
		row.className = "stanza-editor-language-hierarchy-row";
		const open = h(document, "button");
		open.type = "button";
		open.className = "stanza-editor-language-hierarchy-item";
		open.textContent = item.detail ? `${item.name} — ${item.detail}` : item.name;
		open.title = resourceLabel(item.resource);
		const expand = h(document, "button");
		expand.type = "button";
		expand.className = "stanza-editor-language-hierarchy-expand";
		expand.textContent = directionLabel(direction);
		expand.setAttribute("aria-label", `${directionLabel(direction)} for ${item.name}`);
		row.append(open, expand);
		node.append(row);
		this.peek.add(addDisposableListener(open, "click", () => void this.open(item)));
		this.peek.add(addDisposableListener(expand, "click", () => void this.expand(node, widget, session, item, ancestors, direction, expand)));
		if (ancestors.some(ancestor => hierarchyIdentity(ancestor) === hierarchyIdentity(item))) expand.disabled = true;
		if (session.kind === "call" || session.kind === "type") {
			const alternate = h(document, "button");
			alternate.type = "button";
			alternate.className = "stanza-editor-language-hierarchy-expand";
			const alternateDirection = oppositeDirection(direction);
			alternate.textContent = directionLabel(alternateDirection);
			alternate.setAttribute("aria-label", `${directionLabel(alternateDirection)} for ${item.name}`);
			this.peek.add(addDisposableListener(alternate, "click", () => void this.expand(node, widget, session, item, ancestors, alternateDirection, alternate)));
			row.append(alternate);
		}
		return node;
	}

	private async expand(node: HTMLElement, widget: EditorPeekViewWidget, session: HierarchySession, item: LanguageHierarchyItem, ancestors: readonly LanguageHierarchyItem[], direction: HierarchyDirection, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			const items = await session.query(item, direction);
			const existing = node.querySelector(":scope > .stanza-editor-language-hierarchy-children");
			existing?.remove();
			const children = h(widget.element.ownerDocument, "div");
			children.className = "stanza-editor-language-hierarchy-children";
			if (items.length === 0) {
				children.textContent = `No ${directionLabel(direction).toLowerCase()}.`;
			} else {
				for (const child of items) children.append(this.createNode(widget, session, child, [...ancestors, item], direction));
			}
			node.append(children);
		} catch (error) {
			this.onError(error);
		} finally {
			button.disabled = false;
		}
	}

	private async open(item: LanguageHierarchyItem): Promise<void> {
		const location = { resource: item.resource, range: item.range, selectionRange: item.selectionRange };
		if (item.resource.toString() === this.resource.toString()) {
			this.editor.setSelections([
				Selection.fromPositions(item.selectionRange.getStartPosition(), item.selectionRange.getEndPosition()),
			], 'editor.showHierarchy');
			this.viewport.revealPosition(item.selectionRange.getStartPosition());
			this.input.focus({ preventScroll: true });
			return;
		}
		await this.openLocation?.(location);
	}

	private closePeek(): void { this.peek.clear(); }
	private cancelRequest(): void { this.request?.abort(); this.request = undefined; }
}

function callSession(prepared: PreparedCallHierarchy): HierarchySession {
	return { kind: "call", roots: prepared.roots, query: async (item, direction) => {
		const entries = direction === "outgoing" ? await prepared.outgoing(item) : await prepared.incoming(item);
		return entries.map(entry => entry.item);
	} };
}

function typeSession(prepared: PreparedTypeHierarchy): HierarchySession {
	return { kind: "type", roots: prepared.roots, query: (item, direction) => direction === "supertypes" ? prepared.supertypes(item) : prepared.subtypes(item) };
}

function defaultDirection(kind: HierarchyKind): HierarchyDirection { return kind === "call" ? "incoming" : "subtypes"; }
function oppositeDirection(direction: HierarchyDirection): HierarchyDirection {
	switch (direction) {
		case "incoming": return "outgoing";
		case "outgoing": return "incoming";
		case "supertypes": return "subtypes";
		case "subtypes": return "supertypes";
	}
}
function directionLabel(direction: HierarchyDirection): string {
	switch (direction) {
		case "incoming": return "Callers";
		case "outgoing": return "Callees";
		case "supertypes": return "Supertypes";
		case "subtypes": return "Subtypes";
	}
}
function hierarchyIdentity(item: LanguageHierarchyItem): string { return `${item.resource.toString()}\0${item.selectionRange.getStartPosition().lineNumber}:${item.selectionRange.getStartPosition().column}`; }
function resourceLabel(resource: URI): string { const path = decodeURIComponent(resource.path); return path.slice(path.lastIndexOf("/") + 1) || resource.toString(); }
