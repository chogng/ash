import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { operatingSystem, OperatingSystem } from "../../../../base/common/platform.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor, type IEditorMouseEvent, MouseTargetType } from '../../../browser/editorBrowser.js';
import { EditorFoldingModel } from "./foldingModel.js";
import { EditorFoldingRangeSource, type EditorFoldingRegion } from "./foldingRanges.js";
import { Position } from "../../../common/core/position.js";
import { Selection } from "../../../common/core/selection.js";
import { type View } from "../../../browser/view.js";
import { type ILanguageConfigurationService } from "../../../common/languages/languageConfigurationRegistry.js";
import { type ILanguageFeaturesService } from "../../../common/services/languageFeatures.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { EditorHiddenRangeModel } from "./hiddenRangeModel.js";
import { computeEditorIndentFoldingRanges } from "./indentRangeProvider.js";
import { computeEditorLanguageFoldingRanges, mergeEditorFoldingRanges } from "./syntaxRangeProvider.js";
import { FoldingRangeService } from "../common/languageFoldingRanges.js";
import { FoldingDecorationProvider } from './foldingDecorations.js';
import type { IDecorationProvider } from './foldingModel.js';
import { Range } from '../../../common/core/range.js';
import './folding.css';

registerEditorContribution({
	id: "editor.contrib.folding",
	configure: context => {
		const folding = context.register(new EditorFoldingModel(context.model));
		const hidden = context.register(new EditorHiddenRangeModel(context.model, folding));
		context.provideService(TextEditorCapability.folding, folding);
		const syncHiddenAreas = (): void => context.viewModel.setHiddenAreas(hidden.hiddenRanges);
		syncHiddenAreas();
		context.register(hidden.onDidChange(syncHiddenAreas));
		if (context.options.folding === false || context.model.largeFile.tooLargeForTokenization) return;
		const service = context.register(new FoldingRangeService(context.model, context.languageFeaturesService.foldingRangeProvider, context.options.input.resource));
		context.register(new FoldingRangeSource(folding, service, {
			configurations: context.configurations,
			providers: context.languageFeaturesService.foldingRangeProvider,
			tabSize: context.options.indentation?.tabSize,
			onError: context.onLanguageError,
		}));
	},
	install: context => {
		if (context.kind !== "text" || context.options.folding === false || context.model.largeFile.tooLargeForTokenization) return;
		const decorations = new FoldingDecorationProvider(context.editor);
		decorations.showFoldingControls = context.options.showFoldingControls ?? 'mouseover';
		decorations.showFoldingHighlights = context.options.foldingHighlight ?? true;
		context.register(new FoldingDecorationPresenter(context.getService(TextEditorCapability.folding), decorations));
		return new FoldingController(context.editor, context.view, context.getService(TextEditorCapability.folding));
	},
});

class FoldingDecorationPresenter extends Disposable {
	private decorationIds: string[] = [];

	constructor(private readonly folding: EditorFoldingModel, private readonly decorations: IDecorationProvider) {
		super();
		this._register(folding.onDidChange(() => this.refresh()));
		this._register(toDisposable(() => decorations.removeDecorations(this.decorationIds)));
		this.refresh();
	}

	private refresh(): void {
		let hiddenThrough = -1;
		const next = this.folding.regions.map(region => {
			const startLineNumber = region.startLineIndex + 1;
			const endLineNumber = region.endLineIndex + 1;
			const hidden = region.endLineIndex <= hiddenThrough;
			if (region.collapsed && region.endLineIndex > hiddenThrough) hiddenThrough = region.endLineIndex;
			return {
				range: new Range(
					startLineNumber,
					this.folding.model.getLineMaxColumn(startLineNumber),
					endLineNumber,
					this.folding.model.getLineMaxColumn(endLineNumber),
				),
				options: this.decorations.getDecorationOption(
					region.collapsed,
					hidden,
					region.source === EditorFoldingRangeSource.Manual,
				),
			};
		});
		this.decorations.changeDecorations(accessor => {
			this.decorationIds = accessor.deltaDecorations(this.decorationIds, next);
		});
	}
}

class FoldingRangeSource extends Disposable {
	private request: AbortController | undefined;

