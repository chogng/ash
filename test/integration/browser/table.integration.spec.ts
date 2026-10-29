import { expect, test } from '@playwright/test';
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.describe('renderer audio capture', () => {
	for (const locale of ['en', 'zh-CN']) {
		test(`streams real worklet PCM through the standard client and releases capture (${locale})`, async ({ page }) => {
			await page.goto(`/table.html?realAudio&locale=${locale}`);
			await page.evaluate(() => window.ashTableIntegration.startDictation());
			await expect.poll(() => page.evaluate(() => window.ashTableIntegration.audioPackets)).toBeGreaterThan(0);
			expect(await page.evaluate(() => window.ashTableIntegration.analysing)).toBe(true);
			await page.evaluate(() => window.ashTableIntegration.transcript('audio result', true));
			expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('');
			expect(await page.evaluate(() => window.ashTableIntegration.stopDictation())).toBe('audio result');
			expect(await page.evaluate(() => [window.ashTableIntegration.draft, window.ashTableIntegration.analysing, window.ashTableIntegration.stops])).toEqual(['audio result', false, 1]);
			const packets = await page.evaluate(() => window.ashTableIntegration.audioPackets);
			await page.evaluate(() => window.ashTableIntegration.transcript('stale', true));
			expect(await page.evaluate(() => [window.ashTableIntegration.draft, window.ashTableIntegration.audioPackets])).toEqual(['audio result', packets]);
		});
	}
});

test('dictation inserts at the rich editor selection and preserves undo', async ({ page }) => {
	await page.goto('/table.html');
	const editor = page.getByRole('textbox', { name: 'Dictation draft' });
	await editor.focus();
	await page.keyboard.type('before old after');
	await page.keyboard.press('Home');
	for (let index = 0; index < 7; index++) { await page.keyboard.press('ArrowRight'); }
	for (let index = 0; index < 3; index++) { await page.keyboard.press('Shift+ArrowRight'); }
	await page.evaluate(() => window.ashTableIntegration.startDictation());
	await page.evaluate(() => window.ashTableIntegration.transcript('partial', false));
	await expect(page.locator('#dictation-preview')).toHaveText('partial');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before old after');
	await page.evaluate(() => window.ashTableIntegration.transcript('replacement', true));
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before replacement after');
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before old after');
});

test('shared dictation disables other inputs and routes text to its current editor', async ({ page }) => {
	await page.goto('/table.html');
	const second = page.locator('#second-input');
	const microphone = second.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
	await expect(microphone).toBeEnabled();
	await page.evaluate(() => window.ashTableIntegration.startDictation());
	await expect(microphone).toBeDisabled();
	await page.evaluate(() => window.ashTableIntegration.transcript('first editor', true));
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('first editor');
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('');
	await expect(microphone).toBeEnabled();
	await microphone.focus();
	await page.keyboard.press('Space');
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashTableIntegration.transcript('second editor', true));
	await microphone.click();
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('second editor');
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('second editor');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('first editor');
	await microphone.click();
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashTableIntegration.transcript('unfinished', false));
	await page.evaluate(() => window.ashTableIntegration.hideSecondInput());
	await page.evaluate(() => window.ashTableIntegration.transcript('late text', true));
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('second editor');
});

test('dictation microphone menu uses Chinese settings and commands still work with the button hidden', async ({ page }) => {
	await page.goto('/table.html?locale=zh-CN');
	const second = page.locator('#second-input');
	const microphone = second.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
	await microphone.click({ button: 'right' });
	await page.getByText('选择麦克风', { exact: true }).click();
	await page.getByText('USB microphone', { exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.microphone)).toBe('mic-2');
	expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(0);
	await microphone.click({ button: 'right' });
	await page.getByText('显示麦克风按钮', { exact: true }).click();
	await expect(microphone).toHaveCount(0);
	await second.getByRole('textbox').focus();
	await page.evaluate(() => window.ashTableIntegration.toggleDictationCommand());
	await page.evaluate(() => window.ashTableIntegration.transcript('command draft', true));
	await page.evaluate(() => window.ashTableIntegration.toggleDictationCommand());
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('command draft');
	await page.evaluate(() => window.ashTableIntegration.setDictationButton(true));
	await microphone.click();
	await microphone.click({ button: 'right' });
	await page.getByText('禁用听写', { exact: true }).click();
	await expect(microphone).toHaveCount(0);
	const starts = await page.evaluate(() => window.ashTableIntegration.starts);
	await page.evaluate(() => window.ashTableIntegration.toggleDictationCommand());
	expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(starts);
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('command draft');
});


