import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { createDefaultDocumentSchema } from '../../../../../../../extensions/academic/common/model/documentSchema.js';
import { exportDocx, importDocx } from '../../../../../../../extensions/academic/browser/contrib/documentOutput/docx.js';
import { zipFiles, unzipFiles } from '../../../../../../../extensions/academic/browser/contrib/documentOutput/zip.js';
import { documentToPlainText } from '../../../../../../../extensions/academic/common/model/documentSerialization.js';
import { createResolveRevisionCommand } from '../../../../../../../extensions/academic/common/model/documentReview.js';
import { DocumentTextModel } from '../../../../../../../extensions/academic/common/model/documentTextModel.js';

const environment = new JSDOM('<!doctype html>');
suiteTeardown(() => environment.window.close());
const owner = environment.window.document;
const schema = createDefaultDocumentSchema();
const signal = () => new AbortController().signal;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const paragraph = (text: string) => schema.createNode('paragraph', { content: [schema.createText(text)] });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const foreign = (body: string, parts: Record<string, string> = {}) => zipFiles(new Map(Object.entries({
	'_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
	'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`, ...parts,
}).map(([name, value]) => [name, encode(value)])));

test('DOCX standard parts and authenticated Ash roundtrip retain sections, formatting and review', async () => {
	const document = {
		...schema.createDocument([
			paragraph('中文 A & B'), schema.createNode('documentSection', { attrs: { pageSize: 'letter', pageMargin: 54, pageOrientation: 'landscape', pageHeader: 'Chapter' }, content: [schema.createNode('orderedList', { attrs: { order: 3 }, content: [schema.createNode('listItem', { content: [paragraph('Three')] })] }), schema.createNode('table', { content: [schema.createNode('tableRow', { content: [schema.createNode('tableCell', { content: [paragraph('Cell')] })] })] })] }),
		]), attrs: { pageSize: 'a4', pageNumbers: true }
	};
	const bytes = await exportDocx(document, schema, signal());
	const files = await unzipFiles(bytes, signal());
	assert.ok(files.has('[Content_Types].xml'));
	assert.ok(files.has('word/numbering.xml'));
	assert.equal((decode(files.get('word/document.xml')!).match(/<w:sectPr>/g) ?? []).length, 2);
	for (const [name, bytes] of files) if (name.endsWith('.xml') || name.endsWith('.rels')) assert.equal(new owner.defaultView!.DOMParser().parseFromString(decode(bytes), 'application/xml').getElementsByTagName('parsererror').length, 0, name);
	assert.deepEqual(await importDocx(bytes, schema, owner, signal()), document);
});

test('DOCX changed interoperable content invalidates the old Ash snapshot', async () => {
	const files = await unzipFiles(await exportDocx(schema.createDocument([paragraph('Original')]), schema, signal()), signal());
	files.set('word/document.xml', encode(decode(files.get('word/document.xml')!).replace('Original', 'Edited in Word')));
	assert.equal(documentToPlainText(await importDocx(zipFiles(files), schema, owner, signal())), 'Edited in Word');
});

test('DOCX foreign comments and insert/delete revisions enter editable model review', async () => {
	const bytes = foreign(`<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Before </w:t></w:r><w:del w:author="Reader"><w:r><w:delText>old</w:delText></w:r></w:del><w:ins w:author="Writer"><w:r><w:t>new</w:t></w:r></w:ins><w:commentRangeEnd w:id="0"/></w:p>`, {
		'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="comments" Type="${R}/comments" Target="comments.xml"/></Relationships>`,
		'word/comments.xml': `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Reader"><w:p><w:r><w:t>Check wording</w:t></w:r></w:p></w:comment></w:comments>`,
	});
	const document = await importDocx(bytes, schema, owner, signal());
	assert.equal(documentToPlainText(document), 'Before new');
	assert.ok(document.content.find(node => node.type === 'reviewComment')!.attrs.anchor);
	const revision = document.content.find(node => node.type === 'reviewChange')!;
	using model = DocumentTextModel.create(schema, document);
	model.dispatch(createResolveRevisionCommand(schema, model.document, revision.id, false, document.content[0]!.id)!.transaction);
	assert.equal(model.getValue(), 'Before old');
	model.undoBlocks(); assert.equal(model.getValue(), 'Before new');
});

test('DOCX rejects unsupported features, invalid archives, expansion and cancellation', async () => {
	await assert.rejects(importDocx(foreign('<w:p><w:r><w:object/></w:r></w:p>'), schema, owner, signal()), /Cannot preserve DOCX feature/);
	await assert.rejects(importDocx(foreign('<w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/></w:p>'), schema, owner, signal()), /XML namespace/);
	await assert.rejects(unzipFiles(new Uint8Array(70000), signal()), /Invalid ZIP/);
	const file = zipFiles(new Map([['a', encode('body')]])); file[31] ^= 1;
	await assert.rejects(unzipFiles(file, signal()), /checksum/);
	assert.throws(() => zipFiles(new Map([['../escape', encode('body')]])), /Invalid ZIP/);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(importDocx(foreign('<w:p/>'), schema, owner, aborted.signal), /abort/i);
});

test('DOCX native Academic imports preserve their profile, paper structure and citation identities', async () => {
	const { createAcademicDocumentSchema, createEmptyAcademicDocument } = await import('../../../../../../../extensions/academic/browser/contrib/academic/common/schema.js');
	const { importDocxDocument } = await import('../../../../../../../extensions/academic/browser/contrib/documentOutput/docx.js');
	const academic = createAcademicDocumentSchema();
	const empty = createEmptyAcademicDocument(academic);
	const document = academic.createDocument([...empty.content,
	academic.createNode('section', { content: [academic.createNode('heading', { content: [academic.createText('Research')] }), academic.createNode('paragraph', { content: [academic.createText('Evidence '), academic.createNode('citation', { id: 'citation-one', attrs: { key: 'one', label: '[1]' } })] })] }),
	academic.createNode('bibliography', { content: [academic.createNode('reference', { attrs: { key: 'one' }, content: [academic.createNode('paragraph', { content: [academic.createText('Source one')] })] })] }),
	]);
	const bytes = await exportDocx(document, academic, signal());
	const result = await importDocxDocument(bytes, owner, signal());
	assert.equal(result.documentType, 'academic'); assert.deepEqual(result.document, document);
});

test('DOCX resolves used style inheritance, materializes character marks and ignores unused unsupported styles', async () => {
	const document = await importDocx(foreign(`<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:t>Styled</w:t></w:r></w:p>`, {
		'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
		'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:name w:val="Child"/><w:basedOn w:val="Base"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Unused"><w:rPr><w:color w:val="ff0000"/></w:rPr></w:style></w:styles>`,
	}), schema, owner, signal());
	assert.equal(document.content[0]!.content[0]!.marks.find(mark => mark.type === 'textStyle')!.attrs.fontSize, 15);
	assert.ok(document.content[0]!.content[0]!.marks.some(mark => mark.type === 'strong'));
	assert.equal(JSON.parse(String(document.attrs.paragraphStyles))[0].attrs.textAlign, 'center');
});
