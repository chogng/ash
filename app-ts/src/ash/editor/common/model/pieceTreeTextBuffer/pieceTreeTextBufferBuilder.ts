import { CharCode } from '../../../../base/common/charCode.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { containsRTL, isBasicASCII } from '../../../../base/common/strings.js';
import { DefaultEndOfLine, type ITextBuffer, type ITextBufferBuilder, type ITextBufferFactory } from '../../model.js';
import { PieceTreeTextBuffer } from './pieceTreeTextBuffer.js';

class PieceTreeTextBufferFactory implements ITextBufferFactory {
	constructor(
		private readonly _chunks: string[],
		private readonly _bom: string,
		private readonly _cr: number,
		private readonly _lf: number,
		private readonly _crlf: number,
		private readonly _containsRTL: boolean,
		private readonly _containsUnusualLineTerminators: boolean,
		private readonly _isBasicASCII: boolean,
		private readonly _normalizeEOL: boolean,
	) {}

	private _getEOL(defaultEOL: DefaultEndOfLine): '\r\n' | '\n' {
		const totalEOLCount = this._cr + this._lf + this._crlf;
		if (totalEOLCount === 0) return defaultEOL === DefaultEndOfLine.LF ? '\n' : '\r\n';
		return this._cr + this._crlf > totalEOLCount / 2 ? '\r\n' : '\n';
	}

	create(defaultEOL: DefaultEndOfLine): { textBuffer: PieceTreeTextBuffer; disposable: IDisposable } {
		const eol = this._getEOL(defaultEOL);
		let value = this._chunks.join('');
		if (this._normalizeEOL) value = value.replace(/\r\n|\r|\n/g, eol);
		const textBuffer = new PieceTreeTextBuffer(value, eol, this._bom, this._normalizeEOL);
		return { textBuffer, disposable: textBuffer };
	}

	getFirstLineText(lengthLimit: number): string {
		if (!Number.isSafeInteger(lengthLimit) || lengthLimit < 0) throw new RangeError('First-line length limit must be a non-negative safe integer');
		return this._chunks.join('').slice(0, lengthLimit).split(/\r\n|\r|\n/, 1)[0]!;
	}
}

export class PieceTreeTextBufferBuilder implements ITextBufferBuilder {
	private readonly chunks: string[];
	private BOM: string;
	private _hasPreviousChar: boolean;
	private _previousChar: number;
	private readonly _tmpLineStarts: number[];
	private cr: number;
	private lf: number;
	private crlf: number;
	private containsRTL: boolean;
	private containsUnusualLineTerminators: boolean;
	private isBasicASCII: boolean;

	constructor() {
		this.chunks = [];
		this.BOM = '';
		this._hasPreviousChar = false;
		this._previousChar = 0;
		this._tmpLineStarts = [];
		this.cr = 0;
		this.lf = 0;
		this.crlf = 0;
		this.containsRTL = false;
		this.containsUnusualLineTerminators = false;
		this.isBasicASCII = true;
	}

	acceptChunk(chunk: string): void {
		if (chunk.length === 0) return;
		if (this.chunks.length === 0 && !this._hasPreviousChar && chunk.startsWith('\uFEFF')) {
			this.BOM = '\uFEFF';
			chunk = chunk.slice(1);
		}
		const lastCharacter = chunk.charCodeAt(chunk.length - 1);
		if (lastCharacter === CharCode.CarriageReturn || (lastCharacter >= 0xD800 && lastCharacter <= 0xDBFF)) {
			this._acceptChunk1(chunk.slice(0, -1), false);
			this._hasPreviousChar = true;
			this._previousChar = lastCharacter;
		} else {
			this._acceptChunk1(chunk, false);
			this._hasPreviousChar = false;
			this._previousChar = lastCharacter;
		}
	}

	private _acceptChunk1(chunk: string, allowEmptyStrings: boolean): void {
		if (!allowEmptyStrings && chunk.length === 0) return;
		this._acceptChunk2(this._hasPreviousChar ? String.fromCharCode(this._previousChar) + chunk : chunk);
	}

	private _acceptChunk2(chunk: string): void {
		this.chunks.push(chunk);
		for (let index = 0; index < chunk.length; index++) {
			const character = chunk.charCodeAt(index);
			if (character === CharCode.CarriageReturn) {
				if (chunk.charCodeAt(index + 1) === CharCode.LineFeed) {
					this.crlf++;
					index++;
				} else this.cr++;
			} else if (character === CharCode.LineFeed) this.lf++;
		}
		if (!isBasicASCII(chunk)) {
			this.isBasicASCII = false;
			if (!this.containsRTL) this.containsRTL = containsRTL(chunk);
			if (!this.containsUnusualLineTerminators) this.containsUnusualLineTerminators = chunk.includes('\u2028') || chunk.includes('\u2029');
		}
	}

	finish(normalizeEOL = true): PieceTreeTextBufferFactory {
		this._finish();
		return new PieceTreeTextBufferFactory(
			this.chunks,
			this.BOM,
			this.cr,
			this.lf,
			this.crlf,
			this.containsRTL,
			this.containsUnusualLineTerminators,
			this.isBasicASCII,
			normalizeEOL,
		);
	}

	private _finish(): void {
		if (this.chunks.length === 0) this._acceptChunk1('', true);
		if (!this._hasPreviousChar) return;
		this._hasPreviousChar = false;
		this._acceptChunk2(String.fromCharCode(this._previousChar));
	}
}

/** Selects the private TextBuffer implementation used by TextModel and worker mirrors. */
export function createPieceTreeTextBuffer(text: string, defaultEOL: DefaultEndOfLine = DefaultEndOfLine.LF): ITextBuffer {
	const builder = new PieceTreeTextBufferBuilder();
	builder.acceptChunk(text);
	return builder.finish().create(defaultEOL).textBuffer;
}
