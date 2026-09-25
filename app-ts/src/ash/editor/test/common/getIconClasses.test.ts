import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind } from '../../../platform/files/common/files.js';
import { TextModel } from '../../common/model/textModel.js';
import { getIconClasses, getIconClassesForLanguageId } from '../../common/services/getIconClasses.js';
import { LanguageService } from '../../common/services/languageService.js';

test('file icon classes describe the resource name, compound extensions and detected language', () => {
	using languages = new LanguageService();
	using registration = languages.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
	const resource = URI.file('/workspace/My Folder/Example.test.ts');

	assert.deepEqual(getIconClasses(undefined, languages, resource, FileKind.File), [
		'file-icon',
		'my/folder-name-dir-icon',
		'example.test.ts-name-file-icon',
		'name-file-icon',
		'test.ts-ext-file-icon',
		'ts-ext-file-icon',
		'ext-file-icon',
		'typescript-lang-file-icon',
	]);
	assert.deepEqual(getIconClassesForLanguageId('my language'), ['file-icon', 'my/language-lang-file-icon']);
});

test('file icon classes prefer an open model and describe folders and data labels', () => {
	using languages = new LanguageService();
	using registration = languages.registerLanguage({ id: 'typescript', extensions: ['.ts'], mimetypes: ['text/typescript'] });
	const resource = URI.file('/workspace/readme.ts');
	using model = new TextModel('content', { resource, languageId: 'rust' });
	const models = { getModel: (candidate: URI): TextModel | null => candidate.toString() === resource.toString() ? model : null };

	assert.equal(getIconClasses(models, languages, resource).at(-1), 'rust-lang-file-icon');
	assert.deepEqual(getIconClasses(undefined, languages, URI.file('/workspace/src'), FileKind.Directory), [
		'folder-icon', 'workspace-name-dir-icon', 'src-name-folder-icon',
	]);
	assert.deepEqual(getIconClasses(undefined, languages, URI.file('/workspace'), 'rootFolder'), [
		'rootfolder-icon', 'workspace-root-name-folder-icon',
	]);
	assert.deepEqual(getIconClasses(undefined, languages, URI.parse('data:text/typescript;label:Demo%20File.ts;base64,AA')), [
		'file-icon', 'demo/file.ts-name-file-icon', 'name-file-icon', 'ts-ext-file-icon', 'ext-file-icon', 'typescript-lang-file-icon',
	]);
});

test('explicit icons override resource classes', () => {
	using languages = new LanguageService();
	const resource = URI.file('/workspace/file.ts');

	assert.deepEqual(getIconClasses(undefined, languages, undefined), ['file-icon']);
	assert.deepEqual(getIconClasses(undefined, languages, resource, FileKind.File, ThemeIcon.fromId('file')), [
		'codicon-file', 'predefined-file-icon',
	]);
	assert.deepEqual(getIconClasses(undefined, languages, resource, FileKind.File, URI.file('/icons/custom.svg')), []);
});
