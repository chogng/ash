import { compileEditorClient } from '../../../build/builtin/editorClients.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAcademyExtension, startAcademyExtension } from '../../fixtures/academyExtension.js';
import { expect, test, type Page, type Locator } from "@playwright/test";
import { getAxeResults, injectAxe } from "axe-playwright";

const pageErrors = new WeakMap<object, string[]>();
const academyProcesses = new WeakMap<Page, Awaited<ReturnType<typeof startAcademyExtension>>>();
let academyClient: Awaited<ReturnType<typeof compileEditorClient>>;
let academyManifest: Record<string, unknown>;
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function chooseParagraphOption(page: Page, control: Locator, label: string): Promise<void> {
	await control.click();
	await page.getByRole('listbox').getByRole('option', { name: label, exact: true }).click();
}

// Compile the real provider before the UI scenario timer starts.
test.beforeAll(async () => {
	test.setTimeout(120_000);
	prepareAcademyExtension();
	academyClient = await compileEditorClient(resolve('extensions/academic'));
	academyManifest = JSON.parse(await readFile('extensions/academic/package.json', 'utf8'));
});

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", error => errors.push(error.stack ?? error.message));
	let generation = 0;
	let replacement = 0;
	const packageDigest = () => digest(JSON.stringify(academyClient.resources) + replacement);
	await page.route('**/__academy_catalog', async route => {
		const client = { ...academyClient.client, runtimeId: 'ash.academic' };
		await route.fulfill({
			json: {
				generation, diagnostics: [], extensions: [{
					id: 'ash.academic', name: 'academic', publisher: 'ash', version: '1.0.0', displayName: 'Academy', sourceKind: 'registry',
					manifestJson: JSON.stringify(academyManifest), manifestSha256: digest(JSON.stringify(academyManifest)), packageSha256: packageDigest(),
					rendererClient: academyProcesses.has(page) ? client : undefined,
				}]
			}
		});
	});
	await page.route('**/__academy_resource?*', async route => {
		const query = new URL(route.request().url()).searchParams;
		const content = academyClient.resources[query.get('path') ?? ''];
		if (query.get('generation') !== String(generation) || query.get('extensionId') !== 'ash.academic' || content === undefined || !academyProcesses.has(page)) {
			await route.fulfill({ status: 410, body: 'Retired package resource' });
			return;
		}
		await route.fulfill({ body: content, contentType: query.get('path')?.endsWith('.css') ? 'text/css' : 'text/javascript' });
	});
	const start = async (locale: string) => {
		let runtime = academyProcesses.get(page);
		if (!runtime) {
			runtime = await startAcademyExtension(locale);
			academyProcesses.set(page, runtime);
		}
		return runtime;
	};
	await page.route('**/__academy_extension?*', async route => {
		try {
			const locale = new URL(route.request().url()).searchParams.get('locale') ?? 'en';
			const change = route.request().method() === 'POST' ? route.request().postDataJSON() : { enabled: true };
			const enabled = change.enabled;
			if (change.replace) {
				replacement++;
				await academyProcesses.get(page)?.dispose();
				academyProcesses.delete(page);
			}
			if (!enabled) {
				await academyProcesses.get(page)?.dispose();
				academyProcesses.delete(page);
			}
			const runtime = enabled ? await start(locale) : undefined;
			await route.fulfill({
				json: {
					generation: ++generation, extensions: runtime ? [{
						id: 'ash.academic', version: '1.0.0', packageDigest: packageDigest(), runtimeApiVersion: 1,
						activationGeneration: generation, incarnation: generation, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [], registrations: runtime.registrations,
					}] : []
				}
			});
		} catch (error) { await route.fulfill({ status: 503, json: { error: String(error) } }); }
	});
	await page.route('**/__academy_invoke?*', async route => {
		try {
			const runtime = academyProcesses.get(page);
			if (!runtime) throw new Error('Academy is disabled');
			await route.fulfill({ json: await runtime.invoke('editor.client.v1', 'receiveData', route.request().postDataJSON()) });
		} catch (error) { await route.fulfill({ status: 503, json: { error: String(error) } }); }
	});
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => {
		window.ashAcademicIntegration?.dispose();
	}).catch(() => undefined);
	await academyProcesses.get(page)?.dispose();
	academyProcesses.delete(page);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

