import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { isNumber, isObject } from '../../../../base/common/types.js';
import type { ICommandMetadata } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor, type IEditorMouseEvent, MouseTargetType } from '../../../browser/editorBrowser.js';
import { EditorFoldingModel, type CollapseMemento } from "./foldingModel.js";
import { EditorFoldingRangeSource, type EditorFoldingRange, type EditorFoldingRegion } from "./foldingRanges.js";
import { Position } from "../../../common/core/position.js";
import { Selection } from "../../../common/core/selection.js";
import { type View } from "../../../browser/view.js";
import { type ILanguageConfigurationService } from "../../../common/languages/languageConfigurationRegistry.js";
import { type ILanguageFeaturesService } from "../../../common/services/languageFeatures.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import {
	EditorAction,
	registerEditorAction,
	registerEditorContribution,
	registerInstantiatedEditorAction,
	type ServicesAccessor,
} from "../../../browser/editorExtensions.js";
import { EditorHiddenRangeModel } from "./hiddenRangeModel.js";
import { computeEditorIndentFoldingRanges } from "./indentRangeProvider.js";
import { computeEditorLanguageFoldingRanges, mergeEditorFoldingRanges } from "./syntaxRangeProvider.js";
import { FoldingRangeService } from "../common/languageFoldingRanges.js";
import { FoldingDecorationProvider } from './foldingDecorations.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import './folding.css';

const foldingEnabled = new RawContextKey<boolean>('foldingEnabled', false);

interface FoldingStateMemento {
	readonly collapsedRegions?: CollapseMemento;
	readonly lineCount?: number;
}

class FoldingDecorationPresenter extends Disposable {
	private decorationIds: string[] = [];

	constructor(private readonly editor: ICodeEditor, private readonly folding: EditorFoldingModel, private readonly decorations: FoldingDecorationProvider) {
		super();
		this._register(folding.onDidChange(() => this.refresh()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.showFoldingControls) || event.hasChanged(EditorOption.foldingHighlight)) this.refresh();
		}));
		this._register(toDisposable(() => decorations.removeDecorations(this.decorationIds)));
		this.refresh();
	}

	private refresh(): void {
		this.decorations.showFoldingControls = this.editor.getOption(EditorOption.showFoldingControls);
		this.decorations.showFoldingHighlights = this.editor.getOption(EditorOption.foldingHighlight);
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
		private readonly editor: ICodeEditor,
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
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.folding) || event.hasChanged(EditorOption.foldingStrategy) || event.hasChanged(EditorOption.foldingMaximumRegions)) this.refresh();
		}));
		this._register(toDisposable(() => this.request?.abort()));
		this.refresh();
	}

	private refresh(): void {
		this.request?.abort();
		if (!this.editor.getOption(EditorOption.folding)) {
			this.folding.setRanges([]);
			return;
		}
		const indentationOnly = this.editor.getOption(EditorOption.foldingStrategy) === 'indentation';
		const indentation = computeEditorIndentFoldingRanges(this.folding.model, { tabSize: this.options.tabSize });
		const local = indentationOnly ? indentation : mergeEditorFoldingRanges(
			computeEditorLanguageFoldingRanges(this.folding.model, this.folding.model.getLanguageId(), this.options.configurations),
			indentation,
		);
		this.applyRanges(local);
		if (indentationOnly || !this.options.providers.has(this.folding.model)) return;
		const request = this.request = new AbortController();
		void this.service.provideFoldingRanges(this.folding.model.getLanguageId(), request.signal).then(ranges => {
			if (request.signal.aborted || this.request !== request) return;
			this.applyRanges(mergeEditorFoldingRanges(local, ranges));
		}, error => {
			if (!request.signal.aborted) this.options.onError(error);
		});
	}

	private applyRanges(ranges: readonly EditorFoldingRange[]): void {
		const ordered = mergeEditorFoldingRanges(ranges);
		const limit = this.editor.getOption(EditorOption.foldingMaximumRegions);
		if (ordered.length <= limit) {
			this.folding.setProviderRanges(ordered);
			return;
		}
		const enclosingEnds: number[] = [];
		const ranked = ordered.map((range, index) => {
			while (enclosingEnds.length && enclosingEnds.at(-1)! < range.startLineIndex) {
				enclosingEnds.pop();
			}
			const depth = enclosingEnds.length;
			enclosingEnds.push(range.endLineIndex);
			return { range, depth, index };
		});
		const selected = ranked.sort((left, right) => left.depth - right.depth || left.index - right.index).slice(0, limit);
		this.folding.setProviderRanges(selected.sort((left, right) => left.index - right.index).map(item => item.range));
	}
}

