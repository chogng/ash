import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { TerminalWindowLifetimeHost } from '../../electron-main/terminalWindowLifetimeHost.js';

suite('Terminal window lifetime preparation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('closing a window during executable preparation rejects late ownership without spawning and uses the selected locale', async () => {
		using localization = toDisposable(resetNlsResolver);
		setNlsMessages('zh-CN', JSON.parse(await readFile(resolve('extensions/language-pack-zh-cn/translations/workbench.json'), 'utf8')));
		const preparation = new DeferredPromise<{ executable: string; profile: string; environment: Record<string, string>; }>();
		using owner = new TerminalWindowLifetimeHost(() => preparation.p);
		const route = owner.routes()[0]!;
		assert.throws(() => route.validate({ windowId: 42 }), /no arguments/);
		const pending = Promise.resolve(route.invoke(route.validate(undefined)));
		owner.dispose();
		await preparation.complete({ executable: '/must-not-spawn', profile: '/profile', environment: {} });
		await assert.rejects(pending, /此终端所属窗口已关闭/);
	});
});
