import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { createDefaultDocumentSchema } from '../../common/model/documentSchema.js';
import type { DocumentNode } from '../../common/model/document.js';
import { documentToPlainText } from '../../common/model/documentSerialization.js';
import { DocumentConversionError, exportDocumentText, importDocumentText } from '../../browser/documentImportExport.js';
import { resetNlsResolver, setNlsMessages } from '../../../../src/ash/nls.js';
import messages from '../../../language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { generalProfile } from '../../browser/generalProfile.js';

const environment = new JSDOM('<!doctype html>');
suiteTeardown(() => environment.window.close());
const source = URI.file('/notes/source.md');

test('Academy imports local image assets through host IO once and retains remote images', async () => {
	const reads: string[] = [];
	const profile = generalProfile.create();
	const document = await profile.importText('![A](figure.png) ![B](figure.png) ![Remote](https://example.com/figure.png)', 'markdown', environment.window.document, source, async resource => {
		reads.push(resource.toString());
		return new Uint8Array([0, 127, 255]);
	});
	const images = document.content[0]!.content.filter(node => node.type === 'image');
	assert.deepEqual(reads, ['file:///notes/figure.png']);
	assert.deepEqual(images.map(node => node.attrs.src), ['data:image/png;base64,AH//', 'data:image/png;base64,AH//', 'https://example.com/figure.png']);
	profile.codec.validate(document);
	await assert.rejects(async () => profile.importText('![Unsupported](figure.svg)', 'markdown', environment.window.document, source, async () => {
		throw new Error('Unsupported images must be rejected before IO');
	}), error => error instanceof DocumentConversionError && error.feature === 'image resource');
});

function semantics(node: DocumentNode): unknown {
	return { type: node.type, attrs: node.attrs, marks: node.marks, ...(node.text === undefined ? {} : { text: node.text }), content: node.content.map(semantics) };
}

test('Markdown conversion preserves supported block and inline semantics through export and reimport', () => {
	const schema = createDefaultDocumentSchema();
	const input = '# Heading\n\nA **bold** and *italic* [link](<https://example.com/a%20b>) and `code`.\n\n> Quote\n\n3. One\n4. Two\n\n- First\n- Second\n\n```ts\nconst n = 1;\n```\n\n---\n\n| A | B |\n| --- | --- |\n| x | y |\n';
	const document = importDocumentText(input, 'markdown', schema, environment.window.document, source);
	assert.deepEqual(document.content.map(node => node.type), ['heading', 'paragraph', 'blockquote', 'orderedList', 'bulletList', 'codeBlock', 'horizontalRule', 'table']);
	const output = exportDocumentText(document, schema, 'markdown');
	assert.deepEqual(semantics(importDocumentText(output, 'markdown', schema, environment.window.document, source)), semantics(document));
	assert.ok(output.includes('https://example.com/a%20b'));
});

test('Markdown imports resolve image identity against the source and decode text entities', () => {
	const schema = createDefaultDocumentSchema();
	const document = importDocumentText('A &amp; B &copy; ![Figure](images/one%20two.png)', 'markdown', schema, environment.window.document, source);
	assert.equal(document.content[0]!.content[0]!.text, 'A & B © ');
	assert.deepEqual(document.content[0]!.content[1]!.attrs, { src: 'file:///notes/images/one%20two.png', alt: 'Figure' });
	assert.equal(documentToPlainText(document), 'A & B © Figure');
});

