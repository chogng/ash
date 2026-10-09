import { writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Quick Open resolves absolute paths and paths relative to the OS home', async ({ workbench, testWorkspace, webAppServer, application, target: platform }) => {
	test.skip(platform.appServerMode !== 'required', 'Requires initialized target OS and user home.');
	const target = join(testWorkspace.directory, 'home-path.md');
	await writeFile(target, 'home_path_token\n');
	const home = platform.kind === 'browser' ? webAppServer!.profileDirectory : await (application as import('@playwright/test').ElectronApplication).evaluate(() => process.platform === 'win32' ? process.env.USERPROFILE! : process.env.HOME!);
	for (const query of [target, `~${sep}${relative(home, target)}`]) {
		await test.step(query, async () => {
			await workbench.quickaccess.open(query);
			await expect(workbench.quickaccess.items.locator('.ash-quick-pick-row-label')).toHaveText(['home-path.md']);
			await workbench.quickaccess.select('home-path.md');
			await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'home_path_token\n');
		});
	}
});
