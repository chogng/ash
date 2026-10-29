import { ExceptionWidget } from './exceptionWidget.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TrackedRangeStickiness } from '../../../../editor/common/model.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { TextDecorationCollection, type TextDecorationId } from '../../../../editor/common/model/decorationCollection.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDebugService } from '../common/debug.js';
import { findExpressionInStackFrame } from './debugHover.js';
import './media/debug.contribution.css';

/** Owns Debug requests and annotations; the editor's shared hover owns DOM and input. */
export class DebugEditorContribution extends Disposable {
	private readonly hoverRegistration = this._register(new MutableDisposable<IDisposable>());
	private readonly decorations: TextDecorationCollection<undefined>;
	private decorationIds: readonly TextDecorationId[] = [];
	private generation = 0;
	private readonly refresh = this._register(new RunOnceScheduler(() => this.update(), 30));

	constructor(
		private readonly editor: ICodeEditor,
		private readonly model: TextModel,
		@IDebugService private readonly debug: IDebugService,
		@ILanguageFeaturesService private readonly languages: ILanguageFeaturesService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this._register(instantiation.createInstance(ExceptionWidget, editor, model));
		this.decorations = this._register(new TextDecorationCollection(model));
		const invalidate = (): void => {
			++this.generation;
			this.hoverRegistration.clear();
			this.decorationIds = this.decorations.deltaDecorations(this.decorationIds, []);
			this.refresh.schedule();
		};
		this._register(debug.onDidChangeSession(invalidate));
		this._register(debug.getViewModel().onDidFocusStackFrame(invalidate));
		this._register(debug.getViewModel().onWillUpdateViews(invalidate));
		this._register(model.onDidChangeContent(invalidate));
		this._register(model.onDidChangeLanguage(invalidate));
		this._register(editor.onDidScrollChange(() => this.refresh.schedule()));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('debug.inlineValues')) invalidate();
			}),
		);
		this.update();
	}

	private update(): void {
		const session = this.debug.session;
		const frame = this.debug.getViewModel().focusedStackFrame;
		const generation = ++this.generation;
		const version = this.model.version;
		const current = () =>
			!this.isDisposed &&
			generation === this.generation &&
			this.model.version === version &&
			this.debug.session === session &&
			session?.state === 'stopped' &&
			this.debug.getViewModel().focusedStackFrame === frame;
		if (!session || session.state !== 'stopped' || !frame || frame.source?.resource?.toString() !== this.model.uri.toString()) return;
		this.hoverRegistration.value = this.languages.hoverProvider.register(
			{ language: this.model.getLanguageId(), scheme: this.model.uri.scheme },
			{
				provideHover: async (request, signal) => {
					if (request.model !== this.model || !current()) return undefined;
					const word = this.model.getWordAtPosition(request.position);
					if (!word) return undefined;
					const prefix = this.model.getLineContent(request.position.lineNumber).slice(0, word.endColumn - 1);
					const expression = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.exec(prefix)?.[0];
					if (!expression) return undefined;
					try {
						const variable = await findExpressionInStackFrame(session, frame, expression.split('.'), signal);
						if (!variable || signal.aborted || !current()) return undefined;
						return {
							range: new Range(request.position.lineNumber, word.endColumn - expression.length, request.position.lineNumber, word.endColumn),
							contents: [`${expression} = ${variable.value}${variable.type ? `\n${variable.type}` : ''}`],
						};
					} catch (error) {
						if (!isCancellationError(error) && current() && !signal.aborted) throw error;
						return undefined;
					}
				},
			},
		);
		if (this.configuration.getValue<string>('debug.inlineValues') === 'off') return;
		const ranges = this.editor.getVisibleRanges();
		void session.inspectFrame(frame.id).then(
			scopes => {
				if (!current()) return;
				const values = scopes
					.flatMap(scope => scope.variables)
					.filter(value => /^[A-Za-z_$][\w$]*$/.test(value.name) && !value.presentationHint?.lazy)
					.slice(0, 100);
				const annotations: Parameters<TextDecorationCollection<undefined>['deltaDecorations']>[1][number][] = [];
				for (const range of ranges) {
					for (let line = range.startLineNumber; line <= Math.min(range.endLineNumber, range.startLineNumber + 200); line++) {
						const text = this.model.getLineContent(line).slice(0, 4096);
						const labels = values
							.filter(value => new RegExp(`(?<![\\w$])${escapeRegExpCharacters(value.name)}(?![\\w$])`).test(text))
							.slice(0, 8)
							.map(value => `${value.name} = ${value.value.slice(0, 120)}`);
						if (!labels.length || annotations.length >= 100) continue;
						const column = this.model.getLineMaxColumn(line);
						annotations.push({
							range: new Range(line, column, line, column),
							stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
							options: {
								description: 'debug-inline-value',
								after: { content: `  ${labels.join(', ')}`, inlineClassName: 'ash-debug-inline-value' },
							},
							metadata: undefined,
						});
					}
				}
				this.decorationIds = this.decorations.deltaDecorations(this.decorationIds, annotations);
			},
			() => {
				/* Failed/stale inspections leave the editor unchanged. */
			},
		);
	}
}
