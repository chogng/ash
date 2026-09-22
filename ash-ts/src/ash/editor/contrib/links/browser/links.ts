import "./links.css";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent, ModifierKeyEmitter, type IModifierKeyStatus } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Range } from '../../../common/core/range.js';
import { computeLinks } from '../../../common/languages/linkComputer.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../common/languages.js';
import type { LanguageLink } from "../../../common/languages.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";

/** Resolves provider links on demand and delegates opening to the host callback. */
export class LinkDetector extends Disposable {
	public static readonly ID = 'editor.linkDetector';

	private readonly modifierKeys: ModifierKeyEmitter;
	private request: AbortController | undefined;
	private links: readonly LanguageLink[] | undefined;
	private activeLink: LanguageLink | undefined;
	private hoverPosition: Position | undefined;

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onOpenLink: (target: string) => void | Promise<void>,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
	) {
		super();
		this.modifierKeys = ModifierKeyEmitter.getInstance(viewport.domNode.domNode.ownerDocument.defaultView!);
		this._register(this.modifierKeys.event(() => this.updateLinkClass()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.links) || event.hasChanged(EditorOption.multiCursorModifier)) this.clear();
		}));
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.update(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, "pointerleave", () => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointerdown", event => {
			if (event.button !== 0 || !this.editor.getOption(EditorOption.links) || !this.isTrigger(event) || event.getModifierState('AltGraph')) return;
			const target = viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
			const link = target?.kind === 'text' ? this.links?.find(link => link.range.containsPosition(target.position)) : undefined;
			if (!link) return;
			stopEvent(event);
			void this.open(link.target);
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.clear()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.clear()));
		this._register(languageFeatures.linkProvider.onDidChange(() => this.clear()));
	}

	private isTrigger(event: IModifierKeyStatus): boolean {
		return this.editor.getOption(EditorOption.multiCursorModifier) === 'altKey'
			? (isMacintosh ? event.metaKey : event.ctrlKey)
			: event.altKey;
	}

	private updateLinkClass(): void {
		this.viewport.domNode.domNode.classList.toggle('stanza-editor-link-target', this.activeLink !== undefined && this.isTrigger(this.modifierKeys.keyStatus));
	}

	private update(event: PointerEvent): void {
		if (!this.editor.getOption(EditorOption.links)) return;
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target || target.kind !== "text") {
			this.clear();
			return;
		}
		this.hoverPosition = target.position;
		this.activeLink = this.links?.find(link => link.range.containsPosition(target.position));
		this.updateLinkClass();
		if (this.links !== undefined || this.request) return;
		const request = this.request = new AbortController();
		void this.load(request);
	}

	private async load(request: AbortController): Promise<void> {
		try {
			const links = await this.provideLinks(request.signal);
			if (request.signal.aborted) return;
			this.links = links;
			this.activeLink = this.hoverPosition
				? this.links.find(link => link.range.containsPosition(this.hoverPosition!))
				: undefined;
			this.updateLinkClass();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		} finally {
			if (this.request === request) {
				this.request = undefined;
			}
		}
	}

	private async provideLinks(signal: AbortSignal): Promise<readonly LanguageLink[]> {
		const model = this.viewport.textModel;
		const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri };
		const links: LanguageLink[] = [];
		const seen = new Set<string>();
		for (const provider of this.languageFeatures.linkProvider.ordered(model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			const result = await provider.provideLinks(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			for (const link of result) {
				if (typeof link.target !== "string" || link.target.length === 0) continue;
				const key = `${model.offsetAt(link.range.getStartPosition())}:${model.offsetAt(link.range.getEndPosition())}:${link.target}`;
				if (seen.has(key)) continue;
				seen.add(key);
				links.push(Object.freeze({ range: link.range, target: link.target, ...(link.tooltip !== undefined ? { tooltip: link.tooltip } : {}) }));
			}
		}
		if (!isLanguageFeatureRequestCurrent(request) || this.isDisposed) return Object.freeze([]);
		const providerRanges = links.map(link => link.range);
		for (const link of computeLinks(model)) {
			const range = Range.lift(link.range);
			if (providerRanges.some(existing => Range.areIntersecting(existing, range))) continue;
			links.push(Object.freeze({ range, target: String(link.url) }));
		}
		return Object.freeze(links);
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

registerEditorContribution({ id: LinkDetector.ID, install: context => {
	if (context.kind !== "text" || !context.options.onOpenLink) return;
	return context.instantiationService.createInstance(LinkDetector, context.view, context.editor, context.options.onOpenLink, context.onLanguageError);
} });
