import type { LanguageHover } from '../../../common/languages.js';
import "./hover.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type LanguageHoverService } from "../common/hover.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";

/** Projects provider-backed hover content into an editor-local, non-modal widget. */
export class HoverController extends Disposable {
	private readonly element: HTMLDivElement;
	private request: AbortController | undefined;
	private readonly timer = this._register(new MutableDisposable<IDisposable>());

	constructor(private readonly viewport: View, private readonly service: LanguageHoverService, private readonly languageId: string) {
		super();
		this.element = h(viewport.domNode.domNode.ownerDocument, "div");
		this.element.className = "stanza-editor-hover";
		this.element.hidden = true;
		this.element.setAttribute("role", "tooltip");
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => { this.cancelRequest(); this.element.remove(); }));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.schedule(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, "pointerleave", () => this.hide()));
		this._register(addDisposableListener(viewport.domNode.domNode, "scroll", () => this.hide()));
		this._register(viewport.textModel.onDidChangeContent(() => this.hide()));
	}

	private schedule(event: PointerEvent): void {
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target || target.kind !== "text") {
			this.hide();
			return;
		}
		this.cancelRequest();
		this.timer.clear();
		const targetWindow = this.element.ownerDocument.defaultView;
		if (!targetWindow) return;
		this.timer.value = disposableWindowTimeout(targetWindow, () => {
			this.timer.clear();
			void this.show(target.position);
		}, 300);
	}

	private async show(position: Position): Promise<void> {
		const request = this.request = new AbortController();
		try {
			const hover = await this.service.provideHover(this.languageId, position, request.signal);
			if (request.signal.aborted || !hover) return;
			this.render(hover, position);
		} catch {
			if (!request.signal.aborted) this.hide();
		}
	}

	private render(hover: LanguageHover, position: Position): void {
		this.element.replaceChildren(...hover.contents.map(content => {
			const node = h(this.element.ownerDocument, "div");
			node.className = "stanza-editor-hover-content";
			node.textContent = typeof content === "string" ? content : content.value;
			return node;
		}));
		const coordinates = this.viewport.getPositionContentCoordinates(hover.range?.getStartPosition() ?? position);
		const bounds = this.viewport.domNode.domNode.getBoundingClientRect();
		const width = Math.min(480, Math.max(160, bounds.width - 16));
		this.element.style.maxWidth = `${width}px`;
		this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
		this.element.hidden = false;
	}

	private hide(): void {
		this.cancelRequest();
		this.timer.clear();
		this.element.hidden = true;
		this.element.replaceChildren();
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}
