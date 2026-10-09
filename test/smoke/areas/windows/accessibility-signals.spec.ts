import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('terminal bell, clear, formatting and save signals play only after their real operations', async ({ target, workbench, testWorkspace, application }) => {
	test.skip(target.appServerMode !== 'required' || !process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER, 'Requires terminal execution and the smoke language server.');
	test.setTimeout(120_000);
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('general');
	await workbench.settingsEditor.selectCategory('general');
	for (const name of ['terminalBell', 'clear', 'save', 'format']) {
		const sound = workbench.settingsEditor.element.locator(`[data-configuration-key="accessibility.signals.${name}"]`).getByRole('textbox', { name: 'Mode 1', exact: true });
		await sound.fill('on');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
	}
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	const assets = Object.fromEntries(await Promise.all(['bell', 'clear', 'format', 'save'].map(async name => [(await readFile(join(process.cwd(), 'src/ash/platform/accessibilitySignal/browser/media', `${name}.mp3`))).toString('base64'), name])));
	await page.evaluate(assets => {
		const cues: { name: string; duration?: number; }[] = [];
		const original = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = async function (): Promise<void> {
			const bytes = new Uint8Array(await (await fetch(this.src)).arrayBuffer());
			const cue = { name: assets[btoa(String.fromCharCode(...bytes))], duration: undefined as number | undefined };
			cues.push(cue);
			await original.call(this);
			cue.duration = this.duration;
		};
		Object.assign(window, { ashTestFeatureCues: cues, ashTestFeaturePlay: original });
	}, assets);
	const readCues = () => page.evaluate(() => (window as unknown as { ashTestFeatureCues: { name: string; duration?: number; }[]; }).ashTestFeatureCues);
	try {
		await workbench.terminal.show();
		await workbench.terminal.runCommand(`node -e "process.stdout.write(String.fromCharCode(7));console.log(['ash','signal-ready'].join('-'))"`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-signal-ready');
		await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).map(cue => cue.name).sort()).toEqual(['bell']);
		await workbench.menus.select(application, () => page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'More Actions', exact: true }).click(), ['Clear Terminal']);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).not.toContainText('ash-signal-ready');
		await expect.poll(async () => (await readCues()).filter(cue => cue.name === 'clear' && cue.duration !== undefined).length).toBe(1);

		await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.rs' }).click();
		const group = workbench.editors.groupAt(0);
		const line = group.content.locator('.stanza-editor-line-text').nth(1);
		await expect(line).toHaveText(/^ {4}let /);
		const input = group.content.locator('.stanza-editor-input');
		await input.focus();
		await input.press('ControlOrMeta+Shift+I');
		await expect(line).toHaveText(/^ {2}let /, { timeout: 60_000 });
		await expect.poll(async () => (await readCues()).filter(cue => cue.name === 'format' && cue.duration !== undefined).length).toBe(1);
		await input.press('ControlOrMeta+s');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'main.rs'), 'utf8')).toMatch(/\n {2}let /);
		await expect.poll(async () => (await readCues()).filter(cue => cue.name === 'save' && cue.duration !== undefined).length).toBe(1);
		const cues = await readCues();
		expect(cues.map(cue => cue.name).sort()).toEqual(['bell', 'clear', 'format', 'save']);
		expect(cues.every(cue => cue.duration! > 0)).toBe(true);
	} finally {
		await page.evaluate(() => { HTMLMediaElement.prototype.play = (window as unknown as { ashTestFeaturePlay: typeof HTMLMediaElement.prototype.play; }).ashTestFeaturePlay; });
	}
});

for (const shell of ['Bash', 'Zsh', 'PowerShell', 'Windows PowerShell']) {
	test(`${shell} interactive command signals play once after success or failure`, async ({ target, workbench, application }) => {
		test.skip(target.appServerMode !== 'required' || (process.platform === 'win32' && (shell === 'Bash' || shell === 'Zsh')), 'Requires a supported interactive shell.');
		test.setTimeout(90_000);
		const page = workbench.page;
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('general');
		await workbench.settingsEditor.selectCategory('general');
		for (const name of ['terminalCommandSucceeded', 'terminalCommandFailed']) {
			const sound = workbench.settingsEditor.element.locator(`[data-configuration-key="accessibility.signals.${name}"]`).getByRole('textbox', { name: 'Mode 1', exact: true });
			await sound.fill('on');
			await sound.press('Tab');
			await expect(sound).toBeEnabled();
		}
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
		await workbench.terminal.show();
		const selectProfile = () => page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
		const profiles = await workbench.menus.inspect(application, selectProfile);
		const profile = profiles.find(profile => profile.label === shell || profile.label === `${shell} (Default)`);
		test.skip(!profile, `${shell} is not installed on this test host.`);
		await workbench.menus.select(application, selectProfile, [profile!.label]);
		if (shell === 'PowerShell' || shell === 'Windows PowerShell') {
			await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(/PS .*?> /);
		}
		const assets = Object.fromEntries(await Promise.all(['success', 'error'].map(async name => [(await readFile(join(process.cwd(), 'src/ash/platform/accessibilitySignal/browser/media', `${name}.mp3`))).toString('base64'), name])));
		await page.evaluate(assets => {
			const cues: { name: string; duration?: number; }[] = [];
			const original = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = async function (): Promise<void> {
				const bytes = new Uint8Array(await (await fetch(this.src)).arrayBuffer());
				const cue = { name: assets[btoa(String.fromCharCode(...bytes))], duration: undefined as number | undefined };
				cues.push(cue);
				await original.call(this);
				cue.duration = this.duration;
			};
			Object.assign(window, { ashTestShellCues: cues, ashTestShellPlay: original });
		}, assets);
		const readCues = () => page.evaluate(() => (window as unknown as { ashTestShellCues: { name: string; duration?: number; }[]; }).ashTestShellCues);
		try {
			await workbench.terminal.runCommand(`node -e "console.log(['ash','command-started'].join('-'));setTimeout(()=>console.log(['ash','command-done'].join('-')),1000)"`);
			await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-command-started');
			expect(await readCues()).toEqual([]);
			await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-command-done');
			await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).map(cue => cue.name)).toEqual(['success']);
			await workbench.terminal.runCommand('');
			await workbench.terminal.runCommand('node -e "process.exit(7)"');
			await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).map(cue => cue.name)).toEqual(['success', 'error']);
			const cues = await readCues();
			expect(cues.map(cue => cue.name)).toEqual(['success', 'error']);
			expect(cues.every(cue => cue.duration! > 0)).toBe(true);
		} finally {
			await page.evaluate(() => { HTMLMediaElement.prototype.play = (window as unknown as { ashTestShellPlay: typeof HTMLMediaElement.prototype.play; }).ashTestShellPlay; });
		}
	});
}
