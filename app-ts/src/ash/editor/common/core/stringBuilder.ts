/** Decodes UTF-16LE code units without dropping a leading BOM. */
let platformTextDecoder: TextDecoder | undefined;

export function getPlatformTextDecoder(): TextDecoder {
	return platformTextDecoder ??= new TextDecoder('UTF-16LE');
}

export function decodeUTF16LE(source: Uint8Array, offset: number, length: number): string {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length * 2 > source.length) throw new RangeError("Invalid UTF-16LE slice");
	const chunks: string[] = [];
	const chunkSize = 4096;
	for (let start = 0; start < length; start += chunkSize) {
		const end = Math.min(length, start + chunkSize);
		const codes = new Array<number>(end - start);
		for (let index = start; index < end; index += 1) codes[index - start] = source[offset + index * 2]! | source[offset + index * 2 + 1]! << 8;
		chunks.push(String.fromCharCode(...codes));
	}
	return chunks.join("");
}

/** A reusable UTF-16 chunk builder for tokenization and piece-tree assembly. */
export class StringBuilder {
	private readonly _capacity: number;
	private readonly _buffer: Uint16Array;
	private _completedStrings: string[] | null = null;
	private _bufferLength: number = 0;

	constructor(capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("StringBuilder capacity must be positive");
		this._capacity = capacity | 0;
		this._buffer = new Uint16Array(this._capacity);
	}

	reset(): void {
		this._completedStrings = null;
		this._bufferLength = 0;
	}

	build(): string {
		if (this._completedStrings !== null) {
			this._flushBuffer();
			return this._completedStrings.join('');
		}
		return this._buildBuffer();
	}

	private _buildBuffer(): string {
		if (this._bufferLength === 0) return '';
		return getPlatformTextDecoder().decode(new Uint16Array(this._buffer.buffer, 0, this._bufferLength));
	}

	appendCharCode(charCode: number): void {
		if (!Number.isSafeInteger(charCode) || charCode < 0 || charCode > 0xffff) throw new RangeError("Character code must be a UTF-16 code unit");
		const remainingSpace = this._capacity - this._bufferLength;
		if (remainingSpace <= 1 && (remainingSpace === 0 || charCode >= 0xD800 && charCode <= 0xDBFF)) this._flushBuffer();
		this._buffer[this._bufferLength++] = charCode;
	}

	appendASCIICharCode(charCode: number): void {
		if (!Number.isSafeInteger(charCode) || charCode < 0 || charCode > 0x7f) throw new RangeError("Character code must be ASCII");
		if (this._bufferLength === this._capacity) this._flushBuffer();
		this._buffer[this._bufferLength++] = charCode;
	}

	appendString(value: string): void {
		if (this._bufferLength + value.length >= this._capacity) {
			this._flushBuffer();
			this._completedStrings!.push(value);
			return;
		}
		for (let index = 0; index < value.length; index += 1) this._buffer[this._bufferLength++] = value.charCodeAt(index);
	}

	private _flushBuffer(): void {
		const value = this._buildBuffer();
		this._bufferLength = 0;
		if (this._completedStrings === null) this._completedStrings = [value];
		else this._completedStrings.push(value);
	}
}
