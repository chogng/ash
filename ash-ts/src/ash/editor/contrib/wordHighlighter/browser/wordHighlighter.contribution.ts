import { ResourceMap } from '../../../../base/common/map.js';
import { RunOnceScheduler, TimeoutTimer } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type ViewController } from '../../../browser/view/viewController.js';
import { Selection } from '../../../common/core/selection.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type ICursorSelectionChangedEvent } from '../../../common/cursorEvents.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { DocumentHighlightKind, type DocumentHighlight, type DocumentHighlightProvider, type MultiDocumentHighlightProvider } from '../../../common/languages.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { type TextModel } from '../../../common/model/textModel.js';

import type { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { getDocumentHighlightDecorationClassName } from './highlightDecorations.js';
import { TextualMultiDocumentHighlightFeature } from './textualHighlightProvider.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { TrackedRangeStickiness } from '../../../common/model.js';

type OccurrencesHighlightMode = 'off' | 'singleFile' | 'multiFile';

interface WordHighlighterOptions {
	readonly resource: URI;
	readonly languageFeaturesService: ILanguageFeaturesService;
	readonly onError?: (error: unknown) => void;
}

interface DocumentHighlightTarget {
	readonly resource: URI;
	readonly model: TextModel;
	readonly snapshot: ReturnType<TextModel['createVersionedSnapshot']>;
	readonly languageId: string;
}

/** Owns semantic word highlights and their editor-local lifecycle. */
class WordHighlighter extends Disposable {
	private readonly resource: URI;
	private readonly onError: (error: unknown) => void;
	private readonly providers: LanguageFeatureRegistry<DocumentHighlightProvider>;
	private readonly multiDocumentProviders: LanguageFeatureRegistry<MultiDocumentHighlightProvider>;
	private readonly coordinator: WordHighlightCoordinator;
	private request: CancellationTokenSource | undefined;
	private readonly scheduler: RunOnceScheduler;
	private requestId = 0;
	private lastDecorationKey = '';
	private focused = false;
	private changingSelection = false;

	constructor(
		private readonly view: ViewController,
		private readonly editor: ICodeEditor,
		private readonly decorations: TextDecorationCollection<DocumentHighlightKind | undefined>,
		options: WordHighlighterOptions,
	) {
		super();
		validateControllerDependencies(view, editor, decorations, options);
		this.resource = options.resource;
		this.onError = options.onError ?? reportHighlightError;
		this.providers = options.languageFeaturesService.documentHighlightProvider;
		this.multiDocumentProviders = options.languageFeaturesService.multiDocumentHighlightProvider;
		this.coordinator = acquireCoordinator(options.languageFeaturesService, this);
		this.scheduler = this._register(new RunOnceScheduler(() => void this.run(), this.editor.getOption(EditorOption.occurrencesHighlightDelay)));
		this._register(toDisposable(() => {
			this.cancelRequest();
			this.coordinator.remove(this);
		}));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.occurrencesHighlight) || event.hasChanged(EditorOption.occurrencesHighlightDelay)) {
				this.handleModelChange();
				this.schedule();
			}
		}));
		this._register(editor.onDidChangeCursorSelection(change => this.handleSelectionChange(change)));
		this._register(view.viewport.textModel.onDidChangeContent(() => this.handleModelChange()));
		this._register(view.viewport.textModel.onDidChangeLanguage(() => this.handleModelChange()));
		this._register(this.providers.onDidChange(() => this.handleModelChange()));
		this._register(this.multiDocumentProviders.onDidChange(() => this.handleModelChange()));
		this._register(view.editContext.onDidFocus(() => this.handleFocus(true)));
		this._register(view.editContext.onDidBlur(() => this.handleFocus(false)));
		this._register(view.onWillKeydown(event => this.handleKeydown(event)));
	}

	get highlightMode(): OccurrencesHighlightMode {
		return this.editor.getOption(EditorOption.occurrencesHighlight);
	}

	get documentResource(): URI {
		return this.resource;
	}

	get documentLanguageId(): string {
		return this.textModel.getLanguageId();
	}

	get textModel(): TextModel {
		return this.view.viewport.textModel;
	}

	get isFocused(): boolean {
		return this.focused;
	}

	get documentHighlightProvider(): LanguageFeatureRegistry<DocumentHighlightProvider> {
		return this.providers;
	}

	get multiDocumentHighlightProvider(): LanguageFeatureRegistry<MultiDocumentHighlightProvider> {
		return this.multiDocumentProviders;
	}

	trigger(): void {
		if (this.editor.getOption(EditorOption.occurrencesHighlight) === 'off') return;
		this.schedule(0);
	}

	moveNext(): boolean {
		return this.move(1);
	}

	movePrevious(): boolean {
		return this.move(-1);
	}

	clearHighlights(): void {
		this.cancelRequest();
		this.replaceHighlights(Object.freeze([]));
	}

	createTarget(): DocumentHighlightTarget {
		return Object.freeze({
			resource: this.resource,
			model: this.textModel,
			snapshot: this.textModel.createVersionedSnapshot(),
			languageId: this.textModel.getLanguageId(),
		});
	}

	applyHighlights(highlights: readonly DocumentHighlight[]): void {
		this.replaceHighlights(highlights);
	}

	hasDecorations(): boolean {
		return this.decorations.size > 0;
	}

	private handleSelectionChange(change: ICursorSelectionChangedEvent): void {
		if (this.changingSelection) return;
		this.cancelRequest();
		this.coordinator.clear();
		if (change.reason === CursorChangeReason.Explicit) this.schedule();
	}

	private handleModelChange(): void {
		this.cancelRequest();
		this.coordinator.clear();
	}

	private handleFocus(focused: boolean): void {
		this.focused = focused;
		if (focused) {
			this.schedule();
			return;
		}
		this.coordinator.clearWhenUnfocused();
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.key !== 'F7' || event.altKey || event.ctrlKey || event.metaKey) return;
		const moved = event.shiftKey ? this.movePrevious() : this.moveNext();
		if (!moved) return;
		event.preventDefault();
		event.stopPropagation();
	}

	private schedule(delay = this.editor.getOption(EditorOption.occurrencesHighlightDelay)): void {
		this.cancelRequest();
		if (this.editor.getOption(EditorOption.occurrencesHighlight) === 'off' || (!this.focused && delay !== 0)) return;
		this.scheduler.schedule(delay);
	}

	private async run(): Promise<void> {
		const position = this.highlightPosition();
		if (!position) {
			this.coordinator.clear();
			return;
		}
		const request = new CancellationTokenSource();
		this.request = request;
		const requestId = ++this.requestId;
		try {
			const result = await this.coordinator.provide(this, position, request.token);
			if (request.token.isCancellationRequested || requestId !== this.requestId) return;
			this.coordinator.apply(this, result);
		} catch (error) {
			if (!request.token.isCancellationRequested) this.onError(error);
		} finally {
			if (this.request === request) this.request = undefined;
			request.dispose();
		}
	}

	private highlightPosition(): Position | undefined {
		if (this.editor.getSelections()!.length !== 1) return undefined;
		const selection = this.editor.getSelections()![0]!;
		if (!selectionFitsModel(this.textModel, selection) || selection.getStartPosition().lineNumber !== selection.getEndPosition().lineNumber) return undefined;
		const word = this.textModel.getWordAtPosition(selection.getStartPosition());
		if (!word) return undefined;
		const range = new Range(selection.startLineNumber, word.startColumn, selection.startLineNumber, word.endColumn);
		if (Position.compare(range.getStartPosition(), selection.getStartPosition()) > 0 || Position.compare(range.getEndPosition(), selection.getEndPosition()) < 0) return undefined;
		return selection.getStartPosition();
	}

	private replaceHighlights(highlights: readonly DocumentHighlight[]): void {
		const normalized = highlights.map(highlight => ({ ...highlight, range: Range.lift(highlight.range)! }));
		const key = normalized.map(highlight => `${this.textModel.offsetAt(highlight.range.getStartPosition())}-${this.textModel.offsetAt(highlight.range.getEndPosition())}:${highlight.kind ?? ''}`).join(',');
		if (key === this.lastDecorationKey) return;
		this.lastDecorationKey = key;
		this.decorations.replaceAll(normalized.map(highlight => ({
			range: highlight.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: 'word-highlight',
				className: getDocumentHighlightDecorationClassName(highlight.kind),
			},
			metadata: highlight.kind,
		})));
	}

	private move(direction: 1 | -1): boolean {
		const ranges = [...this.decorations.decorations].map(decoration => decoration.range).sort((left, right) => Position.compare(left.getStartPosition(), right.getStartPosition()));
		if (ranges.length === 0) return false;
		const activeOffset = this.textModel.offsetAt(this.editor.getSelections()![0]!.getPosition());
		const currentIndex = ranges.findIndex(range => this.textModel.offsetAt(range.getStartPosition()) <= activeOffset && this.textModel.offsetAt(range.getEndPosition()) >= activeOffset);
		const nextIndex = direction === 1 ? (currentIndex + 1) % ranges.length : (currentIndex - 1 + ranges.length) % ranges.length;
		const destination = ranges[nextIndex]!;
		this.changingSelection = true;
		try {
			this.editor.setSelections([Selection.fromPositions(destination.getStartPosition())]);
			this.view.revealPosition(destination.getStartPosition());
		} finally {
			this.changingSelection = false;
		}
		return true;
	}

	private cancelRequest(): void {
		this.scheduler.cancel();
		this.request?.cancel();
		this.request?.dispose();
		this.request = undefined;
		this.requestId += 1;
	}
}

