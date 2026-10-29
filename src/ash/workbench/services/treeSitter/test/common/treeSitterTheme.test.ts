import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import type { ITreeSitterLibraryService } from '../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { parseUserColorTheme } from '../../../themes/common/colorThemeData.js';
import { createTestSyntaxBackend as createTreeSitterSyntaxTokenBackend } from '../../../../../../../test/fixtures/codeSyntaxBackend.js';

test('Tree-sitter resolves capture styles directly through the current theme, including embedded languages', async () => {
	using model = new TextModel('call run', { languageId: 'javascript' });
	using themes = new TestThemeService(
		parseUserColorTheme(
			JSON.stringify({
				semanticTokenColors: {
					function: '#112233',
					'function.builtin:python': { foreground: '#abcdef', bold: true },
				},
			}),
			'direct-theme',
		),
	);
	const library: ITreeSitterLibraryService = {
		_serviceBrand: undefined,
		onDidChange: Event.None,
		supportsLanguage: () => true,
		createSession: () => ({
			...toDisposable(() => {}),
			setTabSize() {},
			update() {},
			request: async () => ({
				revision: model.version,
				measures: [],
				rows: [
					{
						row: 0,
						tokens: [
							{ start: 0, end: 4, name: 'function.builtin' },
							{ start: 5, end: 8, name: 'function.builtin', languageId: 'python' },
						],
					},
				],
			}),
		}),
	};
	const configuration = { getValue: () => false } as unknown as IConfigurationService;
	using backend = createTreeSitterSyntaxTokenBackend(model, configuration, library, themes)!;
	await backend.whenReady(new AbortController().signal);
	const tokens = backend.getLanguageTokens(1);
	assert.deepEqual(
		tokens.map(token => ({ type: token.tokenType, modifiers: token.modifiers, style: token.presentation })),
		[
			{ type: 'function', modifiers: ['builtin'], style: { foreground: '#112233' } },
			{ type: 'function', modifiers: ['builtin'], style: { foreground: '#abcdef', fontStyle: ['bold'] } },
		],
	);

	themes.setColorTheme(
		parseUserColorTheme(
			'{"semanticTokenColors":{"function":{"foreground":"#445566","italic":true}}}',
			'replacement-theme',
		),
	);
	backend.resetStyles();
	assert.deepEqual(
		backend.getLanguageTokens(1).map(token => token.presentation),
		[
			{ foreground: '#445566', fontStyle: ['italic'] },
			{ foreground: '#445566', fontStyle: ['italic'] },
		],
	);
});
