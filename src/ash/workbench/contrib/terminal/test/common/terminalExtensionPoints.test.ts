import '../../common/terminalExtensionPoints.contribution.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import type { IExtensionApi } from '../../../../../platform/extensions/common/extensionApi.js';
import { parseExtensionManifest } from '../../../../services/extensions/common/extensionManifest.js';
import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { TerminalContributionService } from '../../common/terminalExtensionPoints.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';

suite('Terminal extension point production pipeline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes the verified declaration through its terminal owner and withdraws it on catalog replacement', async () => {
		const manifestJson = JSON.stringify({ name: 'shell', publisher: 'acme', version: '1.0.0', contributes: { terminalProfiles: [{ id: 'shell', title: '中文 Shell', icon: 'terminal-git-bash', color: 'terminal.ansiGreen' }] } });
		const manifestSha256 = `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`;
		let installed = true;
		const api: IExtensionApi = {
			resources: new ExtensionResourceLoaderService(async () => assert.fail('The terminal declaration must not read executable resources')),
			list: async () => ({ generation: installed ? 1 : 2, diagnostics: [], extensions: installed ? [{ id: 'acme.shell', name: 'shell', publisher: 'acme', version: '1.0.0', displayName: 'Shell', sourceKind: 'user', manifestSha256, packageSha256: `sha256:${'a'.repeat(64)}`, manifestJson }] : [] }),
		};
		using extensions = new TestExtensionService(api);
		using contributions = new TerminalContributionService(extensions);
		const changes: string[][] = [];
		using listener = contributions.onDidChangeTerminalProfiles(profiles => changes.push(profiles.map(profile => profile.id)));
		await extensions.start();
		assert.equal(contributions.terminalProfiles[0]?.extensionIdentifier, 'acme.shell');
		assert.equal(contributions.terminalProfiles[0]?.title, '中文 Shell');
		assert.equal(contributions.terminalProfiles[0]?.options?.icon?.id, 'terminal-git-bash');
		assert.equal(Object.isFrozen(contributions.terminalProfiles), true);
		installed = false;
		await extensions.reload();
		assert.deepEqual(contributions.terminalProfiles, []);
		assert.deepEqual(changes, [['shell'], []]);
	});

	test('manifest decoding uses the registered point before declarations reach a provider', () => {
		const descriptor = { id: 'acme.shell', name: 'shell', publisher: 'acme', version: '1.0.0' } as Parameters<typeof parseExtensionManifest>[1];
		for (const profiles of [
			[{ id: 'same', title: 'First' }, { id: 'same', title: 'Second' }],
			[{ id: 'invalid/path', title: 'Shell' }],
			[{ id: 'shell', title: 'bad\0title' }],
			[{ id: 'shell', title: 'Shell', icon: 'file://untrusted' }],
		]) {
			assert.throws(() => parseExtensionManifest(JSON.stringify({ name: 'shell', publisher: 'acme', version: '1.0.0', contributes: { terminalProfiles: profiles } }), descriptor), /Invalid terminal profile contribution/);
		}
	});

	test('invalid declaration diagnostics use the selected non-default language', () => {
		initializeTestLocalization('zh-CN');
		try {
			const descriptor = { id: 'acme.shell', name: 'shell', publisher: 'acme', version: '1.0.0' } as Parameters<typeof parseExtensionManifest>[1];
			assert.throws(() => parseExtensionManifest(JSON.stringify({ name: 'shell', publisher: 'acme', version: '1.0.0', contributes: { terminalProfiles: [{ id: 'invalid/path', title: 'Shell' }] } }), descriptor), { message: '终端配置声明无效。' });
		} finally { resetNlsResolver(); }
	});
});