test('ordinary editor dictation command replaces its selection, supports undo and cancels on Escape', async ({ page }) => {
	await page.goto('/table.html');
	const editor = page.getByRole('textbox', { name: 'Ordinary dictation editor' });
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
	for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
	await page.evaluate(() => window.ashTableIntegration.codeDictation());
	await page.evaluate(() => window.ashTableIntegration.transcript('replacement', true));
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('before replacement after');
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('before old after');
	await page.evaluate(() => window.ashTableIntegration.codeDictation());
	await page.evaluate(() => window.ashTableIntegration.transcript('unfinished', false));
	await page.keyboard.press('Escape');
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.stops)).toBe(2);
	await page.evaluate(() => window.ashTableIntegration.transcript('late', true));
	expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('before old after');
	await page.keyboard.press('ControlOrMeta+Alt+v');
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.starts)).toBe(3);
	await page.keyboard.press('ControlOrMeta+Alt+v');
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.stops)).toBe(3);
});

test('first dictation starts alongside the introduction and closing the card keeps recording', async ({ page }) => {
	await page.goto('/table.html');
	await page.evaluate(() => window.ashTableIntegration.freshIntroduction());
	const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button');
	await microphone.click();
	const intro = page.getByRole('region', { name: 'Dictation introduction', exact: true });
	await expect(intro).toBeVisible();
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(1);
	await intro.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(intro).toHaveCount(0);
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashTableIntegration.transcript('first draft', true));
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('first draft');
	expect(await page.evaluate(() => window.ashTableIntegration.stops)).toBe(1);
});

test('manual dictation introduction keeps trial text out of drafts and saves microphone and language in Chinese', async ({ page }) => {
	await page.goto('/table.html?locale=zh-CN');
	await page.evaluate(() => window.ashTableIntegration.freshIntroduction());
	const input = page.locator('#second-input');
	await page.evaluate(() => window.ashTableIntegration.showIntroduction());
	const intro = page.getByRole('region', { name: '听写入门', exact: true });
	await expect(intro).toBeVisible();
	expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(0);
	await intro.getByRole('combobox', { name: '麦克风', exact: true }).click();
	await page.getByRole('option', { name: 'Test microphone', exact: true }).click();
	await intro.getByRole('combobox', { name: '转写语言', exact: true }).focus();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => [window.ashTableIntegration.microphone, window.ashTableIntegration.language])).toEqual(['microphone-1', 'zh']);
	await intro.getByRole('button', { name: '测试麦克风', exact: true }).click();
	await expect(intro.getByRole('button', { name: '停止测试', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashTableIntegration.transcript('这只是试录', false));
	await expect(intro.getByRole('status')).toHaveText('这只是试录');
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('');
	await intro.getByRole('button', { name: '完成', exact: true }).focus();
	await page.keyboard.press('Escape');
	await expect(intro).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.stops)).toBe(1);
	await input.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button').click();
	await expect(input.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button')).toHaveAttribute('aria-pressed', 'true');
	await expect(intro).toHaveCount(0);
	await page.evaluate(() => window.ashTableIntegration.transcript('写入草稿', true));
	await input.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button').click();
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('写入草稿');
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('写入草稿');
});