export async function getOccurrencesAtPosition(registry: LanguageFeatureRegistry<DocumentHighlightProvider>, model: DocumentHighlightTarget, position: Position, token: CancellationToken): Promise<ResourceMap<readonly DocumentHighlight[]>> {
	for (const provider of registry.ordered(model.model)) {
		if (!isDocumentHighlightRequestCurrent(model, token)) return new ResourceMap();
		const highlights = await provider.provideDocumentHighlights(model.model, position, token);
		if (!isDocumentHighlightRequestCurrent(model, token)) return new ResourceMap();
		if (highlights === undefined || highlights === null) continue;
		const result = new ResourceMap<readonly DocumentHighlight[]>();
		result.set(model.resource, normalizeHighlights(model.model, highlights));
		return result;
	}
	return new ResourceMap();
}

export async function getOccurrencesAcrossMultipleModels(registry: LanguageFeatureRegistry<MultiDocumentHighlightProvider>, model: DocumentHighlightTarget, position: Position, token: CancellationToken, otherModels: readonly DocumentHighlightTarget[]): Promise<ResourceMap<readonly DocumentHighlight[]>> {
	const targets = Object.freeze([model, ...otherModels]);
	for (const provider of registry.ordered(model.model)) {
		if (!isDocumentHighlightRequestCurrent(model, token, targets)) return new ResourceMap();
		const highlights = await provider.provideMultiDocumentHighlights(model.model, position, otherModels.map(target => target.model), token);
		if (!isDocumentHighlightRequestCurrent(model, token, targets)) return new ResourceMap();
		if (highlights !== undefined && highlights !== null) return normalizeHighlightMap(highlights, targets);
	}
	return new ResourceMap();
}