for (const kind of ['academic', 'general'] as const) for (const locale of ['en', 'zh-CN'] as const) {
	const name = kind === 'academic' ? locale === 'en' ? 'Academic Document' : '学术论文文档' : locale === 'en' ? 'Document' : '文档';
	test(`Rust Academy ${kind} disablement freezes the view and preserves dirty recovery in ${locale}`, async ({ page }) => {
		await page.goto(`/academic.html?${kind === 'general' ? 'generalDocument' : 'academicExtension'}&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademicIntegration);
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getAcademicRegistration())).toEqual({ name, routed: true });
		const original = await page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts());
		const input = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await input.fill('Draft paper');
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(['Draft paper', 'Body']);
		// A cursor move ends the typing group before the separate extension action.
		await input.evaluate(element => {
			const textarea = element as HTMLTextAreaElement;
			textarea.setSelectionRange(0, 0);
			textarea.dispatchEvent(new Event('select', { bubbles: true }));
		});
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredSelection())).toMatchObject({ head: { offset: 0 } });
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		await page.evaluate(() => window.ashAcademicIntegration.setAcademicEnabled(false));
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashAcademicIntegration.getAcademicRegistration())).toEqual({ name: undefined, routed: false });
		const bodyInput = page.locator('#document-editor textarea.stanza-document-text-input').nth(1);
		await expect(bodyInput).toHaveAttribute('readonly', '');
		expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredDirty())).toBe(true);
		expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredBackup())).toContain('Draft paper');
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		expect(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured())).toContain('Draft paper');
		expect(JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()))).toMatchObject({ format: 'ash.document', version: 2, documentType: kind });
		await page.evaluate(() => window.ashAcademicIntegration.setAcademicEnabled(true));
		expect(await page.evaluate(() => window.ashAcademicIntegration.getAcademicRegistration())).toEqual({ name, routed: true });
		// Re-enabling installs a new capability; the old view never resumes the retired instance.
		await expect(bodyInput).toHaveAttribute('readonly', '');
		await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		const recovered = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await expect(recovered).not.toHaveAttribute('readonly', '');
		await recovered.focus();
		await recovered.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(original);
	});
}

test('installed Academy package replacement retires its old view and releases its stylesheet after recovery', async ({ page }) => {
	await page.goto('/academic.html?academicExtension');
	await page.waitForFunction(() => !!window.ashAcademicIntegration);
	const original = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await original.fill('Draft survives an installed package replacement');
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademicIntegration.replaceAcademicPackage());
	await expect(original).toHaveAttribute('readonly', '');
	expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredDirty())).toBe(true);
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
	const recovered = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await expect(recovered).toHaveValue('Draft survives an installed package replacement');
	await expect(recovered).not.toHaveAttribute('readonly', '');
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
	expect(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured())).toContain('Draft survives an installed package replacement');
	await page.evaluate(() => window.ashAcademicIntegration.dispose());
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
});

test('same-source factory restart preserves collaborative undo and redo across old model history', async ({ page }) => {
	await page.goto('/academic.html?academicExtension');
	await page.waitForFunction(() => !!window.ashAcademicIntegration);
	const original = await page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts());
	await page.locator('#document-editor textarea.stanza-document-text-input').first().fill('Old factory history');
	await page.evaluate(() => window.ashAcademicIntegration.setAcademicEnabled(false));
	await page.evaluate(() => window.ashAcademicIntegration.setAcademicEnabled(true));
	await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
	const toolbar = page.locator('#document-editor .stanza-document-collaboration-toolbar');
	await toolbar.locator('[data-action-id="startCollaboration"] button').click();
	const join = page.getByRole('dialog', { name: 'Collaborate', exact: true });
	await join.getByRole('textbox').fill('restart-room');
	await join.getByRole('button', { name: 'OK', exact: true }).click();
	const endpoint = page.getByRole('dialog', { name: 'Collaboration server', exact: true });
	await endpoint.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(toolbar).toHaveAttribute('data-state', 'connected');
	const recovered = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await recovered.focus();
	await recovered.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(original);
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredCollaborationSubmissions().length)).toBe(1);
	await expect(toolbar).toHaveAttribute('data-state', 'connected');
	await recovered.press('ControlOrMeta+Shift+z');
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(['Old factory history', 'Body']);
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredCollaborationSubmissions().length)).toBe(2);
	await expect(toolbar).toHaveAttribute('data-state', 'connected');
});

for (const path of ['dist/editor.js', 'dist/editor.css']) test(`installed Academy rejects tampered ${path} before opening a document`, async ({ page }) => {
	await page.route('**/__academy_resource?*', async route => {
		if (new URL(route.request().url()).searchParams.get('path') === path) {
			await route.fulfill({ body: 'throw new Error("unverified bytes executed")', contentType: 'text/javascript' });
		} else await route.fallback();
	});
	const failure = page.waitForEvent('pageerror');
	await page.goto('/academic.html?academicExtension');
	expect((await failure).message).toBe('The editor component and extension versions do not match.');
	await expect(page.locator('#document-editor textarea')).toHaveCount(0);
	expect(pageErrors.get(page)).toHaveLength(1);
	pageErrors.set(page, []);
});

for (const [locale, message] of [
	['en', 'The editor component and extension versions do not match.'],
	['zh-CN', '编辑器组件与扩展的版本不匹配。'],
]) test(`Academy rejects a client component from a different executable build in ${locale}`, async ({ page }) => {
	await page.route('**/__academy_invoke?*', async route => {
		const runtime = academyProcesses.get(page)!;
		const result = await runtime.invoke('editor.client.v1', 'receiveData', route.request().postDataJSON());
		await route.fulfill({ json: { ...result, clientDigest: `sha256:${'b'.repeat(64)}` } });
	});
	const failure = page.waitForEvent('pageerror');
	await page.goto(`/academic.html?academicExtension&locale=${locale}`);
	expect((await failure).message).toBe(message);
	await expect(page.locator('#document-editor textarea')).toHaveCount(0);
	expect(pageErrors.get(page)).toHaveLength(1);
	pageErrors.set(page, []);
});

for (const [locale, name] of [['en', 'Document'], ['zh-CN', '文档']] as const) {
	test(`general documents route, edit, save, recover and reject conflicting content in ${locale}`, async ({ page }) => {
		await page.goto(`/academic.html?generalDocument&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademicIntegration);
		expect(await page.evaluate(() => window.ashAcademicIntegration.getAcademicRegistration())).toEqual({ name, routed: true });
		const input = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await input.fill('General draft');
		expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredDirty())).toBe(true);
		const backup = await page.evaluate(() => window.ashAcademicIntegration.getStructuredBackup());
		expect(JSON.parse(backup)).toMatchObject({ format: 'ash.document', version: 2, documentType: 'general' });
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredDirty())).toBe(false);
		await input.fill('Later change');
		await page.evaluate(() => window.ashAcademicIntegration.revertStructured());
		await expect(input).toHaveValue('General draft');
		await page.evaluate(content => window.ashAcademicIntegration.restoreStructuredBackup(content), backup);
		const conflicting = { ...JSON.parse(backup), documentType: 'academic' };
		await page.evaluate(content => window.ashAcademicIntegration.setExternalStructured(content), JSON.stringify(conflicting));
		const failure = await page.evaluate(async () => {
			try { await window.ashAcademicIntegration.revertStructured(); return ''; }
			catch (error) { return String(error); }
		});
		expect(failure).toContain(locale === 'zh-CN' ? '结构化文档类型' : 'Structured document type');
		await expect(input).toHaveValue('General draft');
	});
}