/** Applies editor actions and gutter controls to the existing folding model. */
export class FoldingController extends Disposable {
	public static readonly ID = 'editor.contrib.folding';

	public static get(editor: ICodeEditor): FoldingController | null {
		return editor.getContribution<FoldingController>(FoldingController.ID);
	}

	private readonly viewport: View;
	private readonly editor: ICodeEditor;
	private readonly folding: EditorFoldingModel;

	constructor(
		editor: ICodeEditor,
		viewport: View,
		folding: EditorFoldingModel,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.viewport = viewport;
		this.editor = editor;
		this.folding = folding;
		try {
			if (this.viewport.textModel !== this.editor.getModel() || this.viewport.textModel !== this.folding.model) {
				throw new TypeError("Stanza folding dependencies must share one text model");
			}
			if (folding.model.largeFile.tooLargeForTokenization) return;
			const enabled = foldingEnabled.bindTo(contextKeyService);
			const updateEnabled = (): void => enabled.set(editor.getOption(EditorOption.folding));
			updateEnabled();
			this._register(toDisposable(() => enabled.reset()));
			this._register(this.editor.onMouseDown(event => this.handleGutterPointerDown(event)));
			this._register(editor.onDidChangeConfiguration(event => {
				if (event.hasChanged(EditorOption.folding)) updateEnabled();
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public saveViewState(): FoldingStateMemento {
		if (!this.editor.getModel() || !this.editor.getOption(EditorOption.folding)
			|| this.folding.model.largeFile.tooLargeForTokenization) return {};
		return {
			collapsedRegions: this.folding.getMemento(),
			lineCount: this.folding.model.lineCount,
		};
	}

	public restoreViewState(state: FoldingStateMemento | undefined): void {
		if (!state?.collapsedRegions?.length || !this.editor.getOption(EditorOption.folding)
			|| this.folding.model.largeFile.tooLargeForTokenization) return;
		this.folding.applyMemento(state.collapsedRegions);
	}

	private handleGutterPointerDown(event: IEditorMouseEvent): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		const target = event.target;
		const foldingMarker = target.element?.closest<HTMLElement>('.stanza-editor-line-decoration[class*="ash-icon-folding-"]');
		if (target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS || !foldingMarker || !target.position) return;
		const lineIndex = target.position.lineNumber - 1;
		event.event.preventDefault();
		event.event.stopPropagation();
		this.viewport.domNode.domNode.focus({ preventScroll: true });
		const region = this.folding.toggleAtLine(lineIndex);
		if (region?.collapsed) this.relocateHiddenSelections([region]);
	}

	public setContainingFoldCollapsed(collapsed: boolean, options: FoldingArguments = {}): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		const lines = options.selectionLines ?? this.editor.getSelections()?.map(selection => selection.startLineNumber - 1) ?? [];
		let scope: { levels: number; direction: 'up' | 'down' } | undefined;
		if (!collapsed || options.levels !== undefined || options.direction !== undefined) {
			scope = { levels: options.levels || 1, direction: options.direction === 'up' ? 'up' : 'down' };
		}
		this.folding.setContainingLinesCollapsed(lines, collapsed, scope);
		if (collapsed) this.relocateHiddenSelections(this.folding.regions);
		this.revealPosition();
	}

	public setAllCollapsed(collapsed: boolean): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		if (!this.folding.setAllCollapsed(collapsed)) return;
		if (collapsed) this.relocateHiddenSelections(this.folding.regions);
		this.revealPosition();
	}

	public setContainingFoldRecursively(collapsed: boolean): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		const lines = new Set(this.editor.getSelections()?.map(selection => selection.startLineNumber - 1));
		for (const line of lines) {
			if (collapsed) this.folding.collapseContainingRegionRecursively(line);
			else this.folding.expandContainingRegionRecursively(line);
		}
		if (collapsed) this.relocateHiddenSelections(this.folding.regions);
		this.revealPosition();
	}

	public createManualRanges(): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		const selections = this.editor.getSelections();
		if (!selections) return;
		const next = selections.map(selection => {
			const endLineIndex = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
				? selection.endLineNumber - 2
				: selection.endLineNumber - 1;
			const region = this.folding.addManualRange(selection.startLineNumber - 1, endLineIndex);
			return region ? Selection.fromPositions(new Position(selection.startLineNumber, 1)) : selection;
		});
		this.editor.setSelections(next, 'folding');
		this.revealPosition();
	}

