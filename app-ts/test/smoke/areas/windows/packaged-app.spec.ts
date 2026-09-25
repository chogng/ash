import { _electron, expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Workbench } from '../../../automation/workbench.js';

test('Windows package opens the Workbench from its installed layout', async ({}, testInfo) => {
	test.skip(process.platform !== 'win32', 'The Windows package requires a Windows host.');
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Ash-win32-x64 directory.');
	const bundlePath = resolve(bundle!);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const environment = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	environment.ASH_DESKTOP_UI_ONLY = '1';
	environment.ASH_WORKBENCH_MODE = 'code';
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;
	const application = await _electron.launch({
		executablePath: join(bundlePath, 'Ash.exe'),
		args: ['--disable-gpu', '--in-process-gpu', `--user-data-dir=${userDataDirectory}`],
		cwd: bundlePath,
		env: environment,
	});
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
	} finally {
		await application.close();
	}
});
