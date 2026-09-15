import { Position } from "../../../common/core/position.js";
import { stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { createLanguageCompletionIncompleteRefreshContext, createLanguageCompletionInvokeContext, type LanguageCompletionContext } from '../../../common/languages/completion/languageCompletionProviders.js';
import { type LanguageCompletionService } from '../../../common/languages/completion/languageCompletionService.js';
import { type EditorViewDidEditEvent, type EditorViewTextUpdateEvent, type ViewController } from '../../../browser/view/viewController.js';
import { SuggestModel, type LanguageCompletionSessionState } from './suggestModel.js';
import { CompletionWidget } from './suggestWidget.js';

export interface SuggestControllerOptions {
	/** Optional host for the widget; defaults to the editor viewport root. */
	readonly widgetContainer?: HTMLElement;
	readonly onRequestError?: (error: unknown) => void;
}

/**
 * Browser Suggest contribution for one editor.
 *
 * The common session and completion service are supplied by the contribution
 * composition root. This controller owns only browser request cancellation,
 * keyboard/input interception, and the completion widget, matching VS Code's
 * separation between View and SuggestController.
 */
export class SuggestController extends Disposable {
	readonly widget: CompletionWidget;
	private readonly onRequestError: (error: unknown) => void;
	private completionRequest: AbortController | undefined;
	private completionIsIncomplete = false;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly view: ViewController,
		private readonly service: LanguageCompletionService,
		private readonly session: SuggestModel,
		private readonly languageId: string,
		options: SuggestControllerOptions = {},
	) {
		super();
		try {
			if (
				view.viewport.textModel !== editor.getModel() ||
				view.viewport.textModel !== service.textModel ||
				view.viewport.textModel !== session.textModel ||
				service.results !== session.resultStore
			) {
				throw new TypeError('Stanza Suggest dependencies must share one text model and completion result store');
			}
			if (options.onRequestError !== undefined && typeof options.onRequestError !== 'function') {
				throw new TypeError('Stanza Suggest request error handler must be a function');
			}
			this.onRequestError = options.onRequestError ?? reportRequestError;
			const results = service.results;
			this.completionIsIncomplete = results.result?.value.isIncomplete === true;
			this._register(results.onDidChange(change => {
				if (change.result) this.completionIsIncomplete = change.result.value.isIncomplete;
			}));
			this.widget = this._register(new CompletionWidget(
				editor,
				view,
				view.viewport,
				session,
				options.widgetContainer,
			));
			this._register(view.onWillBeforeInput(event => this.handleBeforeInput(event)));
			this._register(view.onWillTextUpdate(event => this.handleTextUpdate(event)));
			this._register(view.onWillKeydown(event => this.handleKeydown(event)));
			this._register(view.onDidEdit(event => this.handleDidEdit(event)));
			this._register(toDisposable(() => this.cancelCompletionRequest()));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private handleBeforeInput(event: InputEvent): void {
		if (event.defaultPrevented || (event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText') || !event.data) return;
		if (!this.session.acceptSelectedWithCommitCharacter(event.data)) return;
		stopEvent(event);
		this.view.clearInput();
		const position = this.editor.getPosition();
		if (position) this.view.revealPosition(Position.lift(position));
		this.requestAfterInsert(event.data, false);
	}

	private handleTextUpdate(event: EditorViewTextUpdateEvent): void {
		if (event.defaultPrevented || !event.text || !this.session.acceptSelectedWithCommitCharacter(event.text)) return;
		event.preventDefault();
		this.view.clearInput();
		const position = this.editor.getPosition();
		if (position) this.view.revealPosition(Position.lift(position));
		this.requestAfterInsert(event.text, false);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (this.isDisposed || event.defaultPrevented || event.isComposing) return;
		if (
			event.key === ' ' &&
			event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.metaKey
		) {
			stopEvent(event);
			this.requestCompletion(createLanguageCompletionInvokeContext());
			return;
		}
		if (
			event.altKey &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			(event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
			(event.key === 'ArrowDown'
				? this.session.selectNextSnippetChoice()
				: this.session.selectPreviousSnippetChoice())
		) {
			stopEvent(event);
			return;
		}

		const state = this.readState();
		if (
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			state &&
			(event.key === 'ArrowDown' || event.key === 'ArrowUp')
		) {
			stopEvent(event);
			if (event.key === 'ArrowDown') this.session.selectNext();
			else this.session.selectPrevious();
			return;
		}
		if (
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			event.key === 'Enter' &&
			state
		) {
			stopEvent(event);
			this.acceptSelected();
			return;
		}
		if (
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			event.key === 'Escape'
		) {
			if (this.session.cancelSnippetPlaceholderNavigation() || state) {
				stopEvent(event);
				if (state) this.session.cancel();
			}
			return;
		}
		if (
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			event.key === 'Tab'
		) {
			const handledSnippet = event.shiftKey
				? this.session.selectPreviousSnippetPlaceholder()
				: this.session.selectNextSnippetPlaceholder();
			if (handledSnippet) {
				stopEvent(event);
				return;
			}
			if (!event.shiftKey && state) {
				stopEvent(event);
				this.acceptSelected();
			}
		}
	}

	private acceptSelected(): void {
		if (!this.session.acceptSelected()) return;
		const position = this.editor.getPosition();
		if (position) this.view.revealPosition(Position.lift(position));
		this.view.viewport.focus();
	}

	private handleDidEdit(event: EditorViewDidEditEvent): void {
		const refreshIncomplete = this.readIsIncomplete();
		if (event.insertedText !== undefined) {
			this.requestAfterInsert(event.insertedText, refreshIncomplete);
		} else if (refreshIncomplete) {
			this.requestCompletion(createLanguageCompletionIncompleteRefreshContext());
		}
	}

	private readState(): LanguageCompletionSessionState | undefined {
		try {
			return this.session.state;
		} catch (error) {
			if (error instanceof ReferenceError) return undefined;
			throw error;
		}
	}

	private readIsIncomplete(): boolean {
		const result = this.service.results.result;
		if (result) return result.value.isIncomplete;
		if (this.completionIsIncomplete) return true;
		try {
			return this.session.state?.isIncomplete === true;
		} catch (error) {
			if (error instanceof ReferenceError) return false;
			throw error;
		}
	}

	private requestAfterInsert(insertedText: string, refreshIncomplete: boolean): void {
		if ([...insertedText].length === 1) {
			const selections = this.editor.getSelections();
			if (!selections || selections.length !== 1 || !selections[0]!.isEmpty()) {
				this.session.cancel();
				return;
			}
			const position = selections[0]!.getPosition();
			const modelVersion = this.view.viewport.textModel.version;
			const request = this.beginCompletionRequest();
			void this.service.requestTriggerCharacter(
				this.languageId,
				position,
				insertedText,
				{ signal: request.signal },
			).then(outcome => {
				const selections = this.editor.getSelections();
				if (
					!request.signal.aborted &&
					outcome === undefined &&
					refreshIncomplete &&
					this.view.viewport.textModel.version === modelVersion &&
					selections?.length === 1 &&
					selections[0]!.isEmpty() &&
					Position.compare(selections[0]!.getPosition(), position) === 0
				) {
					this.requestCompletion(createLanguageCompletionIncompleteRefreshContext());
				}
			}).catch(error => {
				if (!request.signal.aborted) this.reportRequestError(error);
			}).finally(() => this.releaseCompletionRequest(request));
			return;
		}
		if (refreshIncomplete) this.requestCompletion(createLanguageCompletionIncompleteRefreshContext());
	}

	private requestCompletion(context: LanguageCompletionContext): void {
		const selections = this.editor.getSelections();
		if (!selections || selections.length !== 1 || !selections[0]!.isEmpty()) {
			this.session.cancel();
			return;
		}
		const request = this.beginCompletionRequest();
		try {
			void this.service.request(
				this.languageId,
				selections[0]!.getPosition(),
				context,
				{ signal: request.signal },
			).catch(error => {
				if (!request.signal.aborted) this.reportRequestError(error);
			}).finally(() => this.releaseCompletionRequest(request));
		} catch (error) {
			this.releaseCompletionRequest(request);
			if (!request.signal.aborted) this.reportRequestError(error);
		}
	}

	private beginCompletionRequest(): AbortController {
		this.cancelCompletionRequest();
		const request = new AbortController();
		this.completionRequest = request;
		return request;
	}

	private cancelCompletionRequest(): void {
		this.completionRequest?.abort();
		this.completionRequest = undefined;
	}

	private releaseCompletionRequest(request: AbortController): void {
		if (this.completionRequest === request) this.completionRequest = undefined;
	}

	private reportRequestError(error: unknown): void {
		try {
			this.onRequestError(error);
		} catch (reportingError) {
			console.error('Stanza completion request and error reporting both failed', new AggregateError([error, reportingError]));
		}
	}
}

function reportRequestError(error: unknown): void {
	console.error('Stanza completion request failed', error);
}
