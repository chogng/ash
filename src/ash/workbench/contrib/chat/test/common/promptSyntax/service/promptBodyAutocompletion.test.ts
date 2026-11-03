import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { LanguageCompletionTriggerKind } from '../../../../../../../editor/common/languages.js';
import { TextModel } from '../../../../../../../editor/common/model/textModel.js';
import { FileService } from '../../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { IPathService } from '../../../../../../../platform/path/common/pathService.js';
import { PromptBodyAutocompletion } from '../../../../common/promptSyntax/languageProviders/promptBodyAutocompletion.js';

class RecordingProvider extends InMemoryFileSystemProvider {
	readonly reads: URI[] = [];
	pending: DeferredPromise<void> | undefined;
	denied = false;
	override async readDirectory(resource: URI) {
		this.reads.push(resource);
		await this.pending?.p;
		if (this.denied) throw new Error('Directory access denied');
		return super.readDirectory(resource);
	}
}

function complete(files: FileService, text: string, resource = URI.file('/project/.ash/agents/reviewer.md'), signal = new AbortController().signal) {
	const caret = text.indexOf('|');
	assert.notEqual(caret, -1);
	const prefix = text.slice(0, caret).replace(/\r\n|\r/gu, '\n').split('\n');
	using model = new TextModel(text.slice(0, caret) + text.slice(caret + 1), { resource, languageId: 'markdown' });
	return new PromptBodyAutocompletion(files, { resolvedUserHome: undefined } as IPathService).provideCompletions({
		requestId: 1, resource, languageId: 'markdown', snapshot: model.createVersionedSnapshot(),
		position: new Position(prefix.length, prefix.at(-1)!.length + 1), context: { kind: LanguageCompletionTriggerKind.Invoke },
	}, signal);
}

test('body completion replaces the entire native file reference path including the suffix after the cursor', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('file', provider);
	await files.createDirectory(URI.file('/project'));
	await files.createFile(URI.file('/project/guide.md'), 'error');
	const result = await complete(files, 'Read #file:../../gu|ide.md');
	assert.deepEqual(result?.items.map(item => ({ label: item.label, insertText: item.insertText, range: item.range })), [
		{ label: 'guide.md', insertText: '../../guide.md', range: new Range(1, 12, 1, 26) },
	]);
	assert.equal(provider.reads[0]?.toString(), URI.file('/project/').toString());
});

for (const text of ['#file:../../gu|', '#file:<../../gu|>', '#file:<../../gu|']) test(`body completion supports an unfinished reference: ${text}`, async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('file', provider);
	await files.createDirectory(URI.file('/project/guides'));
	await files.createFile(URI.file('/project/guide (draft).md'), 'error');
	const result = await complete(files, text);
	assert.deepEqual(result?.items.map(item => item.insertText), ['../../guides/', '../../guide%20%28draft%29.md']);
});

test('an empty native reference lists the definition directory without inserting an extra syntax delimiter', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('file', provider);
	await files.createDirectory(URI.file('/project/.ash/agents/references'));
	const result = await complete(files, 'Read #file:|');
	assert.deepEqual(result?.items.map(item => ({ insertText: item.insertText, range: item.range })), [
		{ insertText: 'references/', range: new Range(1, 12, 1, 12) },
	]);
});

test('body completion excludes headers, code, HTML, images, web URLs and unrelated Markdown without filesystem reads', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('file', provider);
	for (const text of [
		'---\ndescription: #file:../../gu|\n---\nBody',
		'---\ndescription: #file:../../gu|',
		'```md\n#file:../../gu|\n```',
		'`#file:../../gu|`', '<!-- #file:../../gu| -->',
		'![Guide](../../gu|)', '[Guide](https://example.invalid/gu|)', '[Guide](../../gu|)', '[Guide](../../gu|',
		'#file:../../guide.md#he|ading',
	]) assert.equal(await complete(files, text), undefined, text);
	assert.equal(await complete(files, '[Guide](./gu|)', URI.file('/project/README.md')), undefined);
	assert.equal(provider.reads.length, 0);
});

test('body completion keeps the original remote authority and supports CRLF coordinates', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('ash-remote', provider);
	const root = URI.parse('ash-remote://original/project');
	await files.createDirectory(root);
	await files.createFile(URI.joinPath(root, 'guide.md'), 'error');
	const result = await complete(files, '---\r\nload: global\r\n---\r\n#file:../../gu|', URI.joinPath(root, '.ash/instructions/style.md'));
	assert.equal(result?.items[0]?.insertText, '../../guide.md');
	assert.equal(result?.items[0]?.range.startLineNumber, 4);
	assert.equal(provider.reads[0]?.toString(), root.with({ path: '/project/' }).toString());
});

test('body completion drops cancelled replies and does not turn an unreadable directory into a grant', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('file', provider);
	await files.createDirectory(URI.file('/project'));
	const cancellation = new AbortController();
	cancellation.abort();
	assert.equal(await complete(files, '#file:../../gu|', undefined, cancellation.signal), undefined);
	assert.equal(provider.reads.length, 0);
	provider.pending = new DeferredPromise<void>();
	const controller = new AbortController();
	const pending = complete(files, '#file:../../gu|', undefined, controller.signal);
	assert.equal(provider.reads.length, 1);
	controller.abort();
	await provider.pending.complete();
	assert.equal(await pending, undefined);
	provider.pending = undefined;
	provider.denied = true;
	assert.equal(await complete(files, '#file:../../gu|'), undefined);
});

test('body completion does not expose a pinned Skill package through filesystem enumeration', async () => {
	using files = new FileService();
	using provider = new RecordingProvider();
	using registration = files.registerProvider('private', provider);
	assert.equal(await complete(files, '#file:./gu|', URI.parse('private://skill/package/SKILL.md')), undefined);
	assert.equal(provider.reads.length, 0);
});