test("TextModel API and Academic code-block editing run in real browsers", async ({ page }) => {
	await page.goto("/academic.html");
	await expect(page.locator("#code-block textarea.stanza-document-text-input")).toBeVisible();
	await expect(page.locator("#code-block .stanza-editor")).toHaveCount(0);
	await expect(page.locator("#code-block .stanza-structured-format-toolbar")).toHaveAttribute("data-context", "code");
	await expect(page.locator("#code-block .stanza-structured-format-code-context")).toHaveText("Code block · Academic");
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.apiDocumentType)).toBe("doc");

	const codeBlockInput = page.locator("#code-block textarea.stanza-document-text-input");
	await codeBlockInput.focus();
	await page.keyboard.press("Home");
	await page.keyboard.type("// bridge\n");
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getCodeBlockText())).toBe("// bridge\nconst editor = 1;");
	await page.evaluate(() => window.ashAcademicIntegration.saveCodeBlock());
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getSavedCodeBlock())).toContain("// bridge\\nconst editor = 1;");

	const structuredInput = page.locator("#document-editor textarea.stanza-document-text-input").first();
	await structuredInput.focus();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(["Title", "", "Body"]);
	await page.keyboard.press("Control+z");
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(["Title", "Body"]);
});

test('Document links preserve editing and open through the product service with mouse and keyboard', async ({ page }) => {
	await page.goto('/academic.html?locale=zh-CN');
	const input = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await input.evaluate(element => {
		const textarea = element as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(0, 5);
		textarea.dispatchEvent(new Event('select', { bubbles: true }));
	});
	await page.locator("#document-editor [data-action-id='link'] button").click();
	const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
	const url = 'https://example.com/document?section=1#link';
	await dialog.getByRole('textbox').fill(url);
	await dialog.getByRole('button', { name: '确定', exact: true }).click();
	const link = page.locator('#document-editor a').filter({ hasText: 'Title' });
	await expect(link).toHaveAttribute('title', /点击.*Enter/u);
	await link.click();
	expect(await page.evaluate(() => window.ashAcademicIntegration.getOpenedLinks())).toEqual([]);
	await link.click({ modifiers: ['ControlOrMeta'] });
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getOpenedLinks())).toEqual([url]);
	await link.focus();
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getOpenedLinks())).toEqual([url, url]);
	await link.evaluate(element => {
		const selection = element.ownerDocument.getSelection()!;
		const range = element.ownerDocument.createRange();
		range.setStart(element.firstChild!, 2);
		range.collapse(true);
		element.parentElement!.focus();
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getOpenedLinks())).toEqual([url, url, url]);
	expect(await page.evaluate(() => window.ashAcademicIntegration.getStructuredBlockTexts())).toEqual(['Title', 'Body']);
});

