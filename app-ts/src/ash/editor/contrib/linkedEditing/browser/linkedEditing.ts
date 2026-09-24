import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type View } from '../../../browser/view.js';
import { type ViewController } from '../../../browser/view/viewController.js';
import { ReplaceCommandThatPreservesSelection } from '../../../common/commands/replaceCommand.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextModelChangeReason, type TextModelChange } from '../../../common/core/textChange.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type LinkedEditingRangeProvider, type LinkedEditingRanges } from '../../../common/languages.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type TrackedRange } from '../../../common/model/trackedRange.js';
import './linkedEditing.css';

export class LinkedEditingContribution extends Disposable {
	public static readonly ID = 'editor.contrib.linkedEditing';

	public static get(editor: ICodeEditor): LinkedEditingContribution | null {
		return editor.getContribution<LinkedEditingContribution>(LinkedEditingContribution.ID);
	}

	private readonly ranges = this._register(new DisposableStore());
	private trackedRanges: readonly TrackedRange[] = [];
	private isActive = false;
	private isActivationScheduled = false;
	private request: CancellationTokenSource | undefined;
	private wordPattern: RegExp | undefined;
	private syncToken = 0;
	private syncing = false;

	constructor(
		private readonly view: ViewController,
		private readonly editor: ICodeEditor,
		input: HTMLElement,
		private readonly viewport: View,
		private readonly providers: LanguageFeatureRegistry<LinkedEditingRangeProvider>,
		private readonly defaultWordPattern: () => RegExp | undefined,
		private readonly onError: (error: unknown) => void = error => console.error('Stanza linked editing failed', error),
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Linked editing dependencies must share a text model');
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || !event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.altKey || event.key !== 'F2') return;
			stopEvent(event);
			void this.activate();
		}, true));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.key !== 'Escape' || !this.isActive) return;
			stopEvent(event);
			this.clear();
		}, true));
		this._register(viewport.textModel.onDidChangeContent(change => this.onDidChangeContent(change)));
		this._register(editor.onDidChangeCursorPosition(() => this.scheduleActivation()));
		this._register(providers.onDidChange(() => this.scheduleActivation()));
		this._register(toDisposable(() => this.clear()));
		this.scheduleActivation();
	}

	private async activate(): Promise<void> {
		if (this.isDisposed) return;
		this.request?.dispose(true);
		const request = this.request = new CancellationTokenSource();
		try {
			const primary = this.editor.getSelection();
			if (!primary) return;
			if (!primary.isEmpty()) {
				this.clear();
				return;
			}

			const model = this.viewport.textModel;
			const version = model.getVersionId();
			let result: LinkedEditingRanges | undefined;
			for (const provider of this.providers.ordered(model)) {
				try {
					result = await Promise.resolve(provider.provideLinkedEditingRanges(model, primary.getPosition(), request.token)) ?? undefined;
				} catch (error) {
					if (request.token.isCancellationRequested) return;
					this.onError(error);
					continue;
				}
				if (request.token.isCancellationRequested || this.isDisposed || model.getVersionId() !== version) return;
				if (result) break;
			}

			if (!result || result.ranges.length < 2) {
				this.clear();
				return;
			}
			const normalizedRanges = result.ranges.map(range => model.validateRange(range));
			const expectedText = model.getTextInRange(normalizedRanges[0]!);
			if (normalizedRanges.some(range => model.getTextInRange(range) !== expectedText)) {
				this.clear();
				return;
			}

			this.ranges.clear();
			this.trackedRanges = normalizedRanges.map(range => {
				const trackedRange = model.trackRange(range, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
				this.ranges.add(toDisposable(() => trackedRange.dispose()));
				return trackedRange;
			});
			this.wordPattern = result.wordPattern ?? this.defaultWordPattern();
			this.isActive = true;
			this.viewport.domNode.domNode.classList.add('linked-editing-active');
			this.viewport.announceAccessibilityStatus(`${normalizedRanges.length} linked editing ranges active`);
		} finally {
			if (this.request === request) {
				this.request = undefined;
				request.dispose();
			}
		}
	}

	private onDidChangeContent(change: TextModelChange): void {
		if (this.syncing || !this.isActive || change.reason !== TextModelChangeReason.Edit || change.changes.length === 0) return;
		const model = this.viewport.textModel;
		const changedRanges = change.changes.map(item => Range.fromPositions(
			model.positionAt(item.rangeOffset),
			model.positionAt(item.rangeOffset + item.text.length),
		));
		const source = this.trackedRanges.find(candidate => changedRanges.every(range => candidate.range.containsRange(range)));
		if (!source) return;
		const token = ++this.syncToken;
		queueMicrotask(() => {
			if (token !== this.syncToken || !this.isActive || this.isDisposed) return;
			this.syncRanges(source);
		});
	}

	private syncRanges(source: TrackedRange): void {
		const model = this.viewport.textModel;
		const value = model.getTextInRange(source.range);
		if (this.wordPattern && !matchesEntirePattern(this.wordPattern, value)) {
			this.clear();
			return;
		}
		const selection = this.editor.getSelection();
		if (!selection) return;
		const commands = this.trackedRanges
			.filter(candidate => candidate !== source && model.getTextInRange(candidate.range) !== value)
			.map(candidate => new ReplaceCommandThatPreservesSelection(candidate.range, value, selection));
		if (commands.length === 0) return;
		this.syncing = true;
		try {
			this.editor.executeCommands('linkedEditing', commands);
		} finally {
			this.syncing = false;
		}
	}

	private scheduleActivation(): void {
		if (this.isActivationScheduled || this.isDisposed) return;
		this.isActivationScheduled = true;
		queueMicrotask(() => {
			this.isActivationScheduled = false;
			if (!this.isDisposed) void this.activate();
		});
	}

	private clear(): void {
		this.syncToken += 1;
		this.request?.dispose(true);
		this.request = undefined;
		this.ranges.clear();
		this.trackedRanges = [];
		this.wordPattern = undefined;
		this.isActive = false;
		this.viewport.domNode.domNode.classList.remove('linked-editing-active');
	}
}

function matchesEntirePattern(pattern: RegExp, value: string): boolean {
	pattern.lastIndex = 0;
	const match = pattern.exec(value);
	pattern.lastIndex = 0;
	return match?.index === 0 && match[0].length === value.length;
}

registerEditorContribution({
	id: LinkedEditingContribution.ID,
	install: context => {
		if (context.kind !== 'text') return;
		return new LinkedEditingContribution(
			context.controller,
			context.editor,
			context.controller.element,
			context.view,
			context.languageFeaturesService.linkedEditingRangeProvider,
			() => context.configurations.getLanguageConfiguration(context.model.getLanguageId()).getWordDefinition(),
			context.onLanguageError,
		);
	},
});