	public removeManualRanges(): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		this.folding.removeManualRanges(this.editor.getSelections() ?? []);
		this.revealPosition();
	}

	public setCollapsedToLevel(level: number): void {
		if (!this.editor.getOption(EditorOption.folding)) return;
		const lines = this.editor.getSelections()?.map(selection => selection.startLineNumber - 1) ?? [];
		if (!this.folding.collapseToLevel(level, lines)) return;
		this.revealPosition();
	}

	private relocateHiddenSelections(regions: readonly EditorFoldingRegion[]): void {
		const collapsed = regions.filter(region => region.collapsed).sort((left, right) => left.startLineIndex - right.startLineIndex);
		const relocate = (position: Position): Position => {
			const region = collapsed.find(region =>
				position.lineNumber - 1 > region.startLineIndex && position.lineNumber - 1 <= region.endLineIndex);
			return region
				? new Position(region.startLineIndex + 1, this.folding.model.getLineMaxColumn(region.startLineIndex + 1))
				: position;
		};
		const selections = this.editor.getSelections() ?? [];
		const next = selections.map(selection => Selection.fromPositions(
			relocate(selection.getSelectionStart()), relocate(selection.getPosition())));
		if (next.some((selection, index) => !selection.equalsSelection(selections[index]!))) {
			this.editor.setSelections(next, 'folding');
		}
	}

	private revealPosition(): void {
		const position = this.editor.getPosition();
		if (position) this.viewport.revealPosition(Position.lift(position));
	}
}

registerEditorContribution({
	id: FoldingController.ID,
	configure: context => {
		const folding = context.register(new EditorFoldingModel(context.model));
		const hidden = context.register(new EditorHiddenRangeModel(context.model, folding));
		context.provideService(TextEditorCapability.folding, folding);
		const syncHiddenAreas = (): void => context.viewModel.setHiddenAreas(hidden.hiddenRanges);
		syncHiddenAreas();
		context.register(hidden.onDidChange(syncHiddenAreas));
	},
	install: context => {
		if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
		const folding = context.getService(TextEditorCapability.folding);
		const service = context.register(new FoldingRangeService(context.model, context.languageFeaturesService.foldingRangeProvider, context.model.uri));
		context.register(new FoldingRangeSource(context.editor, folding, service, {
			configurations: context.configurations,
			providers: context.languageFeaturesService.foldingRangeProvider,
			tabSize: context.options.indentation?.tabSize,
			onError: context.onLanguageError,
		}));
		context.register(new FoldingDecorationPresenter(context.editor, folding, new FoldingDecorationProvider(context.editor)));
		return context.instantiationService.createInstance(FoldingController, context.editor, context.view, folding);
	},
});

interface FoldingArguments {
	levels?: number;
	direction?: 'up' | 'down';
	selectionLines?: number[];
}

function foldingArgumentsConstraint(args: unknown): boolean {
	if (args === undefined) {
		return true;
	}
	if (!isObject(args)) {
		return false;
	}
	const options = args as FoldingArguments;
	return (options.levels === undefined || isNumber(options.levels))
		&& (options.direction === undefined || typeof options.direction === 'string')
		&& (options.selectionLines === undefined || Array.isArray(options.selectionLines) && options.selectionLines.every(isNumber));
}