test('Document contributions mount the rich editor and release its views', async ({ page }) => {
	await page.goto('/academic.html');
	const ids = await page.evaluate(() => window.ashAcademicIntegration.getBundleIds());
	expect(ids).not.toContain('editor.contrib.documentFormatting');
	expect(ids).not.toContain('editor.contrib.paragraphStyle');
	expect(ids).not.toContain('editor.contrib.paragraphFormatting');
	await expect(page.locator('#document-editor .stanza-document-paragraph-style')).toHaveCount(1);
	await expect(page.locator('#document-editor .stanza-document-paragraph-formatting')).toHaveCount(1);
	expect(ids).not.toContain('editor.contrib.collaboration');
	expect(ids).not.toContain('editor.contrib.clipboard');
	expect(ids).not.toContain('editor.contrib.findController');
	await expect(page.locator('#document-editor .stanza-structured-format-toolbar')).toHaveAttribute('role', 'group');
	await expect(page.locator('#document-editor .stanza-document-collaboration-toolbar')).toHaveAttribute('role', 'group');
	await expect(page.locator('.stanza-editor')).toHaveCount(0);

	await page.evaluate(() => window.ashAcademicIntegration.dispose());
	await expect(page.locator('.stanza-structured-format-toolbar')).toHaveCount(0);
	await expect(page.locator('.stanza-document-collaboration-toolbar')).toHaveCount(0);
	await expect(page.locator('.stanza-document-format-controls')).toHaveCount(0);
});

for (const [locale, labels] of [['en', ['Paragraph style', 'Alignment', 'Line spacing', 'Space before', 'Space after']], ['zh-CN', ['段落样式', '对齐方式', '行距', '段前间距', '段后间距']]] as const) {
	test(`Academy paragraph contributions persist styles, layout, selection and undo in ${locale}`, async ({ page }) => {
		await page.goto(`/academic.html?generalDocument&locale=${locale}`);
		const root = page.locator('#document-editor');
		const input = root.locator('textarea.stanza-document-text-input').first();
		await input.evaluate(element => {
			const textarea = element as HTMLTextAreaElement;
			textarea.focus();
			textarea.setSelectionRange(1, 4);
			textarea.dispatchEvent(new Event('select', { bubbles: true }));
		});
		const style = root.getByRole('combobox', { name: labels[0], exact: true });
		await chooseParagraphOption(page, style, locale === 'en' ? 'Heading 2' : '标题 2');
		await expect(root.locator('.stanza-document-heading')).toHaveAttribute('aria-level', '2');
		await expect(root.locator('.stanza-document-outline-entry')).toContainText('Title');
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredSelection())).toMatchObject({ anchor: { offset: 1 }, head: { offset: 4 } });
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels[1], exact: true }), locale === 'en' ? 'Center' : '居中');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels[2], exact: true }), '2');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels[3], exact: true }), locale === 'en' ? '6 pt' : '6 磅');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels[4], exact: true }), locale === 'en' ? '18 pt' : '18 磅');
		const heading = root.locator('.stanza-document-heading');
		await expect(heading).toHaveCSS('text-align', 'center');
		await expect(heading).toHaveCSS('margin-block-start', '8px');
		await expect(heading).toHaveCSS('margin-block-end', '24px');
		await expect(heading.locator('textarea')).toHaveCSS('text-align', 'center');
		const fontSize = await heading.locator('textarea').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
		await expect(heading.locator('textarea')).toHaveCSS('line-height', `${fontSize * 2}px`);
		// One undo removes only the most recent paragraph change and clears reused DOM styles.
		await heading.locator('textarea').focus();
		await page.keyboard.press('Control+z');
		await expect(heading).toHaveCSS('margin-block-end', '12px');
		await page.keyboard.press('Control+Shift+z');
		await expect(heading).toHaveCSS('margin-block-end', '24px');
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()));
		expect(saved.document.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2, textAlign: 'center', lineSpacing: 2, spaceBefore: 6, spaceAfter: 18 } });
		await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
		await expect(heading).toHaveCSS('margin-block-end', '24px');
		await expect(style).toContainText(locale === 'en' ? 'Heading 2' : '标题 2');
		await chooseParagraphOption(page, style, locale === 'en' ? 'Normal' : '正文');
		await expect(root.locator('.stanza-document-heading')).toHaveCount(0);
		await expect(root.locator('.stanza-document-paragraph').first()).toHaveCSS('text-align', 'center');
	});
}

