import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Selection } from "../../../common/core/selection.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { PeekViewWidget } from "../../peekView/browser/peekView.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { Range } from '../../../common/core/range.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageLocation, type LanguageHierarchyItem, type LanguageHierarchyRequest, type LanguageCallHierarchyEntry, type LanguageCallHierarchyProvider, type LanguageTypeHierarchyProvider } from '../../../common/languages.js';

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
		private readonly resource: URI,
		private readonly openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Language hierarchy dependencies must share one text model');
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.closePeek()));
		this._register(toDisposable(() => this.closePeek()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.closePeek()));
		this._register(viewport.textModel.onWillDispose(() => this.closePeek()));
		this._register(editor.onDidChangeCursorSelection(() => this.closePeek()));
		this._register(editor.onDidBlurEditorWidget(() => this.closePeek()));
		this._register(languageFeatures.callHierarchyProvider.onDidChange(() => this.closePeek()));
		this._register(languageFeatures.typeHierarchyProvider.onDidChange(() => this.closePeek()));
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
		this.closePeek();
		const request = this.request = new AbortController();
		const anchor = this.editor.getSelections()![0]!.getPosition();
		try {
			const sessions = kind === "call"
				? (await this.prepareCallHierarchy(anchor, request.signal)).map(callSession)
				: (await this.prepareTypeHierarchy(anchor, request.signal)).map(typeSession);
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
		this.peek.clear();
		const widget = this.peek.add(new PeekViewWidget(this.editor));
		widget.setTitle(`${sessions[0]!.kind === "call" ? "Call" : "Type"} Hierarchy`);
		this.peek.add(widget.onDidClose(() => this.closePeek()));
		const body = h(widget.element.ownerDocument, "div");
		body.className = "stanza-editor-language-hierarchy";
		widget.setBody(body);
		for (const session of sessions) for (const root of session.roots) body.append(this.createNode(widget, session, root, [], defaultDirection(session.kind)));
		widget.show(anchor);
		(body.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
	}

	private createNode(widget: PeekViewWidget, session: HierarchySession, item: LanguageHierarchyItem, ancestors: readonly LanguageHierarchyItem[], direction: HierarchyDirection, owner: DisposableStore = this.peek): HTMLElement {
		const resources = owner.add(new DisposableStore());
		const children = resources.add(new MutableDisposable<DisposableStore>());
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
		resources.add(addDisposableListener(open, "click", () => void this.open(item)));
		resources.add(addDisposableListener(expand, "click", () => void this.expand(node, widget, session, item, ancestors, direction, expand, children)));
		if (ancestors.some(ancestor => hierarchyIdentity(ancestor) === hierarchyIdentity(item))) expand.disabled = true;
		if (session.kind === "call" || session.kind === "type") {
			const alternate = h(document, "button");
			alternate.type = "button";
			alternate.className = "stanza-editor-language-hierarchy-expand";
			const alternateDirection = oppositeDirection(direction);
			alternate.textContent = directionLabel(alternateDirection);
			alternate.setAttribute("aria-label", `${directionLabel(alternateDirection)} for ${item.name}`);
			resources.add(addDisposableListener(alternate, "click", () => void this.expand(node, widget, session, item, ancestors, alternateDirection, alternate, children)));
			row.append(alternate);
		}
		return node;
	}

	private async expand(node: HTMLElement, widget: PeekViewWidget, session: HierarchySession, item: LanguageHierarchyItem, ancestors: readonly LanguageHierarchyItem[], direction: HierarchyDirection, button: HTMLButtonElement, childrenResources: MutableDisposable<DisposableStore>): Promise<void> {
		if (button.getAttribute('aria-disabled') === 'true') return;
		const resources = new DisposableStore();
		childrenResources.value = resources;
		const request = this.request;
		button.setAttribute('aria-disabled', 'true');
		try {
			const items = await session.query(item, direction);
			if (!request || request.signal.aborted || this.request !== request || childrenResources.value !== resources || !node.isConnected) {
				return;
			}
			const existing = node.querySelector(":scope > .stanza-editor-language-hierarchy-children");
			existing?.remove();
			const children = h(widget.element.ownerDocument, "div");
			children.className = "stanza-editor-language-hierarchy-children";
			if (items.length === 0) {
				children.textContent = `No ${directionLabel(direction).toLowerCase()}.`;
			} else {
				for (const child of items) children.append(this.createNode(widget, session, child, [...ancestors, item], direction, resources));
			}
			node.append(children);
		} catch (error) {
			if (request && !request.signal.aborted) this.onError(error);
		} finally {
			button.removeAttribute('aria-disabled');
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

	private async prepareCallHierarchy(position: Position, signal: AbortSignal): Promise<readonly PreparedCallHierarchy[]> {
		const request = { ...createLanguageFeatureRequest(this.viewport.textModel, this.viewport.textModel.getLanguageId(), signal), resource: this.resource, position };
		const prepared: PreparedCallHierarchy[] = [];
		for (const provider of this.languageFeatures.callHierarchyProvider.ordered(this.viewport.textModel)) {
			if (!isLanguageFeatureRequestCurrent(request)) return [];
			let roots: readonly LanguageHierarchyItem[];
			try {
				const values = await provider.prepareCallHierarchy(request, signal);
				if (!isLanguageFeatureRequestCurrent(request)) return [];
				roots = normalizeItems(values);
			} catch (error) {
				if (!signal.aborted) this.onError(error);
				continue;
			}
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (roots.length === 0) continue;
			prepared.push(Object.freeze({
				roots,
				incoming: (item: LanguageHierarchyItem) => this.followCall(provider, request, item, "incoming"),
				outgoing: (item: LanguageHierarchyItem) => this.followCall(provider, request, item, "outgoing"),
			}));
		}
		return Object.freeze(prepared);
	}

	private async prepareTypeHierarchy(position: Position, signal: AbortSignal): Promise<readonly PreparedTypeHierarchy[]> {
		const request = { ...createLanguageFeatureRequest(this.viewport.textModel, this.viewport.textModel.getLanguageId(), signal), resource: this.resource, position };
		const prepared: PreparedTypeHierarchy[] = [];
		for (const provider of this.languageFeatures.typeHierarchyProvider.ordered(this.viewport.textModel)) {
			if (!isLanguageFeatureRequestCurrent(request)) return [];
			let roots: readonly LanguageHierarchyItem[];
			try {
				const values = await provider.prepareTypeHierarchy(request, signal);
				if (!isLanguageFeatureRequestCurrent(request)) return [];
				roots = normalizeItems(values);
			} catch (error) {
				if (!signal.aborted) this.onError(error);
				continue;
			}
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (roots.length === 0) continue;
			prepared.push(Object.freeze({
				roots,
				supertypes: (item: LanguageHierarchyItem) => this.followType(provider, request, item, "supertypes"),
				subtypes: (item: LanguageHierarchyItem) => this.followType(provider, request, item, "subtypes"),
			}));
		}
		return Object.freeze(prepared);
	}

	private async followCall(provider: LanguageCallHierarchyProvider, prepared: LanguageHierarchyRequest, item: LanguageHierarchyItem, direction: "incoming" | "outgoing"): Promise<readonly LanguageCallHierarchyEntry[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(prepared)) return Object.freeze([]);
		const request = { ...prepared, item };
		const signal = request.signal;
		const entries = direction === "incoming" ? await provider.provideIncomingCalls(request, signal) : await provider.provideOutgoingCalls(request, signal);
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		return Object.freeze(entries.map(entry => Object.freeze({ item: normalizeItem(entry.item), ...(entry.fromResource ? { fromResource: entry.fromResource } : {}), fromRanges: Object.freeze(entry.fromRanges.map(normalizeRange)) })));
	}

	private async followType(provider: LanguageTypeHierarchyProvider, prepared: LanguageHierarchyRequest, item: LanguageHierarchyItem, direction: "supertypes" | "subtypes"): Promise<readonly LanguageHierarchyItem[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(prepared)) return Object.freeze([]);
		const request = { ...prepared, item };
		const signal = request.signal;
		const items = direction === "supertypes" ? await provider.provideSupertypes(request, signal) : await provider.provideSubtypes(request, signal);
		return isLanguageFeatureRequestCurrent(request) ? normalizeItems(items) : Object.freeze([]);
	}

	private closePeek(): void { this.cancelRequest(); this.peek.clear(); }
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

interface PreparedCallHierarchy {
	readonly roots: readonly LanguageHierarchyItem[];
	incoming(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]>;
	outgoing(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]>;
}

interface PreparedTypeHierarchy {
	readonly roots: readonly LanguageHierarchyItem[];
	supertypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]>;
	subtypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]>;
}

function normalizeItems(items: readonly LanguageHierarchyItem[]): readonly LanguageHierarchyItem[] { return Object.freeze(items.map(normalizeItem)); }
function normalizeRange(range: Range): Range { return Range.fromPositions(range.getStartPosition(), range.getEndPosition()); }
function normalizeItem(item: LanguageHierarchyItem): LanguageHierarchyItem {
	const range = normalizeRange(item.range);
	const selectionRange = normalizeRange(item.selectionRange);
	if (!range.containsRange(selectionRange)) throw new RangeError("Hierarchy selection range must be contained by its symbol range");
	return Object.freeze({ name: item.name, symbolKind: item.symbolKind, ...(item.detail ? { detail: item.detail } : {}), resource: item.resource, range, selectionRange, ...(item.data === undefined ? {} : { data: item.data }) });
}