function isDocumentHighlightRequestCurrent(request: DocumentHighlightTarget, token: CancellationToken, targets: readonly DocumentHighlightTarget[] = []): boolean {
	return !token.isCancellationRequested && !request.model.isDisposed() && request.model.version === request.snapshot.version && targets.every(target => !target.model.isDisposed() && target.model.version === target.snapshot.version);
}

function normalizeHighlightMap(result: ReadonlyMap<URI, readonly DocumentHighlight[]>, targets: readonly DocumentHighlightTarget[]): ResourceMap<readonly DocumentHighlight[]> {
	if (!result || typeof result[Symbol.iterator] !== 'function') throw new TypeError('Multi-document highlights must be a resource map');
	const models = new ResourceMap<TextModel>();
	for (const target of targets) models.set(target.resource, target.model);
	const normalized = new ResourceMap<readonly DocumentHighlight[]>();
	for (const [resource, highlights] of result) {
		const model = models.get(resource);
		if (!model) throw new RangeError(`Document highlights returned an unknown resource '${resource.toString()}'`);
		normalized.set(resource, normalizeHighlights(model, highlights));
	}
	return normalized;
}

function normalizeHighlights(model: TextModel, highlights: readonly DocumentHighlight[]): readonly DocumentHighlight[] {
	if (!Array.isArray(highlights)) throw new TypeError('Document highlights must be an array');
	return Object.freeze(highlights.map(highlight => {
		if (!highlight || typeof highlight !== 'object' || !highlight.range) throw new TypeError('Document highlight must contain a range');
		const range = new Range(highlight.range.startLineNumber, highlight.range.startColumn, highlight.range.endLineNumber, highlight.range.endColumn);
		model.offsetAt(range.getStartPosition());
		model.offsetAt(range.getEndPosition());
		if (highlight.kind !== undefined && !Object.values(DocumentHighlightKind).includes(highlight.kind)) throw new TypeError('Document highlight kind is invalid');
		return Object.freeze({ range, ...(highlight.kind !== undefined ? { kind: highlight.kind } : {}) });
	}));
}

class WordHighlightCoordinator {
	private readonly controllers = new Set<WordHighlighter>();
	private readonly clearTimer = new TimeoutTimer();

	constructor(private readonly service: ILanguageFeaturesService) {}

	add(controller: WordHighlighter): void {
		this.controllers.add(controller);
	}

	remove(controller: WordHighlighter): void {
		this.controllers.delete(controller);
		if (this.controllers.size === 0) {
			this.clearTimer.dispose();
			coordinators.delete(this.service);
		}
	}

