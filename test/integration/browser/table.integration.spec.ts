import { expect, test } from '@playwright/test';
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.describe('renderer audio capture', () => {
	test('the dictation menu measures a live audio stream without starting transcription', async ({ page }) => {
		await page.goto('/table.html?realAudio');
		const signal = await page.evaluateHandle(() => {
			const context = new AudioContext();
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const input = context.createMediaStreamDestination();
			gain.gain.value = 0;
			oscillator.connect(gain).connect(input);
			oscillator.start();
			navigator.mediaDevices.getUserMedia = async () => {
				await context.resume();
				return input.stream;
			};
			return { context, gain, input };
		});
		try {
			await page.locator('#second-input').getByRole('button', { name: 'Dictation settings', exact: true }).click();
			const meter = page.getByRole('meter', { name: 'Microphone input level', exact: true });
			const level = () => meter.evaluate(element => (element as HTMLMeterElement).value);
			expect(await level()).toBe(0);
			await signal.evaluate(({ gain }) => { gain.gain.value = 0.1; });
			await expect.poll(level).toBeGreaterThan(0);
			await signal.evaluate(({ gain }) => { gain.gain.value = 0; });
			await expect.poll(level).toBe(0);
			expect(await page.evaluate(() => [window.ashTableIntegration.starts, window.ashTableIntegration.audioPackets])).toEqual([0, 0]);
			await page.keyboard.press('Escape');
			await expect.poll(() => signal.evaluate(({ input }) => input.stream.getAudioTracks()[0]?.readyState)).toBe('ended');
		} finally {
			await signal.evaluate(({ context }) => context.close());
			await signal.dispose();
		}
	});

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
	const microphone = second.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
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
	await second.getByRole('button', { name: 'Stop dictation', exact: true }).click();
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
	const microphone = second.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
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

test('first dictation starts from the microphone and writes directly to the draft', async ({ page }) => {
	await page.goto('/table.html?locale=zh-CN');
	const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
	await microphone.click();
	await expect(page.getByRole('region', { name: '听写入门', exact: true })).toHaveCount(0);
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => page.evaluate(() => window.ashTableIntegration.starts)).toBe(1);
	await page.evaluate(() => window.ashTableIntegration.transcript('首次听写', true));
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('首次听写');
	expect(await page.evaluate(() => window.ashTableIntegration.stops)).toBe(1);
});

test('repeated editor dictation commands share capture', async ({ page }) => {
	await page.goto('/table.html');
	await page.evaluate(async () => {
		await Promise.all([window.ashTableIntegration.codeDictation(), window.ashTableIntegration.codeDictation()]);
		await window.ashTableIntegration.codeDictation();
	});
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
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action')).toBeEnabled();
		await page.evaluate(() => window.ashTableIntegration.transcript('stale', true));
		expect(await page.evaluate(() => window.ashTableIntegration.codeText)).toBe('first second');
		expect(await page.evaluate(() => window.ashTableIntegration.extensionStarts)).toBe(2);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`declared Speech provider becomes available and activates on first Chat input (${locale})`, async ({ page }) => {
		await page.goto(`/table.html?extensionOnly&locale=${locale}`);
		const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
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
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action')).toBeDisabled();
		expect(await page.evaluate(() => window.ashTableIntegration.speechFlags)).toEqual([true, true, false]);
		const stopped = page.evaluate(() => window.ashTableIntegration.cancelSpeechCommand());
		await page.evaluate(() => window.ashTableIntegration.releaseSpeechActivation());
		await stopped;
		await expect(page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action')).toBeEnabled();
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
		const microphone = page.locator('#second-input [data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
		const status = page.locator('#second-input .ash-chat-status-summary');
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