test('closing the dictation introduction while capture starts releases the acquired microphone', async ({ page }) => {
	await page.goto('/table.html');
	await page.evaluate(() => { window.ashTableIntegration.freshIntroduction(); window.ashTableIntegration.holdCapture(); });
	const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button');
	await page.evaluate(() => window.ashTableIntegration.showIntroduction());
	const intro = page.getByRole('region', { name: 'Dictation introduction', exact: true });
	await intro.getByRole('button', { name: 'Test microphone', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.starts)).toBe(1);
	await expect(intro.getByRole('button', { name: 'Stop test', exact: true })).toBeDisabled();
	await intro.getByRole('button', { name: 'Done', exact: true }).click();
	await page.evaluate(() => window.ashTableIntegration.releaseCapture());
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.stops)).toBe(1);
	await expect(microphone).toBeEnabled();
	await page.evaluate(() => window.ashTableIntegration.transcript('late trial', true));
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('');
});

test('repeated editor dictation commands share capture while the first introduction stays open', async ({ page }) => {
	await page.goto('/table.html');
	await page.evaluate(async () => {
		window.ashTableIntegration.freshIntroduction();
		await Promise.all([window.ashTableIntegration.codeDictation(), window.ashTableIntegration.codeDictation()]);
		await window.ashTableIntegration.codeDictation();
	});
	await expect(page.getByRole('region', { name: 'Dictation introduction', exact: true })).toHaveCount(1);
	expect(await page.evaluate(() => [window.ashTableIntegration.starts, window.ashTableIntegration.stops])).toEqual([1, 1]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`registered Speech extension drives Chat and ordinary editor phrases without builtin capture (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?locale=${locale}`);
		await page.evaluate(() => window.ashTableIntegration.extensionSpeech(true));
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([true, false, false]);
		const editor = page.getByRole('textbox', { name: 'Dictation draft' }); await editor.focus();
		await page.evaluate(() => window.ashTableIntegration.startDictation());
		await page.evaluate(() => window.ashTableIntegration.transcript('你好', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.draft)).toBe('你好');
		await page.evaluate(() => window.ashTableIntegration.transcript('世界', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.draft)).toBe('你好世界');
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([true, true, false]);
		expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(0);
		await page.evaluate(() => window.ashTableIntegration.stopDictation());
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([true, false, false]);
		const ordinary = page.getByRole('textbox', { name: 'Ordinary dictation editor' });
		await ordinary.focus(); await page.keyboard.press('ControlOrMeta+a');
		await page.evaluate(() => window.ashTableIntegration.codeDictation());
		await page.evaluate(() => window.ashTableIntegration.transcript('first', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.codeText)).toBe('first');
		await page.evaluate(() => window.ashTableIntegration.transcript('second', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.codeText)).toBe('first second');
		await page.evaluate(() => window.ashTableIntegration.extensionSpeech(false));
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([false, false, false]);
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button')).toBeEnabled();
		await page.evaluate(() => window.ashTableIntegration.transcript('stale', true));
		expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('first second');
		expect(await page.evaluate(() => window.ashTableIntegration.extensionStarts)).toBe(2);
	});
	test(`extension Speech trial hides unrelated device settings and accumulates final phrases (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?locale=${locale}`);
		await page.evaluate(() => { window.ashTableIntegration.extensionSpeech(true); window.ashTableIntegration.freshIntroduction(); });
		await page.evaluate(() => window.ashTableIntegration.showIntroduction());
		const region = page.getByRole('region', { name: locale === 'zh-CN' ? '听写入门' : 'Dictation introduction' });
		await expect(region).toBeVisible();
		await expect(region.getByRole('combobox')).toHaveCount(0);
		await expect(region).toContainText(locale === 'zh-CN' ? '它负责识别和麦克风访问' : 'It controls recognition and microphone access');
		await region.getByRole('button', { name: locale === 'zh-CN' ? '测试麦克风' : 'Test microphone', exact: true }).click();
		await page.evaluate(() => window.ashTableIntegration.transcript('first', true));
		await expect(region.getByRole('status')).toHaveText('first');
		await page.evaluate(() => window.ashTableIntegration.transcript('second', true));
		await expect(region.getByRole('status')).toHaveText('first second');
		expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('before old after');
		await region.getByRole('button', { name: locale === 'zh-CN' ? '完成' : 'Done', exact: true }).click();
		expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`declared Speech provider becomes available and activates on first Chat input (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?extensionOnly&locale=${locale}`);
		const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button');
		await expect(microphone).toBeDisabled();
		await page.evaluate(() => window.ashTableIntegration.extensionSpeech(true, true));
		await expect(microphone).toBeEnabled();
		expect(await page.evaluate(() => [window.ashTableIntegration.speechActivations, window.ashTableIntegration.extensionStarts])).toEqual([0, 0]);
		await microphone.click();
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.extensionStarts)).toBe(1);
		await page.evaluate(() => window.ashTableIntegration.transcript('你好', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('你好');
		expect(await page.evaluate(() => window.ashTableIntegration.starts)).toBe(0);
		await page.evaluate(() => window.ashTableIntegration.extensionSpeech(false));
		await expect(microphone).toBeDisabled();
	});
	test(`cancel during onSpeech activation prevents late capture and keeps the Chat draft (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?extensionOnly&locale=${locale}`);
		await page.evaluate(async () => { await window.ashTableIntegration.extensionSpeech(true, true); window.ashTableIntegration.holdSpeechActivation(); });
		const editor = page.getByRole('textbox', { name: 'Dictation draft' }); await editor.focus(); await page.keyboard.type('keep');
		await page.evaluate(() => { void window.ashTableIntegration.startDictation(); });
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.speechActivations)).toBe(1);
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button')).toBeDisabled();
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([true, true, false]);
		const stopped = page.evaluate(() => window.ashTableIntegration.cancelSpeechCommand());
		await page.evaluate(() => window.ashTableIntegration.releaseSpeechActivation());
		await stopped;
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button')).toBeEnabled();
		expect(await page.evaluate(() => [window.ashTableIntegration.starts, window.ashTableIntegration.extensionStarts])).toEqual([0, 0]);
		expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('keep');
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Speech language uses display locale and the next session reads an explicit preference (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?extensionOnly&locale=${locale}`);
		await page.evaluate(() => window.ashTableIntegration.extensionSpeech(true));
		await page.evaluate(() => window.ashTableIntegration.startDictation());
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.extensionLanguage)).toBe(locale === 'en' ? 'en-US' : 'zh-CN');
		await page.evaluate(() => window.ashTableIntegration.stopDictation());
		await page.evaluate(() => window.ashTableIntegration.setSpeechLanguage('tr-TR'));
		await page.evaluate(() => window.ashTableIntegration.startDictation());
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.extensionLanguage)).toBe('tr-TR');
		await page.evaluate(() => window.ashTableIntegration.stopDictation());
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Chat reports Speech activation before announcing real listening (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?extensionOnly&locale=${locale}`);
		await page.evaluate(async () => { await window.ashTableIntegration.extensionSpeech(true, true); window.ashTableIntegration.holdSpeechActivation(); });
		const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] button');
		const status = page.locator('#second-input').getByRole('status', { includeHidden: true });
		await microphone.click();
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.speechActivations)).toBe(1);
		await expect(status).toHaveText(locale === 'zh-CN' ? '正在启动听写…' : 'Starting dictation…');
		expect(await page.evaluate(() => [window.ashTableIntegration.extensionStarts, window.ashTableIntegration.starts])).toEqual([0, 0]);
		await page.evaluate(() => window.ashTableIntegration.releaseSpeechActivation());
		await expect(status).toHaveText(locale === 'zh-CN' ? '正在聆听…' : 'Listening…');
		await page.evaluate(() => window.ashTableIntegration.transcript('kept phrase', true));
		await expect.poll(() => page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('kept phrase');
		await page.evaluate(() => window.ashTableIntegration.cancelSpeechCommand());
		await expect(status).toHaveText(''); await expect(microphone).toBeEnabled();
		expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('kept phrase');
	});
}