	clear(): void {
		for (const controller of this.controllers) controller.clearHighlights();
	}

	clearWhenUnfocused(): void {
		this.clearTimer.cancelAndSet(() => {
			if (![...this.controllers].some(controller => controller.isFocused)) this.clear();
		}, 0);
	}

	async provide(source: WordHighlighter, position: Position, token: CancellationToken): Promise<ResourceMap<readonly DocumentHighlight[]>> {
		const targets = source.highlightMode === 'multiFile'
			? [...this.controllers].filter(controller => controller.highlightMode === 'multiFile').map(controller => controller.createTarget())
			: [source.createTarget()];
		const primary = source.createTarget();
		if (targets.length > 1 && source.multiDocumentHighlightProvider.has(source.textModel)) {
			return getOccurrencesAcrossMultipleModels(source.multiDocumentHighlightProvider, primary, position, token, targets.filter(target => target.model !== primary.model));
		}
		return getOccurrencesAtPosition(source.documentHighlightProvider, primary, position, token);
	}

	apply(source: WordHighlighter, result: ResourceMap<readonly DocumentHighlight[]>): void {
		for (const controller of this.controllers) {
			const highlights = result.get(controller.documentResource);
			controller.applyHighlights(highlights ?? Object.freeze([]));
			if (source.highlightMode === 'singleFile' && controller !== source) controller.clearHighlights();
		}
	}
}

const coordinators = new WeakMap<ILanguageFeaturesService, WordHighlightCoordinator>();

function acquireCoordinator(service: ILanguageFeaturesService, controller: WordHighlighter): WordHighlightCoordinator {
	let coordinator = coordinators.get(service);
	if (!coordinator) {
		coordinator = new WordHighlightCoordinator(service);
		coordinators.set(service, coordinator);
	}
	coordinator.add(controller);
	return coordinator;
}

function validateControllerDependencies(view: ViewController, editor: ICodeEditor, decorations: TextDecorationCollection<DocumentHighlightKind | undefined>, options: WordHighlighterOptions): void {
	if (view.viewport.textModel !== editor.getModel() || editor.getModel() !== decorations.textModel) throw new TypeError('Word highlighter dependencies must share one text model');
	if (!options || typeof options !== 'object' || !options.resource || !options.languageFeaturesService) throw new TypeError('Word highlighter requires resource and language services');
	if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('Word highlighter error handler must be a function');
}

function selectionFitsModel(model: WordHighlighter['textModel'], range: Range): boolean {
	return positionFitsModel(model, range.getStartPosition().lineNumber, range.getStartPosition().column) && positionFitsModel(model, range.getEndPosition().lineNumber, range.getEndPosition().column);
}

function positionFitsModel(model: WordHighlighter['textModel'], lineNumber: number, column: number): boolean {
	return Number.isSafeInteger(lineNumber) && Number.isSafeInteger(column) && lineNumber >= 1 && column >= 1 && lineNumber <= model.lineCount && column <= model.getLineLength(lineNumber) + 1;
}

export class WordHighlighterContribution extends Disposable {
	static readonly ID = 'editor.contrib.wordHighlighter';
	private readonly wordHighlighter: WordHighlighter;

	constructor(view: ViewController, editor: ICodeEditor, decorations: TextDecorationCollection<DocumentHighlightKind | undefined>, options: WordHighlighterOptions) {
		super();
		this.wordHighlighter = this._register(new WordHighlighter(view, editor, decorations, options));
	}

	public saveViewState(): boolean {
		return this.wordHighlighter.hasDecorations();
	}

	public moveNext(): void {
		this.wordHighlighter.moveNext();
	}

	public moveBack(): void {
		this.wordHighlighter.movePrevious();
	}

	public restoreViewState(state: boolean | undefined): void {
		if (state) this.wordHighlighter.trigger();
	}

	public stopHighlighting(): void {
		this.wordHighlighter.clearHighlights();
	}
}

function reportHighlightError(error: unknown): void {
	console.error('Document highlight request failed', error);
}

registerEditorContribution({
	id: WordHighlighterContribution.ID,
	install: context => {
		if (context.kind !== 'text' || context.model.largeFile.tooLargeForTokenization) return;
		const decorations = context.register(new TextDecorationCollection<DocumentHighlightKind | undefined>(context.model));
		context.register(new TextualMultiDocumentHighlightFeature(context.languageFeaturesService));
		return new WordHighlighterContribution(context.controller, context.editor, decorations, {
			resource: context.model.uri,
			languageFeaturesService: context.languageFeaturesService,
			onError: context.onLanguageError,
		});
	},
});
