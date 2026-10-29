import { localize } from '../../../src/ash/nls.js';
import { createUuid } from '../../../src/ash/base/common/uuid.js';
import type { RisRecord, RisField } from './ris.js';

export const LIBRARY_CONTENT_TYPE = 'application/vnd.ash.reference-library+json';
export const LIBRARY_EDITOR_ID = 'ash.workbench.referenceLibrary';
export interface LibraryEntry extends RisRecord {
	readonly id: string;
	readonly key: string;
	readonly attachments: readonly string[];
}
export interface ReferenceLibrary { readonly version: 1; readonly id: string; readonly entries: readonly LibraryEntry[]; }
export function emptyLibrary(): ReferenceLibrary { return Object.freeze({ version: 1, id: createUuid(), entries: Object.freeze([]) }); }
const scalarFields = ['type', 'title', 'year', 'doi', 'journal', 'volume', 'issue', 'startPage', 'endPage', 'url', 'abstract'] as const;
const arrayFields = ['authors', 'keywords', 'pdfLinks', 'attachments'] as const;
const maxBytes = 8 * 1024 * 1024;

/** Persistence is an untrusted boundary. The normalized entry fields are authoritative; RIS fields retain provenance only. */
export function parseLibrary(text: string): ReferenceLibrary {
	if (new TextEncoder().encode(text).length > maxBytes) throw libraryError('library.size');
	const value: unknown = JSON.parse(text);
	if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 10000 || Object.keys(value).some(key => !['version', 'id', 'entries'].includes(key))) throw libraryError('library.format');
	if (!bounded(value.id, 128).trim()) throw libraryError('library.id');
	const ids = new Set<string>(); const keys = new Set<string>();
	const entries = value.entries.map((raw: unknown): LibraryEntry => {
		if (!record(raw) || Object.keys(raw).some(key => ![...scalarFields, ...arrayFields, 'id', 'key', 'fields'].includes(key))) throw libraryError('library.entry');
		const id = bounded(raw.id, 128); const key = bounded(raw.key, 128).trim();
		if (!id || !key || /[\u0000-\u001f\u007f]/u.test(key) || ids.has(id) || keys.has(key)) throw libraryError('library.duplicate');
		ids.add(id); keys.add(key);
		const result: Record<string, unknown> = { id, key };
		for (const field of scalarFields) result[field] = bounded(raw[field], field === 'abstract' ? 131072 : 16384);
		result.doi = canonicalDoi(result.doi as string);
		for (const field of arrayFields) {
			if (!Array.isArray(raw[field]) || raw[field].length > 1000) throw libraryError('library.field');
			result[field] = Object.freeze(raw[field].map((item: unknown) => bounded(item, 16384)));
		}
		if (!Array.isArray(raw.fields) || raw.fields.length > 300) throw libraryError('library.fields');
		result.fields = Object.freeze(raw.fields.map((field: unknown): RisField => {
			if (!record(field) || Object.keys(field).some(key => !['tag', 'value'].includes(key)) || typeof field.tag !== 'string' || !/^[A-Z0-9]{2}$/u.test(field.tag)) throw libraryError('library.field');
			return Object.freeze({ tag: field.tag, value: bounded(field.value, 131072) });
		}));
		return Object.freeze(result) as unknown as LibraryEntry;
	});
	return Object.freeze({ version: 1, id: bounded(value.id, 128), entries: Object.freeze(entries) });
}
export function serializeLibrary(library: ReferenceLibrary): string {
	const text = JSON.stringify(library, null, 2) + '\n';
	parseLibrary(text);
	return text;
}
export function canonicalDoi(value: string): string { return value.trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu, '').toLowerCase(); }
function identity(entry: RisRecord): string {
	return canonicalDoi(entry.doi) ? `doi:${canonicalDoi(entry.doi)}` : JSON.stringify([entry.type, entry.title, entry.year, entry.authors.join(';')]).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
}
export function importRecords(library: ReferenceLibrary, records: readonly RisRecord[]): { library: ReferenceLibrary; added: number; duplicates: number; } {
	const known = new Set(library.entries.map(identity)); const keys = new Set(library.entries.map(entry => entry.key)); const entries = [...library.entries]; let duplicates = 0;
	for (const record of records) {
		const fingerprint = identity(record);
		if (known.has(fingerprint)) { duplicates++; continue; }
		known.add(fingerprint);
		const id = createUuid();
		const base = `${record.authors[0]?.split(',')[0] ?? record.title.split(/\s/u)[0] ?? 'reference'}${record.year}`.normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 100) || 'reference';
		let key = base; let index = 2; while (keys.has(key)) key = `${base}-${index++}`;
		keys.add(key);
		entries.push(Object.freeze({ ...record, id, key, attachments: Object.freeze([]) }));
	}
	const next = parseLibrary(serializeLibrary({ ...library, entries }));
	return { library: next, added: entries.length - library.entries.length, duplicates };
}
export function replaceEntry(library: ReferenceLibrary, entry: LibraryEntry): ReferenceLibrary {
	const entries = library.entries.some(value => value.id === entry.id) ? library.entries.map(value => value.id === entry.id ? entry : value) : [...library.entries, entry];
	return parseLibrary(serializeLibrary({ ...library, entries }));
}
export function formatReference(entry: LibraryEntry): string {
	return [entry.authors.join('; '), entry.year ? `(${entry.year})` : '', entry.title, [entry.journal, entry.volume, entry.issue ? `(${entry.issue})` : '', [entry.startPage, entry.endPage].filter(Boolean).join('–')].filter(Boolean).join(', '), entry.doi ? `https://doi.org/${canonicalDoi(entry.doi)}` : entry.url].filter(Boolean).join('. ');
}
function bounded(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw libraryError('library.field'); return value; }
function record(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function createLibraryEntry(): LibraryEntry {
	const id = createUuid();
	return { id, key: `reference-${id.slice(0, 8)}`, type: 'GEN', title: '', authors: [], year: '', doi: '', journal: '', volume: '', issue: '', startPage: '', endPage: '', url: '', abstract: '', keywords: [], pdfLinks: [], attachments: [], fields: [] };
}

function libraryError(code: string): TypeError {
	return new TypeError(code === 'library.duplicate' ? localize('references.duplicateKey', 'Reference keys and identities must be non-empty and unique.') : code === 'library.size' ? localize('references.libraryLimit', 'Reference library files cannot exceed {0} MiB.', 8) : localize('references.invalidLibrary', 'The reference library is invalid or uses an unsupported format.'));
}
