import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Desktop uses the selected Ash home for UI and backend startup', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'This scenario verifies process startup on the desktop host.');
	if (target.kind !== 'electron' || !('windows' in application)) {
		return;
	}
	const paths = await application.evaluate(({ app }) => ({
		home: process.env.ASH_HOME,
		legacy: process.env.ASH_PROFILE_ROOT,
		rendererUrl: process.env.ASH_RENDERER_URL,
		userData: app.getPath('userData'),
	}));
	expect(paths.legacy).toBeUndefined();
	expect(paths.rendererUrl).toBeUndefined();
	expect(application.windows()[0].url()).toMatch(/^file:/);
	expect(paths.home).toBeDefined();
	expect(await realpath(paths.home!)).toBe(await realpath(join(paths.userData, 'profile')));
	await expect(workbench.element).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect.poll(async () => access(join(paths.home!, 'state.sqlite3')).then(() => true, () => false)).toBe(true);
	}
});
