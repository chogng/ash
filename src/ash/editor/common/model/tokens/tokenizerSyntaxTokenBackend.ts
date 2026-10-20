import { runWhenGlobalIdle } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { TextModelChange } from '../../core/textChange.js';
import type { IState, ITokenizationSupport, ILanguageIdCodec, Token } from '../../languages.js';
import { appendLanguageTokens } from '../../languages/supports/tokenization.js';
import type { LanguageToken } from '../../tokens/languageTokens.js';
import type { TextModel } from '../textModel.js';

interface TokenizedLine {
	readonly modelVersion: number;
	readonly text: string;
	readonly hasEOL: boolean;
	readonly inputState: IState;
	readonly endState: IState;
	readonly tokens: readonly Token[] | Uint32Array;
	readonly rawTokens?: readonly Token[];
	readonly tokenCount: number;
	readonly accurate: boolean;
	readonly invalidated?: boolean;
}

/** Owns per-line lexical states; viewport work and idle work publish into the same cache. */
export class TokenizerSyntaxTokenBackend extends Disposable {
	private lineData: (TokenizedLine | undefined)[] = [];
	private firstInvalidLine = 1;
	private reusableThroughLine = 0;
	private lastChangedLine = 0;
	private lastProcessedLine = 0;
	private _tokenCount = 0;
	private readonly idle = this._register(new MutableDisposable());
	private readonly changeEmitter = this._register(new Emitter<readonly { fromLineNumber: number; toLineNumber: number; }[]>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	public readonly onDidChangeTokens = this.changeEmitter.event;
	public readonly onDidEncounterError = this.errorEmitter.event;

	constructor(private readonly model: TextModel, private readonly support: ITokenizationSupport, private readonly codec: ILanguageIdCodec) {
		super();
		this._register(model.onDidChangeContent(change => this.acceptChanges(change)));
		this._register(model.onDidChangeAttached(() => this.scheduleBackground()));
	}

	public hasAccurateTokensForLine(lineNumber: number): boolean {
		return lineNumber < this.firstInvalidLine;
	}

	public isCheapToTokenize(lineNumber: number): boolean {
		return this.hasAccurateTokensForLine(lineNumber) || (lineNumber === this.firstInvalidLine && this.model.getLineLength(lineNumber) < 2048);
	}

	public get tokenCount(): number {
		return this._tokenCount;
	}

	public getLanguageTokens(lineNumber: number): readonly LanguageToken[] {
		const data = this.lineData[lineNumber - 1];
		if (!data) {
			return [];
		}
		const tokens: LanguageToken[] = [];
		appendLanguageTokens(tokens, data.tokens, lineNumber, this.model.getLineContent(lineNumber), this.codec, data.rawTokens);
		return tokens;
	}

	public get lines(): readonly { lineIndex: number; tokens: readonly LanguageToken[]; }[] {
		const lines: { lineIndex: number; tokens: readonly LanguageToken[]; }[] = [];
		this.lineData.forEach((data, lineIndex) => {
			if (data) {
				lines.push({ lineIndex, tokens: this.getLanguageTokens(lineIndex + 1) });
			}
		});
		return lines;
	}

	public forceTokenization(lineNumber: number): void {
		const start = this.firstInvalidLine;
		while (this.firstInvalidLine <= lineNumber) {
			this.tokenizeNextLine();
		}
		if (start <= lineNumber) {
			this.changeEmitter.fire([{ fromLineNumber: start, toLineNumber: this.lastProcessedLine }]);
		}
		this.scheduleBackground();
	}

	public refreshRange(startLineNumber: number, endLineNumber: number): void {
		// A retained viewport can outlive a content reset until layout publishes its new range.
		startLineNumber = Math.min(startLineNumber, this.model.getLineCount());
		endLineNumber = Math.min(endLineNumber, this.model.getLineCount());
		if (endLineNumber < this.firstInvalidLine) {
			return;
		}
		let prepared = true;
		for (let line = startLineNumber; line <= endLineNumber; line++) {
			if (this.lineData[line - 1]?.modelVersion !== this.model.version) {
				prepared = false;
				break;
			}
		}
		if (prepared) {
			return;
		}
		if (startLineNumber <= this.firstInvalidLine) {
			this.forceTokenization(endLineNumber);
			return;
		}
		// A distant viewport has no confirmed incoming state yet. Publish its local
		// calculation immediately; the ordered background pass confirms multiline context.
		this.reusableThroughLine = Math.min(this.reusableThroughLine, startLineNumber - 1);
		let state = this.lineData[startLineNumber - 2]?.endState ?? this.support.getInitialState();
		for (let line = startLineNumber; line <= endLineNumber; line++) {
			const data = this.tokenizeLine(line, state, false);
			this.setLineData(line, data);
			state = data.endState;
		}
		this.changeEmitter.fire([{ fromLineNumber: startLineNumber, toLineNumber: endLineNumber }]);
		this.scheduleBackground();
	}

	public tokenizeLinesAt(lineNumber: number, lines: readonly string[]): readonly LanguageToken[][] {
		if (lineNumber > 1) {
			this.forceTokenization(lineNumber - 1);
		}
		let state = lineNumber === 1 ? this.support.getInitialState() : this.lineData[lineNumber - 2]!.endState;
		return lines.map((text, index) => {
			const result = this.support.tokenizeEncoded
				? this.support.tokenizeEncoded(text, index + 1 < lines.length, state.clone())
				: this.support.tokenize(text, index + 1 < lines.length, state.clone());
			state = result.endState;
			const tokens: LanguageToken[] = [];
			appendLanguageTokens(tokens, result.tokens, index + 1, text, this.codec, 'rawTokens' in result ? result.rawTokens : undefined);
			return tokens;
		});
	}

	private tokenizeLine(lineNumber: number, state: IState, accurate: boolean): TokenizedLine {
		const text = this.model.getLineContent(lineNumber);
		const hasEOL = lineNumber < this.model.getLineCount();
		const result = this.support.tokenizeEncoded
			? this.support.tokenizeEncoded(text, hasEOL, state.clone())
			: this.support.tokenize(text, hasEOL, state.clone());
		const rawTokens = 'rawTokens' in result ? result.rawTokens : undefined;
		const languageTokens: LanguageToken[] = [];
		appendLanguageTokens(languageTokens, result.tokens, lineNumber, text, this.codec, rawTokens);
		return {
			modelVersion: this.model.version,
			text,
			hasEOL,
			inputState: state.clone(),
			endState: result.endState.clone(),
			tokens: result.tokens,
			rawTokens,
			tokenCount: languageTokens.length,
			accurate,
		};
	}

	private setLineData(lineNumber: number, data: TokenizedLine): void {
		this._tokenCount += data.tokenCount - (this.lineData[lineNumber - 1]?.tokenCount ?? 0);
		this.lineData[lineNumber - 1] = data;
	}

	private tokenizeNextLine(): void {
		const line = this.firstInvalidLine;
		this.lastProcessedLine = line;
		const state = line === 1 ? this.support.getInitialState() : this.lineData[line - 2]!.endState;
		const previous = this.lineData[line - 1];
		const reusable = previous?.accurate && !previous.invalidated
			&& previous.text === this.model.getLineContent(line)
			&& previous.hasEOL === (line < this.model.getLineCount())
			&& previous.inputState.equals(state);
		const data = reusable ? previous : this.tokenizeLine(line, state, true);
		this.setLineData(line, data);
		this.firstInvalidLine = previous?.accurate && line >= this.lastChangedLine && previous.endState.equals(data.endState)
			? Math.max(line, this.reusableThroughLine) + 1 : line + 1;
		this.reusableThroughLine = Math.max(this.reusableThroughLine, line);
		if (this.firstInvalidLine > this.model.getLineCount()) {
			this.lastChangedLine = 0;
		}
	}

	private acceptChanges(change: TextModelChange): void {
		if (change.isEolChange) {
			return;
		}
		for (const entry of [...change.changes].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber)) {
			const start = entry.range.startLineNumber;
			const end = entry.range.endLineNumber;
			const added = entry.text.split('\n').length;
			const delta = added - (end - start + 1);
			const candidate = this.lineData[end - 1];
			const replacement: (TokenizedLine | undefined)[] = new Array(added).fill(undefined);
			// Retain the previous outgoing state at the edit boundary to detect convergence.
			replacement[added - 1] = candidate && { ...candidate, tokens: [], rawTokens: undefined, tokenCount: 0, invalidated: true };
			for (let line = start; line <= end; line++) {
				this._tokenCount -= this.lineData[line - 1]?.tokenCount ?? 0;
			}
			this.lineData = this.lineData.slice(0, start - 1).concat(replacement, this.lineData.slice(end));
			this.reusableThroughLine = this.reusableThroughLine >= end
				? this.reusableThroughLine + delta : Math.min(this.reusableThroughLine, start - 1);
			this.lastChangedLine = Math.max(start + added - 1, this.lastChangedLine >= end ? this.lastChangedLine + delta : this.lastChangedLine);
			this.firstInvalidLine = Math.min(this.firstInvalidLine, start);
		}
		this.changeEmitter.fire(change.changes.map(entry => ({
			fromLineNumber: entry.range.startLineNumber,
			toLineNumber: Math.min(this.model.getLineCount(), entry.range.startLineNumber + entry.text.split('\n').length - 1),
		})));
		this.scheduleBackground();
	}

	private scheduleBackground(): void {
		if (!this.model.isAttachedToEditor() || this.firstInvalidLine > this.model.getLineCount()) {
			this.idle.clear();
			return;
		}
		if (this.idle.value) {
			return;
		}
		this.idle.value = runWhenGlobalIdle(() => {
			this.idle.clear();
			const start = this.firstInvalidLine;
			const began = performance.now();
			try {
				do {
					this.tokenizeNextLine();
				} while (this.firstInvalidLine <= this.model.getLineCount() && this.firstInvalidLine - start < 100 && performance.now() - began < 1);
				this.changeEmitter.fire([{ fromLineNumber: start, toLineNumber: this.lastProcessedLine }]);
				this.scheduleBackground();
			} catch (error) {
				this.errorEmitter.fire(error);
			}
		}, 100);
	}
}
