import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractLocalizationMessages, validateLocalizationTranslation } from './localization.ts';

test('source extraction preserves bundle identities, aliases and original command titles', () => {
	const messages = extractLocalizationMessages([{
		path: 'editor/action.ts', text: `
		import { localize as text, localize2 as title } from '../nls.js';
		import * as nls from '../nls.js';
		text('hello', 'Hello {0}', name);
		title({ bundle: 'ash.menu', key: 'close' }, 'Close');
		nls.localize2({ key: 'undo', comment: ['command'] }, 'Undo');
	` }]);
	assert.deepEqual(messages, { ash: { hello: 'Hello {0}', undo: 'Undo' }, 'ash.menu': { close: 'Close' } });
});

test('conflicting English declarations fail the build', () => {
	assert.throws(() => extractLocalizationMessages([{
		path: 'commands.ts', text: `
		import { localize } from '../nls.js'; localize('open', 'Open'); localize('open', 'Open Folder');
	` }]), /Conflicting English declaration/);
});

test('conflicting English declarations across files report the bundle, key and source', () => {
	assert.throws(() => extractLocalizationMessages([
		{ path: 'editor.ts', text: `import { localize } from './nls.js'; localize('open', 'Open');` },
		{ path: 'files.ts', text: `import { localize2 } from './nls.js'; localize2('open', 'Open Folder');` },
	]), /Conflicting English declaration: ash\/open in files\.ts/);
});

test('repeated English declarations share one entry while different bundles keep their identities', () => {
	assert.deepEqual(extractLocalizationMessages([
		{ path: 'editor.ts', text: `import { localize } from './nls.js'; localize('open', 'Open');` },
		{ path: 'files.ts', text: `import { localize2 } from './nls.js'; localize2('open', 'Open'); localize2({ bundle: 'ash.files', key: 'open' }, 'Open Folder');` },
	]), { ash: { open: 'Open' }, 'ash.files': { open: 'Open Folder' } });
});

test('unrelated imports and dynamic messages do not become localization declarations', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'feature.ts', text: `
		import { localize as other } from './other.js';
		import * as unrelated from './other.js';
		import { localize } from './nls.js';
		other('other', 'Other');
		unrelated.localize('unrelated', 'Unrelated');
		localize(dynamicKey, 'Dynamic key');
		localize('dynamicMessage', dynamicMessage);
		localize('static', \`Static message\`);
	` }]), { ash: { static: 'Static message' } });
});

test('translations for unknown keys fail the build', () => {
	assert.throws(() => validateLocalizationTranslation({ ash: { count: '{0} items' } }, { ash: { unknown: '未知' } }, 'zh-CN'), /Unknown translation/);
});

for (const [name, original, translation, valid] of [
	['reordered parameters', '{0} items in {1}', '{1} 中有 {0} 项', true],
	['repeated parameters', '{0} and {0}', '{0}', true],
	['named parameters', 'Hello {name}', '{name}，你好', true],
	['missing parameters', '{0} items', '项目', false],
	['additional parameters', '{0} items', '{0} 项 {1}', false],
	['renamed parameters', 'Hello {name}', '你好 {other}', false],
] as const) {
	test(`translation validation ${valid ? 'accepts' : 'rejects'} ${name}`, () => {
		const validate = () => validateLocalizationTranslation({ ash: { message: original } }, { ash: { message: translation } }, 'zh-CN');
		if (valid) {
			assert.deepEqual(validate(), { missing: [], unchanged: 0 });
		} else {
			assert.throws(validate, /Translation parameters differ: zh-CN\/ash\/message/);
		}
	});
}

test('theme descriptions are extracted from the owner declarations', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'theme.ts', text: `
		const color = (id: string, description: string) => registerColor(id, defaults, { description, owner: 'theme' });
		color('widget.shadow', 'Shadow around widgets.');
		registerColor('input.background', defaults, { description: 'Input background.', owner: 'theme' });
	` }]), { ash: { 'color.widget.shadow': 'Shadow around widgets.', 'color.input.background': 'Input background.' } });
});

test('explicit source text is covered while absent locale entries remain visible', () => {
	assert.deepEqual(validateLocalizationTranslation({ ash: { channel: 'H', product: 'Ash', missing: 'Find', count: '{0} items' } }, { ash: { channel: 'H', product: 'Ash', count: '{0} 项' } }, 'zh-CN'), { missing: ['ash/missing'], unchanged: 2 });
});