function createFoldingMetadata(collapsed: boolean): ICommandMetadata {
	return {
		description: collapsed
			? localize2('folding.fold.description', 'Collapse the selected folding ranges.')
			: localize2('folding.unfold.description', 'Expand the selected folding ranges.'),
		args: [{
			name: localize('folding.arguments', 'Folding options'),
			description: localize('folding.arguments.description', 'levels sets the number of levels (default: 1). direction selects up or down. selectionLines supplies zero-based lines instead of the current selections. Fold without levels or direction finds the first expanded range at each line or above it.'),
			constraint: foldingArgumentsConstraint,
			schema: {
				type: 'object',
				properties: {
					levels: collapsed ? { type: 'number' } : { type: 'number', default: 1 },
					direction: collapsed
						? { type: 'string', enum: ['up', 'down'] }
						: { type: 'string', enum: ['up', 'down'], default: 'down' },
					selectionLines: { type: 'array', items: { type: 'number' } },
				},
			},
		}],
	};
}

class FoldAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.fold',
			label: localize2('fold', 'Fold'),
			metadata: createFoldingMetadata(true),
			precondition: foldingEnabled.isEqualTo(true),
			kbOpts: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketLeft },
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor, args: FoldingArguments): void {
		FoldingController.get(editor)?.setContainingFoldCollapsed(true, args);
	}
}

class UnfoldAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.unfold',
			label: localize2('unfold', 'Unfold'),
			metadata: createFoldingMetadata(false),
			precondition: foldingEnabled.isEqualTo(true),
			kbOpts: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketRight },
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor, args: FoldingArguments): void {
		FoldingController.get(editor)?.setContainingFoldCollapsed(false, args);
	}
}

registerEditorAction(FoldAction);
registerEditorAction(UnfoldAction);

function registerFoldChord(
	id: string,
	label: ReturnType<typeof localize2>,
	key: KeyCode,
	run: (controller: FoldingController) => void,
): void {
	registerInstantiatedEditorAction(new class extends EditorAction {
		constructor() {
			super({
				id,
				label,
				precondition: foldingEnabled.isEqualTo(true),
				kbOpts: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | key),
					weight: KeybindingWeight.EditorContrib,
					kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				},
			});
		}

		run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
			const controller = FoldingController.get(editor);
			if (controller) run(controller);
		}
	}());
}

registerFoldChord(
	'editor.foldAll', localize2('foldAll', 'Fold All'), KeyCode.Digit0,
	controller => controller.setAllCollapsed(true),
);
registerFoldChord(
	'editor.unfoldAll', localize2('unfoldAll', 'Unfold All'), KeyCode.KeyJ,
	controller => controller.setAllCollapsed(false),
);
registerFoldChord(
	'editor.foldRecursively', localize2('foldRecursively', 'Fold Recursively'), KeyCode.BracketLeft,
	controller => controller.setContainingFoldRecursively(true),
);
registerFoldChord(
	'editor.unfoldRecursively', localize2('unfoldRecursively', 'Unfold Recursively'), KeyCode.BracketRight,
	controller => controller.setContainingFoldRecursively(false),
);
registerFoldChord(
	'editor.createFoldingRangeFromSelection', localize2('createManualFoldRange', 'Create Folding Range from Selection'), KeyCode.Comma,
	controller => controller.createManualRanges(),
);
registerFoldChord(
	'editor.removeManualFoldingRanges', localize2('removeManualFoldRanges', 'Remove Manual Folding Ranges'), KeyCode.Period,
	controller => controller.removeManualRanges(),
);
for (let level = 1; level <= 7; level++) {
	registerFoldChord(
		`editor.foldLevel${level}`, localize2('foldLevel', 'Fold Level {0}', level), KeyCode.Digit0 + level,
		controller => controller.setCollapsedToLevel(level),
	);
}
