import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';

/** Opt-in acceptance reads the selected external home without copying its credentials into reports. */
for (const workspaceKind of ['isolated', 'checkout'] as const) for (const accountSource of ['isolated', 'external'] as const) test(`Desktop initializes its workspace and Agents with Codex ${accountSource} home in ${workspaceKind}`, { tag: ['@electron-app-server'] }, async ({ }, testInfo) => {
	const externalCodexHome = process.env.ASH_TEST_EXTERNAL_CODEX_HOME;
	test.skip(!externalCodexHome, 'Select an existing Codex home with ASH_TEST_EXTERNAL_CODEX_HOME.');
	const external = await realpath(externalCodexHome!);
	const authenticationDigest = async () => {
		try { return createHash('sha256').update(await readFile(join(external, 'auth.json'))).digest('hex'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
	};
	const before = await authenticationDigest();
	const temporary = await mkdtemp(join(tmpdir(), 'ash-external-codex-startup-'));
	const workspace = workspaceKind === 'checkout' ? resolve(import.meta.dirname, '../../../..') : join(temporary, 'workspace');
	if (workspaceKind === 'isolated') {
		await mkdir(workspace);
		await writeFile(join(workspace, 'startup.txt'), 'external_codex_workspace_ready\n');
	}
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	const milestones: { stage: string; milliseconds: number; }[] = [];
	const started = performance.now();
	try {
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(temporary, 'desktop'), workspaceDirectory: workspace,
			workspacePermissions: 'development', externalCodexHome: accountSource === 'external' ? external : undefined,
		}, stage => milestones.push({ stage, milliseconds: Math.round(performance.now() - started) }));
		const page = desktop.driver.workbench.page;
		const file = workspaceKind === 'checkout' ? 'package.json' : 'startup.txt';
		await desktop.driver.workbench.quickaccess.open(join(workspace, file));
		await desktop.driver.workbench.quickaccess.select(file);
		await desktop.driver.workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes(workspaceKind === 'checkout' ? '"name": "ash"' : 'external_codex_workspace_ready'));
		const opened = desktop.application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toHaveAttribute('aria-busy', 'false');
		await expect(agents.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
		await agents.reload();
		await expect(agents.locator('.ash-sessions-window')).toHaveAttribute('aria-busy', 'false');
		milestones.push({ stage: 'agents-reloaded', milliseconds: Math.round(performance.now() - started) });
	} finally {
		try {
			await desktop?.close();
			expect(await authenticationDigest(), 'External Codex authentication remains unchanged').toBe(before);
		} finally {
			await testInfo.attach('startup-milestones', { body: JSON.stringify(milestones), contentType: 'application/json' });
			// The profile may contain imported credentials; keep it outside reports and remove only this owned temp root.
			if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected startup fixture root');
			await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
});