test('Academy paragraph contributions respect read-only input and release retained controls', async ({ page }) => {
	await page.goto('/academic.html?generalDocument&readOnly');
	const root = page.locator('#document-editor');
	const style = root.getByRole('combobox', { name: 'Paragraph style', exact: true });
	await expect(style).toBeDisabled();
	await expect(root.getByRole('combobox', { name: 'Alignment', exact: true })).toBeDisabled();
	await style.evaluate(element => {
		element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await expect(root.locator('.stanza-document-heading')).toHaveCount(0);
	await style.evaluate(element => {
		window.ashAcademicIntegration.dispose();
		(element as HTMLButtonElement).disabled = false;
		element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await expect(page.locator('.stanza-document-format-controls')).toHaveCount(0);
});

test('Academy paragraph contributions format a reversed cross-paragraph selection atomically', async ({ page }) => {
	await page.goto('/academic.html?generalDocument&richParagraphs');
	const root = page.locator('#document-editor');
	await expect(root.locator('.stanza-document-rich-text-input')).toHaveCount(2);
	await root.evaluate(element => {
		const runs = element.querySelectorAll('.stanza-document-inline-run');
		(element.querySelectorAll<HTMLElement>('.stanza-document-rich-text-input')[1]!).focus();
		element.ownerDocument.getSelection()!.setBaseAndExtent(runs[1]!.firstChild!, 2, runs[0]!.firstChild!, 1);
		element.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paragraph style', exact: true }), 'Heading 3');
	await expect(root.locator('.stanza-document-heading')).toHaveCount(2);
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Alignment', exact: true }), 'End');
	for (const heading of await root.locator('.stanza-document-heading').all()) await expect(heading).toHaveCSS('text-align', 'end');
	await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
	let saved = JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()));
	expect(saved.document.content.map((node: { attrs: unknown; }) => node.attrs)).toEqual([{ level: 3, textAlign: 'end' }, { level: 3, textAlign: 'end' }]);
	expect(saved.document.content.map((node: { content: { marks: unknown; }[]; }) => node.content[0]!.marks)).toEqual([[{ type: 'strong', attrs: {} }], [{ type: 'strong', attrs: {} }]]);
	const editor = root.locator('.stanza-document-rich-text-input').first();
	await editor.focus();
	await page.keyboard.press('Control+z');
	await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
	saved = JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()));
	expect(saved.document.content.map((node: { attrs: unknown; }) => node.attrs)).toEqual([{ level: 3 }, { level: 3 }]);
});

test('Academy paragraph controls support keyboard style selection without stealing focus', async ({ page }) => {
	await page.goto('/academic.html?generalDocument');
	const style = page.locator('#document-editor').getByRole('combobox', { name: 'Paragraph style', exact: true });
	await style.focus();
	await style.press('End');
	await page.keyboard.press('Enter');
	await expect(style).toContainText('Heading 6');
	await expect(style).toBeFocused();
	await expect(page.locator('#document-editor .stanza-document-heading')).toHaveAttribute('aria-level', '6');
	await style.press('Home');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(style).toContainText('Normal');
	await expect(page.locator('#document-editor .stanza-document-heading')).toHaveCount(0);
});

test("Academic TextModel editor persists selected font, size, and emphasis formatting", async ({ page }) => {
	await page.goto("/academic.html");
	const input = page.locator("#document-editor textarea.stanza-document-text-input").first();
	const fontFamily = page.locator("#document-editor select[aria-label='Font family']");
	const fontSize = page.locator("#document-editor select[aria-label='Font size']");
	await input.evaluate(element => {
		const textarea = element as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(0, 5);
		textarea.dispatchEvent(new Event("select", { bubbles: true }));
	});
	await fontFamily.selectOption("serif");
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredFirstTextMarks())).toEqual([
		{ type: "textStyle", attrs: { fontFamily: "serif" } },
	]);
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredSelection())).toMatchObject({ kind: "text", anchor: { offset: 0 }, head: { offset: 5 } });
	await fontSize.selectOption("18");
	await expect(fontSize).toHaveValue("18");
	const bold = page.locator("#document-editor [data-action-id='bold'] button");
	await bold.click();

	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredFirstTextMarks())).toEqual([
		{ type: "textStyle", attrs: { fontFamily: "serif", fontSize: 18 } },
		{ type: "strong", attrs: {} },
	]);

	const styled = page.locator("#document-editor .stanza-document-mark-textStyle[data-font-family='serif']");
	await expect(styled).toHaveText("Title");
	await expect(styled).toHaveCSS("font-size", "18px");
	await expect(bold).toHaveAttribute("aria-pressed", "true");
});

test("Academic TextModel editor exposes collaboration as a separate contribution", async ({ page }) => {
	await page.goto("/academic.html");
	const toolbar = page.locator("#document-editor .stanza-document-collaboration-toolbar");
	const start = toolbar.locator("[data-action-id='startCollaboration'] button");
	await expect(toolbar).toHaveAttribute("data-state", "inactive");
	await start.click();
	const dialog = page.getByRole('dialog', { name: 'Collaborate', exact: true });
	await dialog.getByRole('textbox').fill('editor-browser-room');
	await dialog.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(toolbar).toHaveAttribute("data-state", "connected");
	await expect(toolbar.locator(".stanza-document-collaboration-status")).toHaveText("Room: editor-browser-room");
});

