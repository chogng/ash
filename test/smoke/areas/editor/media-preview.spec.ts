import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

declare global {
	interface Window { readonly mediaPreviewRevokedURLs: Set<string>; }
}

test('Built-in audio and video previews play, pause on switching and release resources', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Desktop workspace files require App Server.');
	const page = workbench.page;
	// Two seconds of PCM silence and a small VP9 clip exercise actual decoders.
	const wave = Buffer.alloc(44 + 8000 * 2 * 2);
	wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
	wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
	wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
	const video = await readFile(new URL('../../fixtures/media-preview.webm', import.meta.url));
	const files = [{ name: 'song.wav', bytes: wave }, { name: 'movie.webm', bytes: video }, { name: 'broken.mp4', bytes: Buffer.from('broken') }];
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async files => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`media-preview-${crypto.randomUUID()}`, { create: true });
			for (const file of files) {
				const writer = await (await folder.getFileHandle(file.name, { create: true })).createWritable();
				await writer.write(Uint8Array.from(atob(file.encoded), character => character.charCodeAt(0))); await writer.close();
			}
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		}, files.map(file => ({ name: file.name, encoded: file.bytes.toString('base64') })));
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	} else {
		for (const file of files) { await writeFile(join(testWorkspace.directory, file.name), file.bytes); }
	}
	await page.evaluate(() => {
		const revoke = URL.revokeObjectURL.bind(URL);
		const revoked = new Set<string>();
		URL.revokeObjectURL = url => { revoked.add(url); revoke(url); };
		Object.defineProperty(window, 'mediaPreviewRevokedURLs', { value: revoked, configurable: true });
	});
	const explorer = page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'song.wav', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	const audio = group.content.locator('.ash-media-preview:visible audio');
	await expect(group.title.getByRole('button', { name: 'Select editor: Audio preview', exact: true })).toBeVisible();
	await expect.poll(() => audio.evaluate(element => (element as HTMLMediaElement).duration)).toBe(2);
	const audioHandle = await audio.elementHandle();
	const audioURL = await audio.getAttribute('src');
	await audio.focus(); await audio.press('Space');
	await expect.poll(() => audio.evaluate(element => (element as HTMLMediaElement).paused)).toBe(false);
	await audio.press('Space');
	await expect.poll(() => audio.evaluate(element => (element as HTMLMediaElement).paused)).toBe(true);
	await audio.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Press Space[\s\S]*Closing the tab stops playback/);
	await page.keyboard.press('Escape');
	await expect(audio).toBeFocused();
	await audio.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Audio preview: song.wav[\s\S]*Duration: 2 seconds/);
	await page.keyboard.press('Escape');
	await audio.press('Space');
	await explorer.getByRole('treeitem', { name: 'movie.webm', exact: true }).dblclick();
	await expect.poll(() => audioHandle!.evaluate(element => (element as HTMLMediaElement).paused)).toBe(true);
	const player = group.content.locator('.ash-media-preview:visible video');
	await expect.poll(() => player.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(64);
	await expect(group.title.getByRole('button', { name: 'Select editor: Video preview', exact: true })).toBeVisible();
	const videoURL = await player.getAttribute('src');
	await player.focus(); await player.press('Space');
	await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).paused)).toBe(false);
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect.poll(() => page.evaluate(url => window.mediaPreviewRevokedURLs.has(url!), videoURL)).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect.poll(() => page.evaluate(url => window.mediaPreviewRevokedURLs.has(url!), audioURL)).toBe(true);
	await audioHandle!.dispose();
	await explorer.getByRole('treeitem', { name: 'broken.mp4', exact: true }).dblclick();
	await expect(group.content.getByRole('alert')).toContainText('This media file could not be played.');
});
