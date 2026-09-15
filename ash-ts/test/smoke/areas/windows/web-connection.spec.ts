import { expect, test } from '../../../automation/test.js';
import type { IWebWorkbenchHost } from '../../../../src/ash/workbench/browser/web.api.js';
import { relative } from 'node:path';

test('built Web workbench reads workspace files and reconnects after reload', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires a browser App Server connection');
	const page = workbench.page;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) {
			await page.reload();
			await page.waitForFunction(() => globalThis.ashWebWorkbenchHost !== undefined);
		}
		const result = await page.evaluate(async path => {
			const host: IWebWorkbenchHost | undefined = globalThis.ashWebWorkbenchHost;
			if (!host?.workspace) throw new Error('Web workspace is unavailable');
			return host.api.fs.readFile({ dirId: host.workspace.id, path });
		}, relative(testWorkspace.directory, testWorkspace.file));
		expect(result.content).toBe('const value = 1;\n');
		expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/@vite/')))).toBe(false);
	}
});