	constructor(
		private readonly folding: EditorFoldingModel,
		private readonly service: FoldingRangeService,
		private readonly options: {
			readonly configurations: ILanguageConfigurationService;
			readonly providers: ILanguageFeaturesService['foldingRangeProvider'];
			readonly tabSize?: number;
			readonly onError: (error: unknown) => void;
		},
	) {
		super();
		this._register(folding.model.onDidChangeContent(() => this.refresh()));
		this._register(folding.model.onDidChangeLanguage(() => this.refresh()));
		this._register(folding.model.onDidChangeTokens(() => this.refresh()));
		this._register(options.configurations.onDidChange(() => this.refresh()));
		this._register(options.providers.onDidChange(() => this.refresh()));
		this._register(toDisposable(() => this.request?.abort()));
		this.refresh();
	}

	private refresh(): void {
		this.request?.abort();
		const local = mergeEditorFoldingRanges(
			computeEditorLanguageFoldingRanges(this.folding.model, this.folding.model.getLanguageId(), this.options.configurations),
			computeEditorIndentFoldingRanges(this.folding.model, { tabSize: this.options.tabSize }),
		);
		this.folding.setProviderRanges(local);
		if (!this.options.providers.has(this.folding.model)) return;
		const request = this.request = new AbortController();
		void this.service.provideFoldingRanges(this.folding.model.getLanguageId(), request.signal).then(ranges => {
			if (request.signal.aborted || this.request !== request) return;
			this.folding.setProviderRanges(mergeEditorFoldingRanges(local, ranges));
		}, error => {
			if (!request.signal.aborted) this.options.onError(error);
		});
	}
}

export enum FoldingCommand {
	Collapse = "collapse",
	Expand = "expand",
	CollapseRecursively = "collapseRecursively",
	ExpandRecursively = "expandRecursively",
	CreateManualRange = "createManualRange",
	RemoveManualRange = "removeManualRange",
	CollapseToLevel = "collapseToLevel",
	CollapseAll = "collapseAll",
	ExpandAll = "expandAll",
}

export interface FoldingControllerOptions {
	readonly operatingSystem?: OperatingSystem;
}

/** Routes local VS Code fold chords and gutter controls through Stanza's folding model. */
export class FoldingController extends Disposable {
	private readonly targetOperatingSystem: OperatingSystem;
	private readonly viewport: View;
	private readonly editor: ICodeEditor;
	private readonly folding: EditorFoldingModel;
	private awaitingChord = false;

