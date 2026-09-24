type NotSyncHashable = ArrayBufferLike | ArrayBufferView;

export function hash<T>(value: T extends NotSyncHashable ? never : T): number {
	return doHash(value, 0);
}

export function doHash(value: unknown, initialHash: number): number {
	if (value === null) return numberHash(349, initialHash);
	switch (typeof value) {
		case 'string': return stringHash(value, initialHash);
		case 'number': return numberHash(value, initialHash);
		case 'boolean': return numberHash(value ? 433 : 863, initialHash);
		case 'undefined': return numberHash(937, initialHash);
		case 'object': return Array.isArray(value) ? arrayHash(value, initialHash) : objectHash(value, initialHash);
		default: return numberHash(617, initialHash);
	}
}

export function numberHash(value: number, initialHash: number): number {
	return (((initialHash << 5) - initialHash) + value) | 0;
}

export function stringHash(value: string, initialHash: number): number {
	let result = numberHash(149_417, initialHash);
	for (let index = 0; index < value.length; index += 1) result = numberHash(value.charCodeAt(index), result);
	return result;
}

export class StringSHA1 {
	private readonly chunks: string[] = [];
	private digestValue: string | undefined;

	update(value: string): void {
		if (this.digestValue !== undefined) throw new ReferenceError('SHA-1 digest is already finalized');
		this.chunks.push(value);
	}

	digest(): string {
		this.digestValue ??= sha1(new TextEncoder().encode(this.chunks.join('')));
		return this.digestValue;
	}
}

function arrayHash(values: readonly unknown[], initialHash: number): number {
	return values.reduce<number>((result, value) => doHash(value, result), numberHash(104_579, initialHash));
}

function objectHash(value: object, initialHash: number): number {
	let result = numberHash(181_387, initialHash);
	for (const key of Object.keys(value).sort()) {
		result = stringHash(key, result);
		result = doHash((value as Record<string, unknown>)[key], result);
	}
	return result;
}

function sha1(input: Uint8Array): string {
	const byteLength = input.byteLength;
	const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
	const bytes = new Uint8Array(paddedLength);
	bytes.set(input);
	bytes[byteLength] = 0x80;
	let bitLength = BigInt(byteLength) * 8n;
	for (let index = 0; index < 8; index += 1) {
		bytes[paddedLength - 1 - index] = Number(bitLength & 0xffn);
		bitLength >>= 8n;
	}
	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const words = new Uint32Array(80);
	for (let offset = 0; offset < bytes.length; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			const start = offset + index * 4;
			words[index] = ((bytes[start]! << 24) | (bytes[start + 1]! << 16) | (bytes[start + 2]! << 8) | bytes[start + 3]!) >>> 0;
		}
		for (let index = 16; index < 80; index += 1) words[index] = rotateLeft(words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!, 1);
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let index = 0; index < 80; index += 1) {
			let f: number;
			let k: number;
			if (index < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
			else if (index < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
			else if (index < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
			else { f = b ^ c ^ d; k = 0xca62c1d6; }
			const next = (rotateLeft(a, 5) + f + e + k + words[index]!) | 0;
			e = d; d = c; c = rotateLeft(b, 30); b = a; a = next;
		}
		h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
	}
	return [h0, h1, h2, h3, h4].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

function rotateLeft(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}
