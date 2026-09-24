let textEncoder: TextEncoder | undefined;
let textDecoder: TextDecoder | undefined;

export class VSBuffer {
	public static alloc(byteLength: number): VSBuffer {
		return new VSBuffer(new Uint8Array(byteLength));
	}

	public static wrap(actual: Uint8Array<ArrayBuffer>): VSBuffer {
		return new VSBuffer(actual);
	}

	public static fromString(source: string): VSBuffer {
		textEncoder ??= new TextEncoder();
		return new VSBuffer(textEncoder.encode(source));
	}

	public static concat(buffers: readonly VSBuffer[], totalLength?: number): VSBuffer {
		if (totalLength === undefined) {
			totalLength = buffers.reduce((length, buffer) => length + buffer.byteLength, 0);
		}

		const result = VSBuffer.alloc(totalLength);
		let offset = 0;
		for (const buffer of buffers) {
			result.set(buffer, offset);
			offset += buffer.byteLength;
		}
		return result;
	}

	public readonly byteLength: number;

	private constructor(public readonly buffer: Uint8Array<ArrayBuffer>) {
		this.byteLength = buffer.byteLength;
	}

	public toString(): string {
		textDecoder ??= new TextDecoder(undefined, { ignoreBOM: true });
		return textDecoder.decode(this.buffer);
	}

	public slice(start?: number, end?: number): VSBuffer {
		return new VSBuffer(this.buffer.subarray(start, end));
	}

	public set(array: VSBuffer | Uint8Array<ArrayBuffer>, offset?: number): void {
		this.buffer.set(array instanceof VSBuffer ? array.buffer : array, offset);
	}
}

/** Decodes base64 to a buffer. URL-encoded and unpadded base64 is allowed. */
export function decodeBase64(encoded: string): VSBuffer {
	let building = 0;
	let remainder = 0;
	let bufferIndex = 0;
	const buffer = new Uint8Array(Math.floor(encoded.length / 4 * 3));

	const append = (value: number): void => {
		switch (remainder) {
			case 3:
				buffer[bufferIndex++] = building | value;
				remainder = 0;
				break;
			case 2:
				buffer[bufferIndex++] = building | (value >>> 2);
				building = value << 6;
				remainder = 3;
				break;
			case 1:
				buffer[bufferIndex++] = building | (value >>> 4);
				building = value << 4;
				remainder = 2;
				break;
			default:
				building = value << 2;
				remainder = 1;
		}
	};

	for (let index = 0; index < encoded.length; index += 1) {
		const code = encoded.charCodeAt(index);
		if (code >= 65 && code <= 90) {
			append(code - 65);
		} else if (code >= 97 && code <= 122) {
			append(code - 97 + 26);
		} else if (code >= 48 && code <= 57) {
			append(code - 48 + 52);
		} else if (code === 43 || code === 45) {
			append(62);
		} else if (code === 47 || code === 95) {
			append(63);
		} else if (code === 61) {
			break;
		} else {
			throw new SyntaxError(`Unexpected base64 character ${encoded[index]}`);
		}
	}

	const unpaddedLength = bufferIndex;
	while (remainder > 0) {
		append(0);
	}
	return VSBuffer.wrap(buffer).slice(0, unpaddedLength);
}

const hexChars = '0123456789abcdef';

export function encodeHex({ buffer }: VSBuffer): string {
	let result = '';
	for (let index = 0; index < buffer.length; index += 1) {
		const byte = buffer[index]!;
		result += hexChars[byte >>> 4];
		result += hexChars[byte & 0x0f];
	}
	return result;
}
