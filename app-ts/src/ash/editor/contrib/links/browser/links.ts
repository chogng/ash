import "./links.css";
import { EditorAction, registerEditorAction, registerEditorContribution, type ServicesAccessor } from "../../../browser/editorExtensions.js";
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
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { localize2 } from '../../../../nls.js';
import { ILanguageFeatureDebounceService, type IFeatureDebounceInformation } from '../../../common/services/languageFeatureDebounce.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';

/** Resolves document links and opens them through the editor's service scope. */
export class LinkDetector extends Disposable {
	public static readonly ID = 'editor.linkDetector';

	public static get(editor: ICodeEditor): LinkDetector | null {
		return editor.getContribution<LinkDetector>(LinkDetector.ID);
	}

	private readonly modifierKeys: ModifierKeyEmitter;
	private readonly recompute: RunOnceScheduler;
	private readonly debounceInformation: IFeatureDebounceInformation;
	private request: AbortController | undefined;
	private links: readonly LanguageLink[] | undefined;
	private activeLink: LanguageLink | undefined;
	private hoverPosition: Position | undefined;

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILanguageFeatureDebounceService languageFeatureDebounceService: ILanguageFeatureDebounceService,
	) {
		super();
		this.debounceInformation = languageFeatureDebounceService.for(languageFeatures.linkProvider, 'Links');
		this.recompute = this._register(new RunOnceScheduler(() => this.computeLinksNow(), 0));
		this.modifierKeys = ModifierKeyEmitter.getInstance(viewport.domNode.domNode.ownerDocument.defaultView!);
		this._register(this.modifierKeys.event(() => this.updateLinkClass()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.links) || event.hasChanged(EditorOption.multiCursorModifier)) this.invalidate();
		}));
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.update(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, "pointerleave", () => this.clearHover()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointerdown", event => {
			if (event.button !== 0 || !this.editor.getOption(EditorOption.links) || !this.isTrigger(event) || event.getModifierState('AltGraph')) return;
			const target = viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
			const link = target?.kind === 'text' ? this.links?.find(link => link.range.containsPosition(target.position)) : undefined;
			if (!link) return;
			stopEvent(event);
			const openToSide = this.editor.getOption(EditorOption.multiCursorModifier) === 'altKey'
				? event.altKey
				: (isMacintosh ? event.metaKey : event.ctrlKey);
			this.openLinkOccurrence(link, openToSide, true);
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.invalidate(this.debounceInformation.get(viewport.textModel))));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.invalidate()));
		this._register(languageFeatures.linkProvider.onDidChange(() => this.invalidate()));
		// Keyboard opening needs the same provider results without a preceding pointer hover.
		this.recompute.schedule();
	}

	public getLinkOccurrence(position: Position | null): LanguageLink | null {
		if (!position || !this.editor.getOption(EditorOption.links)) return null;
		return this.links?.find(link => link.range.containsPosition(position)) ?? null;
	}

	public openLinkOccurrence(occurrence: LanguageLink, openToSide: boolean, fromUserGesture = false): void {
		void this.openerService.open(occurrence.target, {
			openToSide,
			fromUserGesture,
			allowContributedOpeners: true,
		}).catch(this.onError);
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
			this.clearHover();
			return;
		}
		this.hoverPosition = target.position;
		this.activeLink = this.links?.find(link => link.range.containsPosition(target.position));
		this.updateLinkClass();
		this.computeLinksNow();
	}

	private computeLinksNow(): void {
		if (!this.editor.getOption(EditorOption.links) || this.links !== undefined || this.request) return;
		const request = this.request = new AbortController();
		void this.load(request);
	}

	private async load(request: AbortController): Promise<void> {
		try {
			const stopwatch = new StopWatch(false);
			const links = await this.provideLinks(request.signal);
			if (request.signal.aborted) return;
			this.debounceInformation.update(this.viewport.textModel, stopwatch.elapsed());
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

	private invalidate(delay = 0): void {
		this.clear();
		this.recompute.schedule(delay);
	}

	private clearHover(): void {
		this.activeLink = undefined;
		this.hoverPosition = undefined;
		this.viewport.domNode.domNode.classList.remove("stanza-editor-link-target");
	}

	private clear(): void {
		this.recompute.cancel();
		this.request?.abort();
		this.request = undefined;
		this.links = undefined;
		this.clearHover();
	}
}

class OpenLinkAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.openLink',
			label: localize2({ bundle: 'ash', key: 'editor.openLink' }, 'Open Link'),
			precondition: undefined,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const detector = LinkDetector.get(editor);
		if (!detector) return;
		for (const selection of editor.getSelections() ?? []) {
			const link = detector.getLinkOccurrence(selection.getEndPosition());
			if (link) detector.openLinkOccurrence(link, false, true);
		}
	}
}

registerEditorContribution({ id: LinkDetector.ID, install: context => {
	if (context.kind !== "text") return;
	return context.instantiationService.createInstance(LinkDetector, context.view, context.editor, context.onLanguageError);
} });
registerEditorAction(OpenLinkAction);