test("Academic TextModel editor exposes room-owner invitations", async ({ page }) => {
	await page.goto("/academic.html");
	const toolbar = page.locator("#document-editor .stanza-document-collaboration-toolbar");
	await toolbar.locator("[data-action-id='startCollaboration'] button").click();
	const join = page.getByRole('dialog', { name: 'Collaborate', exact: true });
	await join.getByRole('textbox').fill('editor-browser-room');
	await join.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(toolbar.locator("[data-action-id='inviteCollaborator'] button")).toBeVisible();
	await toolbar.locator("[data-action-id='inviteCollaborator'] button").click();
	const invitation = page.getByRole('dialog', { name: 'Invite collaborator', exact: true });
	await invitation.getByRole('textbox', { name: 'Name', exact: true }).fill('Writer');
	await invitation.getByRole('textbox', { name: 'Role', exact: true }).fill('viewer');
	await invitation.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(toolbar.locator(".stanza-document-collaboration-status")).toContainText("Invitation created for Writer");
	await expect(toolbar.locator(".stanza-document-collaboration-invitation-token")).toHaveText("Room ID: editor-browser-room\nAccess token: editor-browser-member-token");
	await toolbar.locator("[data-action-id='manageCollaborators'] button").click();
	await expect(toolbar.locator("[data-principal-id='browser-member']")).toContainText("Writereditor · browser-member");
	await toolbar.locator("[data-principal-id='browser-member'] button").first().click();
	await expect(toolbar.locator(".stanza-document-collaboration-invitation-token")).toHaveText("Room ID: editor-browser-room\nAccess token: editor-browser-rotated-token");
});

