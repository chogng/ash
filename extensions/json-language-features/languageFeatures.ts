import { createScanner, SyntaxKind, parse, type ParseError } from 'jsonc-parser';
import * as jsonNamespace from 'vscode-json-languageservice';
import type { Position, JSONSchema } from 'vscode-json-languageservice';
import type { JsonSchemaContribution } from '@ash/sdk';

const { getLanguageService, TextDocument } = (jsonNamespace as typeof jsonNamespace & { default?: typeof jsonNamespace; }).default ?? jsonNamespace;

export interface JsonDocumentSnapshot {
	readonly uri: string;
	readonly languageId: string;
	readonly version: number;
	readonly text: string;
}

/** The extension owns language analysis; documents and contributed schemas remain host-owned. */
export class JsonLanguageFeatures {
	private readonly readSchemas: () => Promise<readonly JsonSchemaContribution[]>;
	// Only host-contributed schemas are available; the extension has no network capability.
	private readonly service = getLanguageService({});
	private generation = 0;
	private configured: Promise<void> | undefined;

	constructor(readSchemas: () => Promise<readonly JsonSchemaContribution[]>) { this.readSchemas = readSchemas; }

	invalidateSchemas(): void { this.generation++; this.configured = undefined; }

	private configure(): Promise<void> {
		if (!this.configured) {
			const generation = this.generation;
			this.configured = this.readSchemas().then(schemas => {
				if (generation !== this.generation) return this.configure();
				this.service.configure({ validate: true, schemas: schemas.map(value => ({ uri: value.uri, fileMatch: [...value.fileMatch], schema: value.schema as JSONSchema })) });
			}).catch(error => { this.configured = undefined; throw error; });
		}
		return this.configured;
	}

	async complete(snapshot: JsonDocumentSnapshot, position: Position) {
		await this.configure();
		const document = this.analysisDocument(snapshot, position);
		if (!document) return undefined;
		const parsed = this.service.parseJSONDocument(document);
		const offset = document.offsetAt(position);
		const node = parsed.getNodeFromOffset(offset, true);
		// At the end of a populated container, offering its default would insert a second value.
		if (node && (node.type === 'array' || node.type === 'object') && node.offset + node.length === offset && /[\]}]/u.test(snapshot.text[offset - 1] ?? '')) return undefined;
		return this.service.doComplete(document, position, parsed);
	}

	async hover(snapshot: JsonDocumentSnapshot, position: Position) {
		await this.configure();
		const document = this.analysisDocument(snapshot, position);
		if (!document) return undefined;
		return this.service.doHover(document, position, this.service.parseJSONDocument(document));
	}

	private analysisDocument(snapshot: JsonDocumentSnapshot, position: Position) {
		const document = TextDocument.create(snapshot.uri, snapshot.languageId, snapshot.version, snapshot.text);
		const offset = document.offsetAt(position);
		const scanner = createScanner(snapshot.text);
		const parts: string[] = [];
		let previous = 0;
		for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
			if (token !== SyntaxKind.LineCommentTrivia && token !== SyntaxKind.BlockCommentTrivia) continue;
			const start = scanner.getTokenOffset();
			const end = start + scanner.getTokenLength();
			const closedBlock = token === SyntaxKind.BlockCommentTrivia && snapshot.text.slice(end - 2, end) === '*/';
			if (offset >= start && (offset < end || (offset === end && !closedBlock))) return undefined;
			// Preserve UTF-16 offsets, including surrogate pairs, while avoiding the
			// language service's inclusive comment-end boundary.
			parts.push(snapshot.text.slice(previous, start), snapshot.text.slice(start, end).replace(/[^\r\n]/gu, character => ' '.repeat(character.length)));
			previous = end;
		}
		return parts.length ? TextDocument.create(snapshot.uri, snapshot.languageId, snapshot.version, parts.join('') + snapshot.text.slice(previous)) : document;
	}

	format(snapshot: JsonDocumentSnapshot, options: { tabSize: number; insertSpaces: boolean; }) {
		const errors: ParseError[] = [];
		parse(snapshot.text, errors, { disallowComments: snapshot.languageId === 'json', allowTrailingComma: snapshot.languageId === 'jsonc' });
		if (errors.length) return [];
		return this.service.format(TextDocument.create(snapshot.uri, snapshot.languageId, snapshot.version, snapshot.text), undefined, options);
	}

	async validate(snapshot: JsonDocumentSnapshot) {
		await this.configure();
		const document = TextDocument.create(snapshot.uri, snapshot.languageId, snapshot.version, snapshot.text);
		const syntax = snapshot.languageId === 'jsonc' ? 'ignore' : 'error';
		return this.service.doValidation(document, this.service.parseJSONDocument(document), { comments: syntax, trailingCommas: syntax, schemaValidation: 'warning' });
	}
}
