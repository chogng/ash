import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { createMediaPreviewFixture, mediaPreviewEvidence } from './mediaPreviewFixture.js';

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

test('Audio and video retry first reads and damaged video recovers with the current player', async ({ target, testWorkspace, workbench }, testInfo) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Desktop workspace files require App Server.');
	test.setTimeout(90_000);
	const page = workbench.page;
	const fixture = await createMediaPreviewFixture(page, target, testWorkspace.directory, workbench);
	try {
		const explorer = page.locator('.ash-explorer');
		const preview = workbench.editors.groupAt(0).content.locator('.ash-media-preview:visible');
		for (const [name, kind] of [['retry.wav', 'audio'], ['retry.webm', 'video']] as const) {
			const before = await mediaPreviewEvidence(page);
			await page.evaluate(name => window.mediaRetryProbe.fail.add(name), name);
			await explorer.getByRole('treeitem', { name, exact: true }).dblclick();
			await expect(preview.getByRole('alert')).toContainText('Could not load media:');
			const failure = await mediaPreviewEvidence(page);
			expect(failure.failedReads.at(-1)!.name).toBe(name);
			if (target.appServerMode === 'disabled') { await expect(preview.getByRole('alert')).toContainText(failure.failedReads.at(-1)!.message); }
			expect(failure.created).toEqual(before.created);
			const player = preview.locator(kind);
			await expect(player).not.toHaveAttribute('src');
			await testInfo.attach(`${kind}-read-failure`, { body: await preview.screenshot(), contentType: 'image/png' });
			const retry = preview.getByRole('button', { name: 'Retry', exact: true });
			await retry.focus(); await retry.press('Enter');
			await expect.poll(() => player.evaluate(element => Number.isFinite((element as HTMLMediaElement).duration))).toBe(true);
			await expect(preview.getByRole('alert')).toBeHidden();
			await expect(retry).toBeHidden();
			const url = (await player.getAttribute('src'))!;
			const handle = (await player.elementHandle())!;
			try {
				await player.focus(); await player.press('Space');
				await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).paused)).toBe(false);
				await player.press('Space');
				await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).paused)).toBe(true);
				await player.evaluate(element => { const media = element as HTMLMediaElement; media.currentTime = 0.5; media.volume = 0.4; });
				await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).currentTime)).toBeCloseTo(0.5, 1);
				await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).volume)).toBe(0.4);
				await testInfo.attach(`${kind}-retry-success`, { body: await preview.screenshot(), contentType: 'image/png' });
				await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
				await expect.poll(async () => (await mediaPreviewEvidence(page)).revoked).toContain(url);
				expect(await handle.evaluate(element => ({ paused: (element as HTMLMediaElement).paused, hasSource: element.hasAttribute('src') }))).toEqual({ paused: true, hasSource: false });
			} finally { await handle.dispose(); }
		}
		await explorer.getByRole('treeitem', { name: 'broken.webm', exact: true }).dblclick();
		await expect(preview.getByRole('alert')).toContainText('This media file could not be played.');
		await expect(preview.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
		const oldPlayer = (await preview.locator('video').elementHandle())!;
		const oldURL = (await preview.locator('video').getAttribute('src'))!;
		try {
			await testInfo.attach('video-decode-failure', { body: await preview.screenshot(), contentType: 'image/png' });
			await fixture.repair('broken.webm');
			if (await preview.getByRole('button', { name: 'Retry', exact: true }).isVisible()) {
				await preview.getByRole('button', { name: 'Retry', exact: true }).click();
			}
			const video = preview.locator('video');
			await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(64);
			await expect.poll(async () => (await mediaPreviewEvidence(page)).revoked).toContain(oldURL);
			// A real file watcher can refresh between protocol calls; compare the stale event in one DOM turn.
			const staleEvent = await oldPlayer.evaluate(element => {
				const current = element.ownerDocument.querySelector<HTMLVideoElement>('.ash-media-preview video')!;
				const source = current.src;
				element.dispatchEvent(new Event('error'));
				return {
					detached: !element.isConnected, replaced: element !== current,
					source, sourceAfter: current.src,
					failureHidden: current.closest('.ash-media-preview')!.querySelector<HTMLElement>('[role="alert"]')!.hidden,
				};
			});
			expect(staleEvent).toEqual({ detached: true, replaced: true, source: staleEvent.source, sourceAfter: staleEvent.source, failureHidden: true });
			await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(64);
			await expect(preview.getByRole('alert')).toBeHidden();
			await testInfo.attach('media-old-player-state', { body: JSON.stringify(staleEvent, null, 2), contentType: 'application/json' });
			await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		} finally { await oldPlayer.dispose(); }
		await expect.poll(async () => {
			const evidence = await mediaPreviewEvidence(page);
			return evidence.created.every(url => evidence.revoked.includes(url)) && evidence.liveResources.length === 0;
		}).toBe(true);
		await testInfo.attach('media-lifecycle', { body: JSON.stringify(await mediaPreviewEvidence(page), null, 2), contentType: 'application/json' });
	} finally { await fixture.dispose(); }
});

test('Closing an audio preview during a refresh releases late data without a new URL', async ({ target, testWorkspace, workbench }, testInfo) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Desktop workspace files require App Server.');
	const page = workbench.page;
	const fixture = await createMediaPreviewFixture(page, target, testWorkspace.directory, workbench);
	try {
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'retry.wav', exact: true }).dblclick();
		const player = workbench.editors.groupAt(0).content.locator('.ash-media-preview:visible audio');
		await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).duration)).toBe(2);
		const url = (await player.getAttribute('src'))!;
		const beforeRefresh = await mediaPreviewEvidence(page);
		await page.evaluate(() => window.mediaRetryProbe.hold.add('retry.wav'));
		await fixture.refresh();
		await expect.poll(async () => (await mediaPreviewEvidence(page)).pending).toContain('retry.wav');
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(workbench.editors.groupAt(0).content.locator('.ash-media-preview:visible')).toHaveCount(0);
		await page.evaluate(() => window.mediaRetryProbe.pending.get('retry.wav')!());
		await expect.poll(async () => (await mediaPreviewEvidence(page)).pending).toEqual([]);
		if (target.appServerMode === 'required') {
			await expect.poll(async () => (await mediaPreviewEvidence(page)).releasedResources.length).toBeGreaterThan(beforeRefresh.releasedResources.length);
		} else {
			await expect.poll(async () => (await mediaPreviewEvidence(page)).completedReads.length).toBeGreaterThan(beforeRefresh.completedReads.length);
		}
		const evidence = await mediaPreviewEvidence(page);
		expect({ created: evidence.created, revoked: evidence.revoked, liveResources: evidence.liveResources }).toEqual({ created: [url], revoked: [url], liveResources: [] });
		await testInfo.attach('pending-close-lifecycle', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
	} finally { await fixture.dispose(); }
});
