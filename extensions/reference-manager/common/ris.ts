export interface RisField {
	readonly tag: string;
	readonly value: string;
}

export interface RisRecord {
	readonly type: string;
	readonly title: string;
	readonly year: string;
	readonly doi: string;
	readonly journal: string;
	readonly volume: string;
	readonly issue: string;
	readonly startPage: string;
	readonly endPage: string;
	readonly url: string;
	readonly abstract: string;
	readonly authors: readonly string[];
	readonly keywords: readonly string[];
	readonly pdfLinks: readonly string[];
	readonly fields: readonly RisField[];
}

export class RisParseError extends Error {
	constructor(
		readonly code: 'emptyInput' | 'missingType' | 'missingEnd' | 'unexpectedType' | 'invalidTag' | 'limit',
		readonly line: number,
	) {
		super(`${code}:${line}`);
		this.name = 'RisParseError';
	}
}

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_FIELDS = 300;
const MAX_FIELD_CHARS = 131072;

function recordFromFields(fields: readonly RisField[]): RisRecord {
	// Canonical tags outrank aliases, but an empty canonical value must not hide data.
	const first = (...tags: readonly string[]): string => {
		for (const tag of tags) {
			const field = fields.find(field => field.tag === tag && field.value.trim() !== '');
			if (field) {
				return field.value.trim();
			}
		}
		return '';
	};
	const all = (...tags: readonly string[]): readonly string[] => Object.freeze(
		fields.filter(field => tags.includes(field.tag))
			.map(field => field.value.trim()).filter(value => value !== ''),
	);
	const date = first('PY', 'Y1', 'DA');
	return Object.freeze({
		type: first('TY'),
		title: first('TI', 'T1', 'CT'),
		year: /\d{4}/.exec(date)?.[0] ?? date,
		doi: first('DO').replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').trim().toLowerCase(),
		journal: first('T2', 'JO', 'JF'),
		volume: first('VL'),
		issue: first('IS'),
		startPage: first('SP'),
		endPage: first('EP'),
		url: first('UR'),
		abstract: first('AB', 'N2'),
		authors: all('AU', 'A1'),
		keywords: all('KW'),
		pdfLinks: all('L1'),
		fields: Object.freeze(fields.map(field => Object.freeze({ ...field }))),
	});
}

/** Parse RIS as inert text, retaining every field, including TY, ER and unknown tags. */
export function parseRis(text: string): readonly RisRecord[] {
	// Check code units first to avoid allocating an encoding of an already oversized source.
	if (text.length > MAX_SOURCE_BYTES || new TextEncoder().encode(text).length > MAX_SOURCE_BYTES) {
		throw new RisParseError('limit', 1);
	}
	const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
	const records: RisRecord[] = [];
	let fields: RisField[] | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const lineNumber = index + 1;
		if (line.trim() === '') {
			continue;
		}
		// Tag lines cannot be indented; leading whitespace belongs to a continuation.
		const match = /^([A-Z0-9]{2}) +-(?: ?)(.*)$/.exec(line);
		if (!match) {
			if (/^[\t ]/.test(line) && fields && fields.length > 0) {
				const previous = fields[fields.length - 1]!;
				if (previous.tag === 'TY') throw new RisParseError('invalidTag', lineNumber);
				const continuation = line.replace(/^[\t ]+/, '');
				if (previous.value.length + 1 + continuation.length > MAX_FIELD_CHARS) {
					throw new RisParseError('limit', lineNumber);
				}
				fields[fields.length - 1] = { tag: previous.tag, value: `${previous.value}\n${continuation}` };
				continue;
			}
			throw new RisParseError('invalidTag', lineNumber);
		}
		const tag = match[1]!;
		const value = match[2]!;
		if (tag === 'TY') {
			if (fields) {
				throw new RisParseError('unexpectedType', lineNumber);
			}
			if (value.trim() === '') {
				throw new RisParseError('missingType', lineNumber);
			}
			if (records.length >= MAX_RECORDS) {
				throw new RisParseError('limit', lineNumber);
			}
			fields = [];
		}
		if (!fields) {
			throw new RisParseError('missingType', lineNumber);
		}
		if (fields.length >= MAX_FIELDS || value.length > MAX_FIELD_CHARS) {
			throw new RisParseError('limit', lineNumber);
		}
		fields.push({ tag, value });
		if (tag === 'ER') {
			if (value.trim()) throw new RisParseError('invalidTag', lineNumber);
			records.push(recordFromFields(fields));
			fields = undefined;
		}
	}
	if (fields) {
		throw new RisParseError('missingEnd', lines.length);
	}
	if (records.length === 0) {
		throw new RisParseError('emptyInput', 1);
	}
	return Object.freeze(records);
}
