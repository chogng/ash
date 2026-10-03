import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractLocalizationMessages, validateLocalizationTranslation } from './localization.ts';

test('source extraction preserves bundle identities, aliases and original command titles', () => {
	const messages = extractLocalizationMessages([{ path: 'editor/action.ts', text: `
		import { localize as text, localize2 as title } from '../nls.js';
		import * as nls from '../nls.js';
		text('hello', 'Hello {0}', name);
		title({ bundle: 'ash.menu', key: 'close' }, 'Close');
		nls.localize2({ key: 'undo', comment: ['command'] }, 'Undo');
	` }]);
	assert.deepEqual(messages, { ash: { hello: 'Hello {0}', undo: 'Undo' }, 'ash.menu': { close: 'Close' } });
});

test('conflicting declarations and incompatible translation parameters fail the build', () => {
	assert.throws(() => extractLocalizationMessages([{ path: 'commands.ts', text: `
		import { localize } from '../nls.js'; localize('open', 'Open'); localize('open', 'Open Folder');
	` }]), /Conflicting English declaration/);
	assert.throws(() => validateLocalizationTranslation({ ash: { count: '{0} items' } }, { ash: { count: '{1} 项' } }, 'zh-CN'), /parameters differ/);
	assert.throws(() => validateLocalizationTranslation({ ash: { count: '{0} items' } }, { ash: { unknown: '未知' } }, 'zh-CN'), /Unknown translation/);
	validateLocalizationTranslation({ ash: { count: '{0} items in {1}' } }, { ash: { count: '{1} 中有 {0} 项' } }, 'zh-CN');
});

test('theme descriptions are extracted from the owner declarations', () => {
	assert.deepEqual(extractLocalizationMessages([{ path: 'theme.ts', text: `
		const color = (id: string, description: string) => registerColor(id, defaults, { description, owner: 'theme' });
		color('widget.shadow', 'Shadow around widgets.');
		registerColor('input.background', defaults, { description: 'Input background.', owner: 'theme' });
	` }]), { ash: { 'color.widget.shadow': 'Shadow around widgets.', 'color.input.background': 'Input background.' } });
});

test('explicit source text is covered while absent locale entries remain visible', () => {
	assert.deepEqual(validateLocalizationTranslation({ ash: { channel: 'H', product: 'Ash', missing: 'Find', count: '{0} items' } }, { ash: { channel: 'H', product: 'Ash', count: '{0} 项' } }, 'zh-CN'), { missing: ['ash/missing'], unchanged: 2 });
});
