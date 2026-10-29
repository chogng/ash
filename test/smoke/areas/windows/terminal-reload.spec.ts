import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';

test('reload reattaches both real PTYs after their custom shell executable disappears', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, driver }, testInfo) => {
	test.skip(process.platform === 'win32', 'This scenario unlinks an executing POSIX shell wrapper.');
	test.setTimeout(90_000);
	const shell = join(testWorkspace.directory, 'disappearing-shell');
	await writeFile(shell, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
	await writeFile(join(testWorkspace.directory, 'retained-process.cjs'), `const fs=require('fs');const id=process.argv[2];let count=0;console.log('RETAINED:'+id);setInterval(()=>{fs.writeFileSync('retained-'+id+'.json',JSON.stringify({pid:process.pid,shell:process.ppid,count:++count}));console.log('TICK:'+id+':'+count);},200);`);
	await installMainChannelTestClient(workbench.page);
	const settings = await readUserSettings(workbench.page);
	const platform = process.platform === 'darwin' ? 'osx' : 'linux';
	await writeUserSettings(workbench.page, JSON.stringify({
		...JSON.parse(settings.content),
		[`terminal.integrated.profiles.${platform}`]: { 'Disappearing Shell': { path: shell, args: ['-i'], overrideName: true } },
		[`terminal.integrated.defaultProfile.${platform}`]: 'Disappearing Shell',
	}), settings.revision);
	await workbench.quickaccess.runCommand('workbench.action.terminal.newWithProfile');
	await workbench.quickaccess.items.filter({ hasText: 'Disappearing Shell' }).click();
	await workbench.page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = workbench.page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(2);
	for (const index of [0, 1]) {
		const input = panes.nth(index).locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially(`node retained-process.cjs ${index}`);
		await input.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`TICK:${index}:`);
	}
	const ids = await panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId));
	const before = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(testWorkspace.directory, `retained-${index}.json`), 'utf8')) as { pid: number; shell: number; count: number; }));
	await rm(shell);
	const loaded = workbench.page.waitForEvent('domcontentloaded');
	await workbench.quickaccess.runCommand('workbench.action.reloadWindow');
	await loaded;
	await workbench.waitForReady();
	await expect(panes).toHaveCount(2);
	expect(await panes.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.instanceId))).toEqual(ids);
	for (const index of [0, 1]) {
		const state = () => readFile(join(testWorkspace.directory, `retained-${index}.json`), 'utf8').then(value => JSON.parse(value) as { pid: number; shell: number; count: number; });
		expect([(await state()).pid, (await state()).shell]).toEqual([before[index]!.pid, before[index]!.shell]);
		await expect.poll(async () => (await state()).count).toBeGreaterThan(before[index]!.count);
		await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`TICK:${index}:`);
		const input = panes.nth(index).locator('.xterm-helper-textarea');
		await input.focus();
		await input.press('Control+c');
		await expect.poll(() => { try { process.kill(before[index]!.pid, 0); return true; } catch { return false; } }).toBe(false);
		await input.pressSequentially(`echo SHELL_RETAINED_${index}`);
		await input.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows > div').filter({ hasText: new RegExp(`^SHELL_RETAINED_${index}\\s*$`, 'u') })).toBeVisible();
	}
	expect(driver.diagnostics.errors).toEqual([]);
	await testInfo.attach('missing-shell-reload', { body: await workbench.page.screenshot(), contentType: 'image/png' });
});