for (const [feature, cell] of [
	['text', 'left\\|right'],
	['code', '``left\\|`middle\\|right``'],
	['link destination', '[link](<https://example.com/left\\|right?q=one\\|two>)'],
	['image destination', '![image](<https://example.com/left\\|right.png>)'],
] as const) {
	test(`Markdown table round trips ${feature} pipes without losing later cells`, () => {
		const schema = createDefaultDocumentSchema();
		const input = `| ${cell} | Header after pipe |\n| --- | --- |\n| ${cell} | Body after pipe |\n\n${cell.replaceAll('\\|', '|')}\n`;
		const document = importDocumentText(input, 'markdown', schema, environment.window.document, source);
		const before = semantics(document);
		const output = exportDocumentText(document, schema, 'markdown');
		const restored = importDocumentText(output, 'markdown', schema, environment.window.document, source);
		assert.deepEqual(semantics(restored), before);
		assert.deepEqual(semantics(document), before);
		assert.equal(documentToPlainText(restored), documentToPlainText(document));
	});
}

test('Markdown import rejects unsupported content and identifies a source location', () => {
	const schema = createDefaultDocumentSchema();
	for (const input of ['First\n\n<div>HTML</div>', '- [x] task', '~~deleted~~', '[label](https://example.com "title")', '![Figure](blob:temporary)']) {
		assert.throws(() => importDocumentText(input, 'markdown', schema, environment.window.document, source), error => error instanceof DocumentConversionError && /^\d+:\d+$/.test(error.location));
	}
	assert.throws(() => importDocumentText('First\n\n<div>HTML</div>', 'markdown', schema, environment.window.document, source), error => error instanceof DocumentConversionError && error.location === '3:1');
});

test('explicit text conversion preserves Markdown punctuation as text and exports it safely', () => {
	const schema = createDefaultDocumentSchema();
	const input = '# Heading\nA [link] & <tag> *text*.';
	const document = importDocumentText(input, 'text', schema, environment.window.document, source);
	assert.equal(exportDocumentText(document, schema, 'text'), input);
	assert.deepEqual(semantics(importDocumentText(exportDocumentText(document, schema, 'markdown'), 'markdown', schema, environment.window.document, source)), semantics(document));
});

test('Markdown export reports unsupported formatting by node identity', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument([schema.createNode('paragraph', { content: [schema.createText('Styled', { id: 'styled-node', marks: [{ type: 'textStyle', attrs: { fontFamily: 'serif' } }] })] })]);
	assert.throws(() => exportDocumentText(document, schema, 'markdown'), error => error instanceof DocumentConversionError && error.location === 'styled-node');
	assert.equal(exportDocumentText(document, schema, 'text'), 'Styled');
});

test('Markdown round trips adjacent styled runs and literal syntax characters', () => {
	const schema = createDefaultDocumentSchema();
	const mark = { type: 'strong', attrs: {} };
	const document = schema.createDocument([schema.createNode('paragraph', { content: [schema.createText('One', { marks: [mark] }), schema.createText('Two', { marks: [mark] })] })]);
	const restored = importDocumentText(exportDocumentText(document, schema, 'markdown'), 'markdown', schema, environment.window.document, source);
	assert.equal(documentToPlainText(restored), 'OneTwo');
	assert.deepEqual(restored.content[0]!.content.map(node => node.marks), [[mark]]);
	const literal = importDocumentText('1. literal\n- not a list\n+ plus\n    indented\nVisit https://example.com user@example.com', 'text', schema, environment.window.document, source);
	assert.deepEqual(semantics(importDocumentText(exportDocumentText(literal, schema, 'markdown'), 'markdown', schema, environment.window.document, source)), semantics(literal));
	const spaced = schema.createDocument([schema.createNode('paragraph', { content: [schema.createText(' bold ', { marks: [mark] })] })]);
	assert.deepEqual(semantics(importDocumentText(exportDocumentText(spaced, schema, 'markdown'), 'markdown', schema, environment.window.document, source)), semantics(spaced));
});

test('unsupported conversion errors use the active language and retain the source position', () => {
	setNlsMessages('zh-CN', { ash: messages.ash });
	try {
		assert.throws(() => importDocumentText('- [x] task', 'markdown', createDefaultDocumentSchema(), environment.window.document, source), {
			message: '无法保留 1:1 处的 任务列表。',
		});
	} finally { resetNlsResolver(); }
});