	constructor(
		editor: ICodeEditor,
		viewport: View,
		folding: EditorFoldingModel,
		options: FoldingControllerOptions = {},
	) {
		super();
		this.viewport = viewport;
		this.editor = editor;
		this.folding = folding;
		try {
			this.targetOperatingSystem = readOperatingSystem(options.operatingSystem);
			if (this.viewport.textModel !== this.editor.getModel() || this.viewport.textModel !== this.folding.model) {
				throw new TypeError("Stanza folding dependencies must share one text model");
			}
			if (folding.model.largeFile.tooLargeForTokenization) return;
			this._register(addDisposableListener(viewport.domNode.domNode, "keydown", event => this.handleKeydown(event)));
			this._register(this.editor.onMouseDown(event => this.handleGutterPointerDown(event)));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		const chord = resolveStanzaFoldingChord(event, this.targetOperatingSystem, this.awaitingChord);
		if (chord === "prefix") {
			stopEvent(event);
			this.awaitingChord = true;
			return;
		}
		this.awaitingChord = false;
		if (chord) {
			stopEvent(event);
			if (typeof chord === "object") {
				this.setCollapsedToLevel(chord.level);
			} else if (chord === FoldingCommand.CollapseAll || chord === FoldingCommand.ExpandAll) {
				this.setAllCollapsed(chord === FoldingCommand.CollapseAll);
			} else if (chord === FoldingCommand.CreateManualRange) {
				this.createManualRange();
			} else if (chord === FoldingCommand.RemoveManualRange) {
				this.removeManualRange();
			} else {
				this.setContainingFoldRecursively(chord === FoldingCommand.CollapseRecursively);
			}
			return;
		}
		const command = resolveStanzaFoldingCommand(event, this.targetOperatingSystem);
		if (!command) return;
		stopEvent(event);
		this.setContainingFoldCollapsed(command === FoldingCommand.Collapse);
	}

	private handleGutterPointerDown(event: IEditorMouseEvent): void {
		const target = event.target;
		const foldingMarker = target.element?.closest<HTMLElement>('.stanza-editor-line-decoration[class*="ash-icon-folding-"]');
		if (target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS || !foldingMarker || !target.position) return;
		const lineIndex = target.position.lineNumber - 1;
		event.event.preventDefault();
		event.event.stopPropagation();
		this.viewport.domNode.domNode.focus({ preventScroll: true });
		const region = this.folding.toggleAtLine(lineIndex);
		if (region?.collapsed) this.relocateHiddenSelections(region);
	}

	private setContainingFoldCollapsed(collapsed: boolean): void {
		const position = this.editor.getPosition();
		if (!position) return;
		const region = this.folding.setContainingLineCollapsed(position.lineNumber - 1, collapsed);
		if (!region) return;
		if (region.collapsed) this.relocateHiddenSelections(region);
		this.revealPosition();
	}

	private setAllCollapsed(collapsed: boolean): void {
		if (!this.folding.setAllCollapsed(collapsed)) return;
		if (collapsed) {
			for (const region of this.folding.regions) if (region.collapsed) this.relocateHiddenSelections(region);
		}
		this.revealPosition();
	}

	private setContainingFoldRecursively(collapsed: boolean): void {
		const position = this.editor.getPosition();
		if (!position) return;
		const lineIndex = position.lineNumber - 1;
		const region = collapsed
			? this.folding.collapseContainingRegionRecursively(lineIndex)
			: this.folding.expandContainingRegionRecursively(lineIndex);
		if (!region) return;
		if (collapsed) this.relocateHiddenSelections(region);
		this.revealPosition();
	}

	private createManualRange(): void {
		const selection = this.editor.getSelection();
		if (!selection) return;
		const endLineIndex = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
			? selection.endLineNumber - 2
			: selection.endLineNumber - 1;
		const region = this.folding.addManualRange(selection.startLineNumber - 1, endLineIndex);
		if (region) this.revealPosition();
	}

	private removeManualRange(): void {
		const position = this.editor.getPosition();
		if (!position) return;
		const region = this.folding.removeContainingManualRange(position.lineNumber - 1);
		if (region) this.revealPosition();
	}

	private setCollapsedToLevel(level: number): void {
		if (!this.folding.collapseToLevel(level)) return;
		for (const region of this.folding.regions) if (region.collapsed) this.relocateHiddenSelections(region);
		this.revealPosition();
	}

	private relocateHiddenSelections(region: EditorFoldingRegion): void {
		const header = new Position((region.startLineIndex) + 1, (this.viewport.textModel.getLineContent((region.startLineIndex) + 1).length) + 1);
		const selections = (this.editor.getSelections() ?? []).map(selection => {
			const activeLineIndex = selection.getPosition().lineNumber - 1;
			return activeLineIndex > region.startLineIndex && activeLineIndex <= region.endLineIndex
				? Selection.fromPositions(header)
				: selection;
		});
		this.editor.setSelections(selections, 'folding');
	}

	private revealPosition(): void {
		const position = this.editor.getPosition();
		if (position) this.viewport.revealPosition(Position.lift(position));
	}
}

function resolveStanzaFoldingChord(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, targetOperatingSystem: OperatingSystem, awaitingChord: boolean): FoldingChord | undefined {
	const modifier = targetOperatingSystem === OperatingSystem.Macintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (!modifier || event.shiftKey || event.altKey) return undefined;
	if (!awaitingChord) return event.key.toLowerCase() === "k" ? "prefix" : undefined;
	if (event.key === "0") return FoldingCommand.CollapseAll;
	if (event.key.toLowerCase() === "j") return FoldingCommand.ExpandAll;
	if (event.key === "[") return FoldingCommand.CollapseRecursively;
	if (event.key === "]") return FoldingCommand.ExpandRecursively;
	if (event.key === ",") return FoldingCommand.CreateManualRange;
	if (event.key === ".") return FoldingCommand.RemoveManualRange;
	const level = Number(event.key);
	return Number.isSafeInteger(level) && level >= 1 && level <= 9
		? Object.freeze({ command: FoldingCommand.CollapseToLevel, level })
		: undefined;
}

type FoldingChord = FoldingCommand | "prefix" | { readonly command: FoldingCommand.CollapseToLevel; readonly level: number };

/** Resolves the platform-specific fold and unfold chords used by VS Code. */
export function resolveStanzaFoldingCommand(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, targetOperatingSystem: OperatingSystem): FoldingCommand | undefined {
	const command = event.key === "["
		? FoldingCommand.Collapse
		: event.key === "]"
			? FoldingCommand.Expand
			: undefined;
	if (!command) return undefined;
	if (targetOperatingSystem === OperatingSystem.Macintosh) {
		return event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey ? command : undefined;
	}
	return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey ? command : undefined;
}

function readOperatingSystem(value: OperatingSystem | undefined): OperatingSystem {
	const resolved = value ?? operatingSystem;
	if (!Object.values(OperatingSystem).includes(resolved)) {
		throw new TypeError("Unknown Stanza folding operating system");
	}
	return resolved;
}
