import "./links.css";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LinkService } from "../common/languageLinks.js";
import type { LanguageLink } from "../../../common/languages.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";

/** Resolves provider links on demand and delegates opening to the host callback. */
export class LinksController extends Disposable {
	private request: AbortController | undefined;
	private links: readonly LanguageLink[] | undefined;
	private activeLink: LanguageLink | undefined;
	private hoverPosition: Position | undefined;

	constructor(
		private readonly viewport: View,
		private readonly service: LinkService,
		private readonly onOpenLink: (target: string) => void | Promise<void>,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
	) {
		super();
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.update(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, "pointerleave", () => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointerdown", event => {
			if (event.button !== 0 || !this.activeLink) return;
			stopEvent(event);
			void this.open(this.activeLink.target);
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.clear()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.clear()));
		this._register(languageFeatures.linkProvider.onDidChange(() => this.clear()));
	}

	private update(event: PointerEvent): void {
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target || target.kind !== "text") {
			this.clear();
			return;
		}
		this.hoverPosition = target.position;
		this.activeLink = this.links?.find(link => link.range.containsPosition(target.position));
		this.viewport.domNode.domNode.classList.toggle("stanza-editor-link-target", this.activeLink !== undefined);
		if (this.links !== undefined || this.request) return;
		const request = this.request = new AbortController();
		void this.load(request);
	}

	private async load(request: AbortController): Promise<void> {
		try {
			const links = await this.service.provideLinks(this.viewport.textModel.getLanguageId(), request.signal);
			if (request.signal.aborted) return;
			this.links = links;
			this.activeLink = this.hoverPosition
				? this.links.find(link => link.range.containsPosition(this.hoverPosition!))
				: undefined;
			this.viewport.domNode.domNode.classList.toggle("stanza-editor-link-target", this.activeLink !== undefined);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		} finally {
			if (this.request === request) {
				this.request = undefined;
			}
		}
	}

	private async open(target: string): Promise<void> {
		try {
			await this.onOpenLink(target);
		} catch (error) {
			this.onError(error);
		}
	}

	private clear(): void {
		this.request?.abort();
		this.request = undefined;
		this.links = undefined;
		this.activeLink = undefined;
		this.hoverPosition = undefined;
		this.viewport.domNode.domNode.classList.remove("stanza-editor-link-target");
	}
}

registerEditorContribution({ id: "editor.contrib.links", install: context => {
	if (context.kind !== "text" || !context.options.onOpenLink) return;
	const service = context.register(new LinkService(context.model, context.languageFeaturesService.linkProvider, context.options.input.resource));
	return context.instantiationService.createInstance(LinksController, context.view, service, context.options.onOpenLink, context.onLanguageError);
} });