test("Academic TextModel editor has the accessibility contract", async ({ page }) => {
	await page.goto("/academic.html");
	const toolbar = page.locator("#document-editor .stanza-structured-format-toolbar");
	const structuredInput = page.locator("#document-editor textarea.stanza-document-text-input").first();
	await expect(toolbar).toHaveAttribute("role", "group");
	await expect(toolbar).toHaveAttribute("aria-label", "Document formatting");
	await expect(toolbar.locator(".stanza-structured-format-inline-actions")).toHaveAttribute("role", "toolbar");
	await expect(toolbar.locator(".stanza-structured-format-document-actions button")).toHaveCount(13);
	await expect(toolbar.locator("select[aria-label='Font family']")).toBeVisible();
	await expect(toolbar.locator("select[aria-label='Font size']")).toBeVisible();
	await expect(structuredInput).toBeVisible();

	await injectAxe(page);
	const accessibility = await getAxeResults(page, undefined, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
	expect(accessibility.violations.filter(violation => violation.impact === "critical")).toEqual([]);
	const contrast = await getAxeResults(page, undefined, { runOnly: { type: "rule", values: ["color-contrast"] } });
	expect(contrast.violations).toEqual([]);
});


for (const [locale, link] of [['en', 'Link current document'], ['zh-CN', '关联当前文档']] as const) {
	test(`call documents preserve dirty copies and support keyboard actions in ${locale}`, async ({ page }, testInfo) => {
		await page.goto(`/academic.html?callDocuments&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademicIntegration);
		const toolbar = page.locator('#document-editor .stanza-document-collaboration-toolbar');
		await toolbar.locator('[data-action-id="startCollaboration"] button').click();
		const join = page.getByRole('dialog', { name: 'Collaborate', exact: true });
		await join.getByRole('textbox').fill('editor-browser-room');
		await join.getByRole('button', { name: locale === 'en' ? 'OK' : '确定', exact: true }).click();
		await expect(toolbar.locator('.stanza-document-collaboration-status')).toContainText('editor-browser-room');
		const original = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await original.fill('Unsaved local research');
		const calls = page.locator('#call-view');
		await calls.getByRole('button', { name: link, exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(calls.locator('.call-document')).toHaveCount(1);
		const opener = calls.getByRole('button', { name: 'Open Paper', exact: true }).or(calls.getByRole('button', { name: '打开 Paper', exact: true }));
		await opener.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getCallDocumentState().joinedResource)).toBe('untitled');
		await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getCallDocumentState().joinedTexts[0])).toBe('Unsaved local research');
		await expect(original).toHaveValue('Unsaved local research');
		expect(await page.evaluate(() => window.ashAcademicIntegration.getCallDocumentState().originalDirty)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath('call-documents.png'), fullPage: true });
		const remove = calls.getByRole('button', { name: 'Unlink Paper', exact: true }).or(calls.getByRole('button', { name: '取消关联 Paper', exact: true }));
		await remove.focus();
		await page.keyboard.press('Enter');
		await expect(calls.locator('.call-document')).toHaveCount(0);
		await expect(calls.getByRole('button', { name: link, exact: true })).toBeFocused();
		await expect(page.locator('#call-document-editor textarea.stanza-document-text-input').first()).toHaveValue('Unsaved local research');
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Academy M6 custom style definitions and overrides survive input and reopening in ${locale}`, async ({ page }) => {
		await page.goto(`/academic.html?generalDocument&locale=${locale}`);
		const root = page.locator('#document-editor');
		const label = (en: string, zh: string) => locale === 'en' ? en : zh;
		const control = (en: string, zh: string) => root.getByRole('combobox', { name: label(en, zh), exact: true });
		const baseline = await root.locator('.stanza-document-paragraph').first().boundingBox();
		await chooseParagraphOption(page, control('Paragraph font', '段落字体'), label('Serif', '衬线体'));
		await chooseParagraphOption(page, control('Paragraph font size', '段落字号'), '18');
		await chooseParagraphOption(page, control('Start indent', '起始端缩进'), label('36 pt', '36 磅'));
		await chooseParagraphOption(page, control('First line indent', '首行缩进'), label('-18 pt', '-18 磅'));
		await root.getByRole('textbox', { name: label('Style name', '样式名称'), exact: true }).fill('Essay');
		await root.getByRole('button', { name: label('Create style', '创建样式'), exact: true }).click();
		await expect(control('Paragraph style', '段落样式')).toContainText('Essay');
		const first = root.locator('.stanza-document-paragraph').first();
		await expect(first).toHaveCSS('padding-inline-start', '48px');
		expect((await first.boundingBox())!.x).toBe(baseline!.x);
		expect((await first.boundingBox())!.width).toBe(baseline!.width);
		await expect(first.locator('textarea')).toHaveCSS('text-indent', '-24px');
		await expect(first.locator('textarea')).toHaveCSS('padding-inline-start', '24px');
		await expect(first.locator('textarea')).toHaveCSS('margin-inline-start', '-24px');
		await expect(first.locator('textarea')).toHaveCSS('font-size', '18px');
		await first.locator('textarea').fill('Edited essay');
		await chooseParagraphOption(page, control('Start indent', '起始端缩进'), label('54 pt', '54 磅'));
		await expect(first).toHaveCSS('padding-inline-start', '72px');
		await root.getByRole('button', { name: label('Reset paragraph overrides', '重置段落局部格式'), exact: true }).click();
		await expect(first).toHaveCSS('padding-inline-start', '48px');
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()));
		expect(JSON.parse(saved.document.attrs.paragraphStyles)[0]).toMatchObject({ name: 'Essay', attrs: { indentStart: 36, firstLineIndent: -18 } });
		expect(saved.document.content[0].attrs).toEqual({ styleId: JSON.parse(saved.document.attrs.paragraphStyles)[0].id });
		await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
		await expect(first.locator('textarea')).toHaveValue('Edited essay');
		await expect(first).toHaveCSS('padding-inline-start', '48px');
		await root.getByRole('button', { name: label('Delete style', '删除样式'), exact: true }).click();
		await expect(first).toHaveCSS('padding-inline-start', '48px');
		await first.locator('textarea').focus();
		await page.keyboard.press('Control+z');
		await expect(control('Paragraph style', '段落样式')).toContainText('Essay');
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Academy M6 rich find replaces marked text, list, table and parent-model code atomically in ${locale}`, async ({ page }) => {
		await page.goto(`/academic.html?generalDocument&m6Document&locale=${locale}`);
		const root = page.locator('#document-editor');
		const label = (en: string, zh: string) => locale === 'en' ? en : zh;
		const button = (en: string, zh: string) => root.getByRole('button', { name: label(en, zh), exact: true });
		await root.locator('.stanza-document-rich-text-input').first().focus();
		await page.keyboard.press('Control+f');
		const query = root.getByRole('searchbox', { name: label('Find text', '查找文本'), exact: true });
		await expect(query).toBeFocused();
		await query.fill('hello');
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toContainText(locale === 'en' ? 'of 5 matches' : '共 5 个匹配');
		await button('Match case', '区分大小写').click();
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toContainText(locale === 'en' ? 'of 0 matches' : '共 0 个匹配');
		await button('Match case', '区分大小写').click();
		await query.fill('Hel');
		await button('Whole word', '全字匹配').click();
		await expect(button('Replace all', '全部替换')).toBeDisabled();
		await query.fill('Hello');
		await query.press('Enter');
		await expect(query).toBeFocused();
		await expect(root.locator('.stanza-document-find-current')).toHaveCount(2);
		await expect(root.locator('.stanza-document-find-current').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await root.getByRole('textbox', { name: label('Replace with', '替换为'), exact: true }).fill('World');
		await page.screenshot({ path: `.build/academy-m6-find-${locale}.png`, fullPage: true });
		await button('Replace', '替换').click();
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toContainText(locale === 'en' ? 'of 4 matches' : '共 4 个匹配');
		await button('Replace all', '全部替换').click();
		await expect(button('Replace all', '全部替换')).toBeDisabled();
		await button('Close find', '关闭查找').click();
		await page.keyboard.press('Control+z');
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademicIntegration.getSavedStructured()));
		expect(saved.document.content[0].content.map((node: { text: string; }) => node.text).join('')).toBe('World Hello');
		expect(saved.document.content[0].content[0].marks).toEqual([{ type: 'strong', attrs: {} }]);
		expect(saved.document.content[3].content).toHaveLength(1);
		expect(saved.document.content[3].content[0].text).toBe('Hello code');
		await page.keyboard.press('Control+Shift+z');
		await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
		await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
		await button('Find and replace', '查找与替换').click();
		await root.getByRole('searchbox', { name: label('Find text', '查找文本'), exact: true }).fill('World');
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toContainText(locale === 'en' ? 'of 5 matches' : '共 5 个匹配');
		await page.keyboard.press('Escape');
		await expect(root.locator('.stanza-document-find-fields')).toBeHidden();
	});
}

test('Academy M6 list numbering persists native markers, typing, undo and restart values', async ({ page }) => {
	await page.goto('/academic.html?generalDocument&m6Document');
	const root = page.locator('#document-editor');
	const input = root.locator('[data-node-id="m6-item"] textarea');
	await input.focus();
	const order = root.getByRole('spinbutton', { name: 'Start numbering at', exact: true });
	await order.fill('5');
	await order.press('Tab');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Number format', exact: true }), 'I, II, III');
	const list = root.locator('ol[data-node-id="m6-list"]');
	await expect(list).toHaveAttribute('start', '5');
	await expect(list).toHaveCSS('list-style-type', 'upper-roman');
	await input.focus();
	await input.press('End');
	await page.keyboard.press('Enter');
	await expect(list.locator('li')).toHaveCount(2);
	await page.keyboard.type('Next');
	await page.evaluate(() => window.ashAcademicIntegration.saveStructured());
	await page.evaluate(() => window.ashAcademicIntegration.reopenStructured());
	await expect(list).toHaveAttribute('start', '5');
	await expect(list).toHaveCSS('list-style-type', 'upper-roman');
	await input.focus();
	await order.fill('1');
	await order.press('Tab');
	await expect(list).toHaveAttribute('start', '1');
	await input.focus();
	await page.keyboard.press('Control+z');
	await expect(list).toHaveAttribute('start', '5');
});

test('Academy M6 read-only and retired packages allow search but reject retained replacement actions', async ({ page }) => {
	await page.goto('/academic.html?generalDocument&readOnly');
	const root = page.locator('#document-editor');
	await root.getByRole('button', { name: 'Find and replace', exact: true }).click();
	const query = root.getByRole('searchbox', { name: 'Find text', exact: true });
	await query.fill('Title');
	await query.press('Enter');
	await expect(root.getByRole('button', { name: 'Next match', exact: true })).toBeEnabled();
	await expect(root.getByRole('button', { name: 'Replace all', exact: true })).toBeDisabled();
	await expect(root.getByRole('textbox', { name: 'Style name', exact: true })).toBeDisabled();
	await expect.poll(() => page.evaluate(() => window.ashAcademicIntegration.getStructuredDirty())).toBe(false);
	await page.evaluate(() => window.ashAcademicIntegration.setAcademicEnabled(false));
	await expect(root.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
	await page.evaluate(() => window.ashAcademicIntegration.dispose());
	await expect(root.locator('.stanza-document-find-fields')).toHaveCount(0);
});


for (const theme of ['hc', 'hcLight']) {
	test(`Academy M6 search keyboard navigation retains visible match boundaries in ${theme}`, async ({ page }) => {
		await page.goto(`/academic.html?generalDocument&m6Document&${theme}`);
		const root = page.locator('#document-editor');
		await root.locator('.stanza-document-rich-text-input').first().focus();
		await page.keyboard.press('Control+f');
		const query = root.getByRole('searchbox', { name: 'Find text', exact: true });
		await query.fill('Hello');
		await query.press('Enter');
		const highlight = root.locator('.stanza-document-find-current').first();
		await expect(highlight).toHaveCSS('outline-style', 'solid');
		await expect(highlight).toHaveCSS('outline-width', '1px');
		await expect(highlight).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
		await query.press('Shift+Enter');
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toHaveText('5 of 5 matches');
		await query.press('Escape');
		await expect(root.locator('[data-node-id="m6-code"] textarea')).toBeFocused();
	});
}
