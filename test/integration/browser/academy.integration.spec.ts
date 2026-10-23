import { getDocument as loadPdf, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
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
	const project = resolve(process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT ?? 'extensions/academy');
	academyClient = process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT ? {
		client: JSON.parse(await readFile(resolve(project, 'dist/client.json'), 'utf8')),
		resources: { 'dist/editor.js': await readFile(resolve(project, 'dist/editor.js'), 'utf8'), 'dist/editor.css': await readFile(resolve(project, 'dist/editor.css'), 'utf8') },
	} : await compileEditorClient(project);
	academyManifest = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
});

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", error => errors.push(error.stack ?? error.message));
	let generation = 0;
	let replacement = 0;
	const packageDigest = () => digest(JSON.stringify(academyClient.resources) + replacement);
	await page.route('**/__academy_catalog', async route => {
		const client = { ...academyClient.client, runtimeId: 'ash.academy' };
		await route.fulfill({
			json: {
				generation, diagnostics: [], extensions: [{
					id: 'ash.academy', name: 'academy', publisher: 'ash', version: '1.0.0', displayName: 'Academy', sourceKind: 'registry',
					manifestJson: JSON.stringify(academyManifest), manifestSha256: digest(JSON.stringify(academyManifest)), packageSha256: packageDigest(),
					rendererClient: academyProcesses.has(page) ? client : undefined,
				}]
			}
		});
	});
	await page.route('**/__academy_resource?*', async route => {
		const query = new URL(route.request().url()).searchParams;
		const content = academyClient.resources[query.get('path') ?? ''];
		if (query.get('generation') !== String(generation) || query.get('extensionId') !== 'ash.academy' || content === undefined || !academyProcesses.has(page)) {
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
						id: 'ash.academy', version: '1.0.0', packageDigest: packageDigest(), runtimeApiVersion: 1,
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
		window.ashAcademyIntegration?.dispose();
	}).catch(() => undefined);
	await academyProcesses.get(page)?.dispose();
	academyProcesses.delete(page);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`Academy references edit, renumber and recover through the installed package in ${locale}`, async ({ page }, testInfo) => {
	await page.goto(`/academy.html?academyExtension&locale=${locale}`);
	await page.waitForFunction(() => !!window.ashAcademyIntegration);
	const chinese = locale === 'zh-CN';
	const ok = chinese ? '确定' : 'OK';
	const editor = page.locator('#document-editor');
	await editor.locator('textarea.stanza-document-text-input').last().focus();
	const action = (id: string) => editor.locator(`[data-action-id="${id}"] button`);
	const add = async (key: string, text: string) => {
		await action('reference').click();
		const dialog = page.getByRole('dialog', { name: chinese ? '参考文献' : 'Reference', exact: true });
		await dialog.getByRole('textbox').nth(0).fill(key);
		await dialog.getByRole('textbox').nth(1).fill(text);
		await dialog.getByRole('button', { name: ok, exact: true }).click();
	};
	await add('first', 'First reference');
	await add('second', 'Second reference');
	await expect(editor.locator('.ash-citation-reference')).toHaveCount(2);
	const body = editor.locator('textarea.stanza-document-text-input').last();
	await body.evaluate(element => {
		const input = element as HTMLTextAreaElement;
		input.focus(); input.setSelectionRange(input.value.length, input.value.length);
		input.dispatchEvent(new Event('select', { bubbles: true }));
	});
	await action('citation').click();
	const citationDialog = page.getByRole('dialog', { name: chinese ? '引用' : 'Citation', exact: true });
	await citationDialog.getByRole('textbox').first().fill('second');
	await citationDialog.getByRole('button', { name: ok, exact: true }).click();
	const citation = editor.locator('.ash-citation');
	await expect(citation).toHaveText('[2]');
	await expect(citation).toHaveAttribute('aria-label', /Second reference/);

	await action('editReference').click();
	let dialog = page.getByRole('dialog', { name: chinese ? '编辑参考文献' : 'Edit reference', exact: true });
	await dialog.getByRole('textbox').fill('second');
	await dialog.getByRole('button', { name: ok, exact: true }).click();
	dialog = page.getByRole('dialog', { name: chinese ? '编辑参考文献' : 'Edit reference', exact: true });
	await expect(dialog.getByRole('textbox').nth(0)).toHaveValue('second');
	await dialog.getByRole('textbox').nth(0).fill('renamed');
	await dialog.getByRole('textbox').nth(1).fill('Updated reference');
	await dialog.getByRole('button', { name: ok, exact: true }).click();
	await expect(citation).toHaveAttribute('data-citation-key', 'renamed');
	await expect(citation).toHaveAttribute('aria-label', /Updated reference/);
	await body.focus(); await body.press('ControlOrMeta+z');
	await expect(citation).toHaveAttribute('data-citation-key', 'second');
	await body.press('ControlOrMeta+Shift+z');
	await expect(citation).toHaveAttribute('data-citation-key', 'renamed');
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	const saved = await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured());
	expect(saved).toContain('Updated reference');
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
	await expect(citation).toHaveText('[2]');
	await expect(citation).toHaveAttribute('data-citation-key', 'renamed');

	const beforeDuplicate = await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion());
	await add('renamed', 'Duplicate must not replace the existing entry');
	await expect(page.getByRole('dialog')).toContainText(chinese ? '请输入非空且唯一的文献键' : 'Enter a non-empty, unique reference key');
	await page.getByRole('dialog').getByRole('button', { name: ok, exact: true }).click();
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion())).toBe(beforeDuplicate);
	await expect(editor.locator('.ash-citation-reference')).toHaveCount(2);

	const remove = async (key: string) => {
		await action('deleteReference').click();
		const choose = page.getByRole('dialog', { name: chinese ? '删除参考文献' : 'Delete reference', exact: true });
		await choose.getByRole('textbox').fill(key);
		await choose.getByRole('button', { name: ok, exact: true }).click();
		await page.getByRole('dialog').getByRole('button', { name: chinese ? '删除参考文献' : 'Delete reference', exact: true }).click();
	};
	await remove('first');
	await expect(citation).toHaveText('[1]');
	await remove('renamed');
	await expect(editor.locator('.ash-citation-bibliography')).toHaveCount(0);
	await expect(citation).toHaveText('[renamed]');
	await expect(citation).toHaveAttribute('aria-invalid', 'true');
	await expect(citation).toHaveAttribute('aria-label', chinese ? '未解析的引用 renamed' : 'Unresolved citation renamed');
	await citation.focus();
	await expect(citation).toBeFocused();
	await citation.press('Enter');
	await expect(citation).toHaveClass(/stanza-document-inline-node-selected/);
	await page.screenshot({ path: testInfo.outputPath(`academy-references-${locale}.png`), fullPage: true });
	await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
	for (const id of ['citation', 'reference', 'editReference', 'deleteReference']) await expect(action(id)).toBeDisabled();
});

for (const kind of ['academy', 'general'] as const) for (const locale of ['en', 'zh-CN'] as const) {
	const name = kind === 'academy' ? locale === 'en' ? 'Academy Document' : 'Academy 文档' : locale === 'en' ? 'Document' : '文档';
	test(`Rust Academy ${kind} disablement freezes the view and preserves dirty recovery in ${locale}`, async ({ page }) => {
		await page.goto(`/academy.html?${kind === 'general' ? 'generalDocument' : 'academyExtension'}&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademyIntegration);
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getAcademyRegistration())).toEqual({ name, routed: true });
		const help = await page.evaluate(() => window.ashAcademyIntegration.getStructuredAccessibilityHelp());
		expect(help.join('\n')).toContain(locale === 'zh-CN' ? '段落' : 'Paragraph');
		expect(help.some(line => line.includes(locale === 'zh-CN' ? 'Academy 文档提供' : 'Academy documents provide'))).toBe(kind === 'academy');
		const original = await page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts());
		const input = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await input.fill('Draft paper');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(['Draft paper', 'Body']);
		// A cursor move ends the typing group before the separate extension action.
		await input.evaluate(element => {
			const textarea = element as HTMLTextAreaElement;
			textarea.setSelectionRange(0, 0);
			textarea.dispatchEvent(new Event('select', { bubbles: true }));
		});
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { offset: 0 } });
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		expect(await page.evaluate(() => window.ashAcademyIntegration.getAcademyRegistration())).toEqual({ name: undefined, routed: false });
		const bodyInput = page.locator('#document-editor textarea.stanza-document-text-input').nth(1);
		await expect(bodyInput).toHaveAttribute('readonly', '');
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredDirty())).toBe(true);
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toContain('Draft paper');
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		expect(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured())).toContain('Draft paper');
		expect(JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()))).toMatchObject({ format: 'ash.document', version: 2, documentType: kind });
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(true));
		expect(await page.evaluate(() => window.ashAcademyIntegration.getAcademyRegistration())).toEqual({ name, routed: true });
		// Re-enabling installs a new capability; the old view never resumes the retired instance.
		await expect(bodyInput).toHaveAttribute('readonly', '');
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		const recovered = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await expect(recovered).not.toHaveAttribute('readonly', '');
		await recovered.focus();
		await recovered.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(original);
	});
}

test('installed Academy package replacement retires its old view and releases its stylesheet after recovery', async ({ page }) => {
	await page.goto('/academy.html?academyExtension');
	await page.waitForFunction(() => !!window.ashAcademyIntegration);
	const original = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await original.fill('Draft survives an installed package replacement');
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademyIntegration.replaceAcademyPackage());
	await expect(original).toHaveAttribute('readonly', '');
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredDirty())).toBe(true);
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
	const recovered = page.locator('#document-editor textarea.stanza-document-text-input').first();
	await expect(recovered).toHaveValue('Draft survives an installed package replacement');
	await expect(recovered).not.toHaveAttribute('readonly', '');
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	expect(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured())).toContain('Draft survives an installed package replacement');
	await page.evaluate(() => window.ashAcademyIntegration.dispose());
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
});

test('same-source factory restart preserves collaborative undo and redo across old model history', async ({ page }) => {
	await page.goto('/academy.html?academyExtension');
	await page.waitForFunction(() => !!window.ashAcademyIntegration);
	const original = await page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts());
	await page.locator('#document-editor textarea.stanza-document-text-input').first().fill('Old factory history');
	await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
	await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(true));
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
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
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(original);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredCollaborationSubmissions().length)).toBe(1);
	await expect(toolbar).toHaveAttribute('data-state', 'connected');
	await recovered.press('ControlOrMeta+Shift+z');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(['Old factory history', 'Body']);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredCollaborationSubmissions().length)).toBe(2);
	await expect(toolbar).toHaveAttribute('data-state', 'connected');
});

for (const path of ['dist/editor.js', 'dist/editor.css']) test(`installed Academy rejects tampered ${path} before opening a document`, async ({ page }) => {
	await page.route('**/__academy_resource?*', async route => {
		if (new URL(route.request().url()).searchParams.get('path') === path) {
			await route.fulfill({ body: 'throw new Error("unverified bytes executed")', contentType: 'text/javascript' });
		} else await route.fallback();
	});
	const failure = page.waitForEvent('pageerror');
	await page.goto('/academy.html?academyExtension');
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
	await page.goto(`/academy.html?academyExtension&locale=${locale}`);
	expect((await failure).message).toBe(message);
	await expect(page.locator('#document-editor textarea')).toHaveCount(0);
	expect(pageErrors.get(page)).toHaveLength(1);
	pageErrors.set(page, []);
});

for (const [locale, name] of [['en', 'Document'], ['zh-CN', '文档']] as const) {
	test(`general documents route, edit, save, recover and reject conflicting content in ${locale}`, async ({ page }) => {
		await page.goto(`/academy.html?generalDocument&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademyIntegration);
		expect(await page.evaluate(() => window.ashAcademyIntegration.getAcademyRegistration())).toEqual({ name, routed: true });
		const input = page.locator('#document-editor textarea.stanza-document-text-input').first();
		await input.fill('General draft');
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredDirty())).toBe(true);
		const backup = await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup());
		expect(JSON.parse(backup)).toMatchObject({ format: 'ash.document', version: 2, documentType: 'general' });
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredDirty())).toBe(false);
		await input.fill('Later change');
		await page.evaluate(() => window.ashAcademyIntegration.revertStructured());
		await expect(input).toHaveValue('General draft');
		await page.evaluate(content => window.ashAcademyIntegration.restoreStructuredBackup(content), backup);
		const conflicting = { ...JSON.parse(backup), documentType: 'academy' };
		await page.evaluate(content => window.ashAcademyIntegration.setExternalStructured(content), JSON.stringify(conflicting));
		const failure = await page.evaluate(async () => {
			try { await window.ashAcademyIntegration.revertStructured(); return ''; }
			catch (error) { return String(error); }
		});
		expect(failure).toContain(locale === 'zh-CN' ? '结构化文档类型' : 'Structured document type');
		await expect(input).toHaveValue('General draft');
	});
}

for (const paper of ['A4', 'Letter']) {
	test(`Academy ${paper} code blocks delete and replace selections without splitting text nodes`, async ({ page }) => {
		await page.goto('/academy.html');
		const root = page.locator('#code-block');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), paper);
		const input = root.locator('.stanza-document-rich-text-input');
		await expect(input).toBeVisible();
		await input.focus();
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Backspace');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getCodeBlockText())).toBe('cnst editor = 1;');
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.type('ODE');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getCodeBlockText())).toBe('cODEt editor = 1;');
		await page.evaluate(() => window.ashAcademyIntegration.saveCodeBlock());
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getSavedCodeBlock())).toContain('cODEt editor = 1;');
	});
}

test("TextModel API and Academy code-block editing run in real browsers", async ({ page }) => {
	await page.goto("/academy.html");
	await expect(page.locator("#code-block textarea.stanza-document-text-input")).toBeVisible();
	await expect(page.locator("#code-block .stanza-editor")).toHaveCount(0);
	await expect(page.locator("#code-block .stanza-structured-format-toolbar")).toHaveAttribute("data-context", "code");
	await expect(page.locator("#code-block .stanza-structured-format-code-context")).toHaveText("Code block · Academy");
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.apiDocumentType)).toBe("doc");

	const codeBlockInput = page.locator("#code-block textarea.stanza-document-text-input");
	await codeBlockInput.focus();
	await page.keyboard.press("Home");
	await page.keyboard.type("// bridge\n");
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getCodeBlockText())).toBe("// bridge\nconst editor = 1;");
	await page.evaluate(() => window.ashAcademyIntegration.saveCodeBlock());
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getSavedCodeBlock())).toContain("// bridge\\nconst editor = 1;");

	const structuredInput = page.locator("#document-editor textarea.stanza-document-text-input").first();
	await structuredInput.focus();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(["Title", "", "Body"]);
	await page.keyboard.press("Control+z");
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(["Title", "Body"]);
});

test('Document links preserve editing and open through the product service with mouse and keyboard', async ({ page }) => {
	await page.goto('/academy.html?locale=zh-CN');
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
	expect(await page.evaluate(() => window.ashAcademyIntegration.getOpenedLinks())).toEqual([]);
	await link.click({ modifiers: ['ControlOrMeta'] });
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getOpenedLinks())).toEqual([url]);
	await link.focus();
	await link.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getOpenedLinks())).toEqual([url, url]);
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
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getOpenedLinks())).toEqual([url, url, url]);
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(['Title', 'Body']);
});

test('Document contributions mount the rich editor and release its views', async ({ page }) => {
	await page.goto('/academy.html');
	const ids = await page.evaluate(() => window.ashAcademyIntegration.getBundleIds());
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

	await page.evaluate(() => window.ashAcademyIntegration.dispose());
	await expect(page.locator('.stanza-structured-format-toolbar')).toHaveCount(0);
	await expect(page.locator('.stanza-document-collaboration-toolbar')).toHaveCount(0);
	await expect(page.locator('.stanza-document-format-controls')).toHaveCount(0);
});

for (const [locale, labels] of [['en', ['Paragraph style', 'Alignment', 'Line spacing', 'Space before', 'Space after']], ['zh-CN', ['段落样式', '对齐方式', '行距', '段前间距', '段后间距']]] as const) {
	test(`Academy paragraph contributions persist styles, layout, selection and undo in ${locale}`, async ({ page }) => {
		await page.goto(`/academy.html?generalDocument&locale=${locale}`);
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
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ anchor: { offset: 1 }, head: { offset: 4 } });
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
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
		expect(saved.document.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2, textAlign: 'center', lineSpacing: 2, spaceBefore: 6, spaceAfter: 18 } });
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await expect(heading).toHaveCSS('margin-block-end', '24px');
		await expect(style).toContainText(locale === 'en' ? 'Heading 2' : '标题 2');
		await chooseParagraphOption(page, style, locale === 'en' ? 'Normal' : '正文');
		await expect(root.locator('.stanza-document-heading')).toHaveCount(0);
		await expect(root.locator('.stanza-document-paragraph').first()).toHaveCSS('text-align', 'center');
	});
}

test('Academy paragraph contributions respect read-only input and release retained controls', async ({ page }) => {
	await page.goto('/academy.html?generalDocument&readOnly');
	const root = page.locator('#document-editor');
	const style = root.getByRole('combobox', { name: 'Paragraph style', exact: true });
	await expect(style).toBeDisabled();
	await expect(root.getByRole('combobox', { name: 'Alignment', exact: true })).toBeDisabled();
	await style.evaluate(element => {
		element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await expect(root.locator('.stanza-document-heading')).toHaveCount(0);
	await style.evaluate(element => {
		window.ashAcademyIntegration.dispose();
		(element as HTMLButtonElement).disabled = false;
		element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await expect(page.locator('.stanza-document-format-controls')).toHaveCount(0);
});

test('Academy paragraph contributions format a reversed cross-paragraph selection atomically', async ({ page }) => {
	await page.goto('/academy.html?generalDocument&richParagraphs');
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
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	let saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
	expect(saved.document.content.map((node: { attrs: unknown; }) => node.attrs)).toEqual([{ level: 3, textAlign: 'end' }, { level: 3, textAlign: 'end' }]);
	expect(saved.document.content.map((node: { content: { marks: unknown; }[]; }) => node.content[0]!.marks)).toEqual([[{ type: 'strong', attrs: {} }], [{ type: 'strong', attrs: {} }]]);
	const editor = root.locator('.stanza-document-rich-text-input').first();
	await editor.focus();
	await page.keyboard.press('Control+z');
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
	expect(saved.document.content.map((node: { attrs: unknown; }) => node.attrs)).toEqual([{ level: 3 }, { level: 3 }]);
});

test('Academy paragraph controls support keyboard style selection without stealing focus', async ({ page }) => {
	await page.goto('/academy.html?generalDocument');
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

test("Academy TextModel editor persists selected font, size, and emphasis formatting", async ({ page }) => {
	await page.goto("/academy.html");
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
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredFirstTextMarks())).toEqual([
		{ type: "textStyle", attrs: { fontFamily: "serif" } },
	]);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ kind: "text", anchor: { offset: 0 }, head: { offset: 5 } });
	await fontSize.selectOption("18");
	await expect(fontSize).toHaveValue("18");
	const bold = page.locator("#document-editor [data-action-id='bold'] button");
	await bold.click();

	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredFirstTextMarks())).toEqual([
		{ type: "textStyle", attrs: { fontFamily: "serif", fontSize: 18 } },
		{ type: "strong", attrs: {} },
	]);

	const styled = page.locator("#document-editor .stanza-document-mark-textStyle[data-font-family='serif']");
	await expect(styled).toHaveText("Title");
	await expect(styled).toHaveCSS("font-size", "18px");
	await expect(bold).toHaveAttribute("aria-pressed", "true");
});

test("Academy TextModel editor exposes collaboration as a separate contribution", async ({ page }) => {
	await page.goto("/academy.html");
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

test("Academy TextModel editor exposes room-owner invitations", async ({ page }) => {
	await page.goto("/academy.html");
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

test("Academy TextModel editor has the accessibility contract", async ({ page }) => {
	await page.goto("/academy.html");
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
		await page.goto(`/academy.html?callDocuments&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashAcademyIntegration);
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
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getCallDocumentState().joinedResource)).toBe('untitled');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getCallDocumentState().joinedTexts[0])).toBe('Unsaved local research');
		await expect(original).toHaveValue('Unsaved local research');
		expect(await page.evaluate(() => window.ashAcademyIntegration.getCallDocumentState().originalDirty)).toBe(true);
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
		await page.goto(`/academy.html?generalDocument&locale=${locale}`);
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
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
		expect(JSON.parse(saved.document.attrs.paragraphStyles)[0]).toMatchObject({ name: 'Essay', attrs: { indentStart: 36, firstLineIndent: -18 } });
		expect(saved.document.content[0].attrs).toEqual({ styleId: JSON.parse(saved.document.attrs.paragraphStyles)[0].id });
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
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
		await page.goto(`/academy.html?generalDocument&m6Document&locale=${locale}`);
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
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
		expect(saved.document.content[0].content.map((node: { text: string; }) => node.text).join('')).toBe('World Hello');
		expect(saved.document.content[0].content[0].marks).toEqual([{ type: 'strong', attrs: {} }]);
		expect(saved.document.content[3].content).toHaveLength(1);
		expect(saved.document.content[3].content[0].text).toBe('Hello code');
		await page.keyboard.press('Control+Shift+z');
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await button('Find and replace', '查找与替换').click();
		await root.getByRole('searchbox', { name: label('Find text', '查找文本'), exact: true }).fill('World');
		await expect(root.locator('.stanza-document-find-fields [role=status]')).toContainText(locale === 'en' ? 'of 5 matches' : '共 5 个匹配');
		await page.keyboard.press('Escape');
		await expect(root.locator('.stanza-document-find-fields')).toBeHidden();
	});
}

test('Academy M6 list numbering persists native markers, typing, undo and restart values', async ({ page }) => {
	await page.goto('/academy.html?generalDocument&m6Document');
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
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
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
	await page.goto('/academy.html?generalDocument&readOnly');
	const root = page.locator('#document-editor');
	await root.getByRole('button', { name: 'Find and replace', exact: true }).click();
	const query = root.getByRole('searchbox', { name: 'Find text', exact: true });
	await query.fill('Title');
	await query.press('Enter');
	await expect(root.getByRole('button', { name: 'Next match', exact: true })).toBeEnabled();
	await expect(root.getByRole('button', { name: 'Replace all', exact: true })).toBeDisabled();
	await expect(root.getByRole('textbox', { name: 'Style name', exact: true })).toBeDisabled();
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredDirty())).toBe(false);
	await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
	await expect(root.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
	await page.evaluate(() => window.ashAcademyIntegration.dispose());
	await expect(root.locator('.stanza-document-find-fields')).toHaveCount(0);
});


for (const theme of ['hc', 'hcLight']) {
	test(`Academy M6 search keyboard navigation retains visible match boundaries in ${theme}`, async ({ page }) => {
		await page.goto(`/academy.html?generalDocument&m6Document&${theme}`);
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

// Range and native hit testing read the very DOM fragmented by the installed client.
// The model is never seeded with page-local offsets or separate per-page documents.
async function assertVerticalPages(page: Page): Promise<void> {
	const geometry = await page.locator('#document-editor .ash-document-page-stack').evaluate(stack => {
		const papers = [...stack.querySelectorAll('.ash-document-page')].map(page => page.getBoundingClientRect());
		const flow = stack.querySelector<HTMLElement>('.ash-document-page-flow')!;
		const margin = parseFloat(flow.style.top) * Number((stack as HTMLElement).dataset.pageZoom);
		const failures: { nodeId: string | undefined; top: number; bottom: number; left: number; right: number; bodyLeft: number; bodyRight: number; }[] = [];
		const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const text = walker.currentNode;
			if (!text.parentElement?.closest('[data-text-node-id]')) continue;
			const range = document.createRange();
			range.selectNodeContents(text);
			for (const rect of range.getClientRects()) {
				if (rect.width === 0 || rect.height === 0) continue;
				const insideBody = papers.some(paper =>
					rect.top >= paper.top + margin - 1 && rect.bottom <= paper.bottom - margin + 1
					&& rect.left >= paper.left + margin - 1 && rect.right <= paper.right - margin + 1);
				if (!insideBody) {
					failures.push({
						nodeId: text.parentElement?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId,
						top: rect.top - papers[0]!.top, bottom: rect.bottom - papers[0]!.top,
						left: rect.left, right: rect.right,
						bodyLeft: papers[0]!.left + margin, bodyRight: papers[0]!.right - margin,
					});
				}
			}
		}
		return { failures: failures.slice(0, 5), aligned: papers.every((paper, index) => Math.abs(paper.left - papers[0]!.left) < 1 && (index === 0 || paper.top > papers[index - 1]!.bottom)) };
	});
	expect(geometry).toEqual({ failures: [], aligned: true });
}

async function pageBoundary(page: Page): Promise<number> {
	return page.locator('#document-editor [data-text-node-id="pages-long-text"]').evaluate(run => {
		const gap = run.querySelector('.ash-document-page-gap');
		if (!gap) throw new Error('Long paragraph did not fragment');
		const range = document.createRange();
		range.selectNodeContents(run);
		range.setEndBefore(gap);
		return range.toString().length;
	});
}

async function pageTextPoint(page: Page, offset: number, scroll = false): Promise<{ x: number; y: number; }> {
	return page.locator('#document-editor [data-text-node-id="pages-long-text"]').evaluate((run, { offset, scroll }) => {
		const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
		let remaining = offset;
		while (walker.nextNode()) {
			const text = walker.currentNode as Text;
			if (remaining < text.length) {
				const range = document.createRange();
				range.setStart(text, remaining);
				range.setEnd(text, remaining + 1);
				if (scroll) {
					const pane = run.closest('.ash-text-editor-widget-pane')!;
					const viewport = pane.getBoundingClientRect();
					const rect = range.getBoundingClientRect();
					pane.scrollTop += rect.top - viewport.top - pane.clientHeight / 2;
				}
				const rect = range.getBoundingClientRect();
				return { x: rect.left + 0.1, y: rect.top + rect.height / 2 };
			}
			remaining -= text.length;
		}
		throw new Error('Missing DOM text point');
	}, { offset, scroll });
}

async function selectPageText(page: Page, anchor: number, head = anchor): Promise<void> {
	await page.locator('#document-editor [data-text-node-id="pages-long-text"]').evaluate((run, { anchor, head }) => {
		(run.closest('[contenteditable]') as HTMLElement).focus();
		const point = (offset: number): [Node, number] => {
			const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
			let remaining = offset;
			let last: Text | undefined;
			while (walker.nextNode()) {
				const text = walker.currentNode as Text;
				if (remaining < text.length) return [text, remaining];
				remaining -= text.length;
				last = text;
			}
			if (last && remaining === 0) return [last, last.length];
			throw new Error('Missing DOM selection point');
		};
		const [anchorNode, anchorOffset] = point(anchor);
		const [headNode, headOffset] = point(head);
		document.getSelection()!.setBaseAndExtent(anchorNode, anchorOffset, headNode, headOffset);
	}, { anchor, head });
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({
		kind: 'text', anchor: { nodeId: 'pages-long-text', offset: anchor }, head: { nodeId: 'pages-long-text', offset: head },
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Academy M6 pages map native coordinates, Chinese input, clipboard and history through the installed package in ${locale}`, async ({ page }, testInfo) => {
		await page.goto(`/academy.html?generalDocument&m6Pages&locale=${locale}`);
		const root = page.locator('#document-editor');
		const paper = root.getByRole('combobox', { name: locale === 'en' ? 'Paper' : '纸张', exact: true });
		await chooseParagraphOption(page, paper, 'A4');
		const stack = root.locator('.ash-document-page-stack');
		await expect.poll(() => stack.getAttribute('data-page-count').then(Number)).toBeGreaterThan(2);
		const original = (await page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts()))[0]!;
		const boundary = await pageBoundary(page);
		const version = await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion());
		const zoom = root.getByRole('combobox', { name: locale === 'en' ? 'Page zoom' : '页面缩放', exact: true });
		await chooseParagraphOption(page, zoom, '75%');
		expect(await pageBoundary(page)).toBe(boundary);
		await assertVerticalPages(page);
		await page.setViewportSize({ width: 1100, height: 900 });
		expect(await pageBoundary(page)).toBe(boundary);
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion())).toBe(version);
		// Click a character in the second fragment after scrolling it into view.
		const point = await pageTextPoint(page, boundary + 3, true);
		await page.mouse.click(point.x, point.y);
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { nodeId: 'pages-long-text', offset: boundary + 3 } });
		await selectPageText(page, boundary - 1);
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => page.evaluate(() => (window.ashAcademyIntegration.getStructuredSelection() as { head: { offset: number; }; }).head.offset)).toBeGreaterThanOrEqual(boundary);
		await selectPageText(page, boundary - 1);
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { offset: boundary } });
		await root.locator('[data-text-node-id="pages-long-text"]').evaluate(run => {
			const editor = run.closest('[contenteditable]')!;
			editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			const selection = document.getSelection()!;
			const activeText = selection.focusNode as Text;
			activeText.insertData(selection.focusOffset, '中文');
			editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '中文', isComposing: true }));
			// Metric completion during composition must retain the active DOM text node.
			document.fonts.dispatchEvent(new Event('loadingdone'));
			if (!run.contains(activeText) || !run.isConnected) throw new Error('Composition node was replaced');
			editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
		});
		const composed = original.slice(0, boundary) + '中文' + original.slice(boundary);
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([composed, 'End']);
		await assertVerticalPages(page);
		await selectPageText(page, boundary - 5, boundary + 7);
		const copied = await root.locator('.stanza-document-rich-text-input').first().evaluate(editor => {
			const data = new DataTransfer();
			editor.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
			return data.getData('text/plain');
		});
		expect(copied).toBe(composed.slice(boundary - 5, boundary + 7));
		await page.keyboard.press('Backspace');
		const deleted = composed.slice(0, boundary - 5) + composed.slice(boundary + 7);
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([deleted, 'End']);
		await page.keyboard.press('Control+z');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([composed, 'End']);
		await page.keyboard.press('Control+Shift+z');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([deleted, 'End']);
		await selectPageText(page, boundary - 5);
		await root.locator('.stanza-document-rich-text-input').first().evaluate((editor, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
		}, copied);
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([composed, 'End']);
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
		expect(saved.document.attrs).toEqual({ pageSize: 'a4' });
		expect(saved.document.content).toHaveLength(2);
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await expect(stack).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([composed, 'End']);
		await page.screenshot({ path: testInfo.outputPath('academy-pages.png') });
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
		await expect(root.locator('.stanza-document-rich-text-input').first()).toHaveAttribute('contenteditable', 'false');
		expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toContain('中文');
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(true));
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await expect(root.locator('.stanza-document-rich-text-input').first()).toHaveAttribute('contenteditable', 'true');
	});
}

test('Academy M6 pages retain native drag selection, paper settings and empty-paragraph typing in high contrast', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 2000, height: 1600 });
	await page.goto('/academy.html?generalDocument&m6Pages&hc');
	const root = page.locator('#document-editor');
	await page.waitForFunction(() => !!window.ashAcademyIntegration);
	await page.evaluate(() => window.ashAcademyIntegration.layoutStructured(1800, 1100));
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paragraph font size', exact: true }), '18');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), 'Letter');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Page margins', exact: true }), '54 pt');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Page zoom', exact: true }), '50%');
	const boundary = await pageBoundary(page);
	const version = await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion());
	const points = [await pageTextPoint(page, boundary - 3), await pageTextPoint(page, boundary + 3)];
	await page.mouse.move(points[0]!.x, points[0]!.y);
	await page.mouse.down();
	await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 10 });
	await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({
		anchor: { nodeId: 'pages-long-text', offset: boundary - 3 }, head: { nodeId: 'pages-long-text', offset: boundary + 3 },
	});
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion())).toBe(version);
	await expect(root.locator('[data-block-id="pages-long"]')).toHaveCSS('outline-width', '0px');
	await expect(root.locator('.ash-document-page').first()).toHaveCSS('outline-style', 'solid');
	await expect(root.locator('.ash-document-page').first()).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
	await page.screenshot({ path: testInfo.outputPath('academy-pages-native-drag-hc.png') });
	await page.evaluate(() => window.ashAcademyIntegration.layoutStructured(900, 600));
	expect(await pageBoundary(page)).toBe(boundary);
	await page.keyboard.press('Control+f');
	const query = root.getByRole('searchbox', { name: 'Find text', exact: true });
	await query.fill('End');
	await query.press('Enter');
	await expect(query).toBeFocused();
	await expect.poll(() => root.locator('[data-text-node-id="pages-last-text"]').evaluate(run => {
		const pane = run.closest('.ash-text-editor-widget-pane')!;
		const viewport = pane.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(run);
		const rect = range.getBoundingClientRect();
		return pane.scrollTop > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
	})).toBe(true);
	await query.press('Escape');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), 'Continuous');
	await expect(root.locator('.ash-document-page-stack')).toHaveCount(0);
	await root.locator('textarea.stanza-document-text-input').first().focus();
	await page.keyboard.press('Control+z');
	await expect(root.locator('.ash-document-page-stack')).toBeVisible();
	await expect(root.getByRole('combobox', { name: 'Paper', exact: true })).toContainText('Letter');
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	expect(JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured())).document.attrs).toEqual({ pageSize: 'letter', pageMargin: 54 });
	const last = root.locator('[data-block-id="pages-last"]');
	await last.evaluate(editor => {
		(editor as HTMLElement).focus();
		const text = editor.querySelector('[data-text-node-id]')!.firstChild!;
		document.getSelection()!.setBaseAndExtent(text, 3, text, 3);
	});
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { nodeId: 'pages-last-text', offset: 3 } });
	await page.keyboard.press('Enter');
	await page.keyboard.type('New paragraph');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual(['分页中文 writing across pages. '.repeat(260), 'End', 'New paragraph']);
	await expect(root.locator('.stanza-document-rich-text-input').last()).toBeFocused();
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
	await expect(root.getByRole('combobox', { name: 'Page margins', exact: true })).toContainText('54 pt');
	await expect(root.locator('.stanza-document-rich-text-input').last()).toHaveText('New paragraph');
	await expect(root.locator('[data-block-id="pages-long"]')).toHaveCSS('font-size', '18px');
});

test('Academy vertical pages preserve reverse selections, deferred font layout, cancelled composition and link ownership', async ({ page }) => {
	await page.goto('/academy.html?generalDocument&m6Pages&linkedPages');
	const root = page.locator('#document-editor');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), 'A4');
	const boundary = await pageBoundary(page);
	await selectPageText(page, boundary + 4, boundary - 4);
	const version = await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion());
	const backup = await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup());
	// A real font-size change exercises fresh line geometry, including backwards ranges.
	await root.locator('[data-block-id="pages-long"]').evaluate(editor => {
		(editor as HTMLElement).style.fontSize = '20px';
		document.fonts.dispatchEvent(new Event('loadingdone'));
	});
	expect(await pageBoundary(page)).not.toBe(boundary);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ anchor: { offset: boundary + 4 }, head: { offset: boundary - 4 } });
	await assertVerticalPages(page);
	const changedBoundary = await pageBoundary(page);
	await selectPageText(page, boundary + 4);
	await root.locator('[data-text-node-id="pages-long-text"]').evaluate(run => {
		const editor = run.closest('[contenteditable]')!;
		editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		const activeText = document.getSelection()!.focusNode;
		(editor as HTMLElement).style.fontSize = '24px';
		document.fonts.dispatchEvent(new Event('loadingdone'));
		if (document.getSelection()!.focusNode !== activeText || !activeText?.isConnected) throw new Error('Font layout replaced a composing node');
		editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
	});
	expect(await pageBoundary(page)).not.toBe(changedBoundary);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { offset: boundary + 4 } });
	await assertVerticalPages(page);
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredVersion())).toBe(version);
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toBe(backup);
	const point = await pageTextPoint(page, (await pageBoundary(page)) + 3, true);
	await page.keyboard.down('ControlOrMeta');
	await page.mouse.click(point.x, point.y);
	await page.keyboard.up('ControlOrMeta');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getOpenedLinks())).toEqual(['https://example.test/paged-link']);
	await selectPageText(page, boundary + 4);
	await root.locator('[data-block-id="pages-long"]').evaluate(editor => {
		editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		const selection = document.getSelection()!;
		(selection.focusNode as Text).insertData(selection.focusOffset, '未提交');
		editor.dispatchEvent(new CompositionEvent('compositioncancel', { bubbles: true }));
	});
	await expect(root.locator('[data-block-id="pages-long"]')).toBeFocused();
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toBe(backup);
	await page.keyboard.type('A');
	const original = '分页中文 writing across pages. '.repeat(260);
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([original.slice(0, boundary + 4) + 'A' + original.slice(boundary + 4), 'End']);
	await page.keyboard.press('Control+z');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredBlockTexts())).toEqual([original, 'End']);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Academy M6 pagination intent, running text and read-only recovery stay in the installed document model in ${locale}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1600, height: 1200 });
		await page.goto(`/academy.html?generalDocument&m6Pages&locale=${locale}`);
		const root = page.locator('#document-editor');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: locale === 'en' ? 'Paper' : '纸张', exact: true }), 'A4');
		await root.locator('summary').filter({ hasText: locale === 'en' ? 'Pagination options' : '分页选项' }).click();
		await page.evaluate(() => window.ashAcademyIntegration.layoutStructured(1400, 650));
		const labels = locale === 'en'
			? { orientation: 'Orientation', landscape: 'Landscape', header: 'Page header', footer: 'Page footer', evenHeader: 'Even page header', numbers: 'Page numbers', first: 'Different first page', even: 'Different even pages', on: 'On', before: 'Page break before', together: 'Keep paragraph together' }
			: { orientation: '纸张方向', landscape: '横向', header: '页眉', footer: '页脚', evenHeader: '偶数页页眉', numbers: '页码', first: '首页不同', even: '奇偶页不同', on: '开启', before: '段前分页', together: '段中不分页' };
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.orientation, exact: true }), labels.landscape);
		for (const [label, text] of [[labels.header, 'Research 中文'], [labels.footer, 'Draft'], [labels.evenHeader, 'Even header']]) {
			const input = root.getByRole('textbox', { name: label, exact: true });
			await input.fill(text!);
			await input.press('Tab');
		}
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.numbers, exact: true }), labels.on);
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.even, exact: true }), labels.on);
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.first, exact: true }), labels.on);
		const papers = root.locator('.ash-document-page');
		await expect(papers.first().locator('.ash-document-page-header')).toHaveCount(0);
		await expect(papers.nth(1).locator('.ash-document-page-header')).toHaveText('Even header');
		await expect(papers.nth(2).locator('.ash-document-page-header')).toHaveText('Research 中文');
		const pageCount = await papers.count();
		await expect(papers.nth(1).locator('.ash-document-page-number')).toHaveText(`2 / ${pageCount}`);
		const dimensions = await papers.first().boundingBox();
		expect(dimensions!.width).toBeGreaterThan(dimensions!.height);
		await assertVerticalPages(page);
		const last = root.locator('[data-block-id="pages-last"]');
		await last.click();
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.before, exact: true }), labels.on);
		await chooseParagraphOption(page, root.getByRole('combobox', { name: labels.together, exact: true }), labels.on);
		await assertVerticalPages(page);
		const manualTop = await last.evaluate(editor => {
			const flow = editor.closest('.ash-document-page-flow')!;
			const range = document.createRange();
			const walker = document.createTreeWalker(editor.querySelector('[data-text-node-id]')!, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) if (walker.currentNode.textContent) break;
			range.setStart(walker.currentNode, 0);
			range.setEnd(walker.currentNode, 1);
			return range.getClientRects()[0]!.top - flow.getBoundingClientRect().top;
		});
		const stride = dimensions!.height + 24;
		expect(Math.min(manualTop % stride, stride - manualTop % stride)).toBeLessThan(5);
		await last.press('ControlOrMeta+ArrowRight');
		await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toMatchObject({ head: { nodeId: 'pages-last-text', offset: 3 } });
		await last.press('Enter');
		await page.keyboard.type('New body');
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		const saved = JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()));
		expect(saved.document.attrs).toMatchObject({ pageOrientation: 'landscape', pageHeader: 'Research 中文', pageNumbers: true, pageDifferentFirst: true, pageDifferentEven: true });
		expect(saved.document.content[1].attrs).toMatchObject({ pageBreakBefore: true, keepTogether: true });
		expect(saved.document.content[2].attrs.pageBreakBefore).toBeUndefined();
		expect(saved.document.content.slice(1).map((node: { content: { text?: string; }[]; }) => node.content.map(child => child.text ?? '').join(''))).toEqual(['End', 'New body']);
		await page.screenshot({ path: testInfo.outputPath('academy-pagination-options.png') });
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(false));
		await expect(root.getByRole('combobox', { name: labels.orientation, exact: true })).toBeDisabled();
		await expect(root.getByRole('textbox', { name: labels.header, exact: true })).toBeDisabled();
		await page.evaluate(() => window.ashAcademyIntegration.setAcademyEnabled(true));
		await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
		await assertVerticalPages(page);
		await expect(papers.nth(1).locator('.ash-document-page-header')).toHaveText('Even header');
		await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
		expect(JSON.parse(await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured()))).toEqual(saved);
		await root.locator('summary').filter({ hasText: locale === 'en' ? 'Pagination options' : '分页选项' }).click();
		await root.getByRole('textbox', { name: labels.header, exact: true }).press('Escape');
		await expect(root.locator('details')).not.toHaveAttribute('open');
		await expect(root.locator('.stanza-document-rich-text-input').last()).toBeFocused();
	});
}

test('Academy M6 paginates whole table rows, oversized parallel cells, lists, code lines and tall images without losing input identities', async ({ page }, testInfo) => {
	await page.goto('/academy.html?generalDocument&m6ComplexPages&hcLight');
	const root = page.locator('#document-editor');
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), 'Letter');
	await assertVerticalPages(page);
	const rowPages = await root.locator('.stanza-document-table-row').evaluateAll(rows => {
		const flow = rows[0]!.closest('.ash-document-page-flow')!.getBoundingClientRect();
		const papers = [...document.querySelectorAll('#document-editor .ash-document-page')].map(page => page.getBoundingClientRect());
		return rows.filter(row => !['complex-row-8', 'complex-nested-row'].includes(row.getAttribute('data-node-id') ?? '')).map(row => {
			const rect = row.getBoundingClientRect();
			return papers.some(paper => rect.top >= paper.top + flow.top - papers[0]!.top - 1 && rect.bottom <= paper.bottom - (flow.top - papers[0]!.top) + 1);
		});
	});
	expect(rowPages.every(Boolean)).toBe(true);
	await expect(root.locator('[data-node-id="complex-nested-row"] .ash-document-page-gap').first()).toBeAttached();
	const tallCell = root.locator('[data-text-node-id="complex-cell-8-1-text"]');
	await expect(tallCell.locator('.ash-document-page-gap').first()).toBeAttached();
	await tallCell.evaluate(run => {
		(run.closest('[contenteditable]') as HTMLElement).focus();
		const gap = run.querySelector('.ash-document-page-gap')!;
		const text = gap.nextSibling!;
		document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
	});
	const before = await page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection());
	await page.keyboard.type('跨页');
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	const typed = await page.evaluate(() => window.ashAcademyIntegration.getSavedStructured());
	expect(typed).toContain('跨页');
	await assertVerticalPages(page);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashAcademyIntegration.getStructuredSelection())).toEqual(before);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await assertVerticalPages(page);
	const image = root.locator('.stanza-document-inline-image');
	const imageBounds = await image.boundingBox();
	expect(imageBounds!.height).toBeLessThanOrEqual(11 * 96 - 192 + 1);
	await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Page zoom', exact: true }), '50%');
	await assertVerticalPages(page);
	await page.screenshot({ path: testInfo.outputPath('academy-table-pages.png') });
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
	await assertVerticalPages(page);
	await page.evaluate(() => window.ashAcademyIntegration.dispose());
	await expect(root.locator('.ash-document-page-stack')).toHaveCount(0);
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
});

for (const rule of ['orphan', 'short', 'widow', 'together', 'next', 'chain'] as const) {
	test(`Academy M6 applies ${rule} paragraph rules to measured lines and restores them through undo`, async ({ page }) => {
		await page.goto(`/academy.html?generalDocument&pageRule=${rule}`);
		const root = page.locator('#document-editor');
		await chooseParagraphOption(page, root.getByRole('combobox', { name: 'Paper', exact: true }), 'Letter');
		const linePages = async (nodeId: string) => root.locator(`[data-text-node-id="${nodeId}"]`).evaluate(run => {
			const firstPage = document.querySelector('#document-editor .ash-document-page')!.getBoundingClientRect();
			const stride = firstPage.height + 24;
			const pages: number[] = [];
			const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const range = document.createRange();
				range.selectNodeContents(walker.currentNode);
				for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) pages.push(Math.floor((rect.top - firstPage.top) / stride));
			}
			return pages;
		});
		const original = await linePages('rule-target-text');
		await root.locator('[data-block-id="rule-target"]').click();
		await root.locator('summary').filter({ hasText: 'Pagination options' }).click();
		const label = rule === 'together' ? 'Keep paragraph together' : rule === 'next' || rule === 'chain' ? 'Keep with next' : 'Widow and orphan control';
		await chooseParagraphOption(page, root.getByRole('combobox', { name: label, exact: true }), 'On');
		const changed = await linePages('rule-target-text');
		if (rule === 'orphan' || rule === 'short') {
			expect(original.filter(page => page === 0)).toHaveLength(1);
			expect(changed.every(page => page === 1)).toBe(true);
		} else if (rule === 'widow') {
			expect(original.filter(page => page === 1)).toHaveLength(1);
			expect(changed.filter(page => page === 1)).toHaveLength(2);
		} else if (rule === 'together') {
			expect(new Set(original).size).toBe(2);
			expect(new Set(changed)).toEqual(new Set([1]));
		} else {
			expect(original).toEqual([0]);
			expect(changed).toEqual([1]);
			expect((await linePages('rule-next-text'))[0]).toBe(1);
			if (rule === 'chain') expect(await linePages('rule-middle-text')).toEqual([1]);
		}
		await assertVerticalPages(page);
		await root.locator('[data-block-id="rule-target"]').press('ControlOrMeta+z');
		expect(await linePages('rule-target-text')).toEqual(original);
	});
}

for (const kind of ['general', 'academy']) for (const locale of ['en', 'zh-CN']) test(`M6 sections, review and binary document output use the installed ${kind} provider in ${locale}`, async ({ page }, testInfo) => {
	// Two page-image PDF renders and a DOCX round trip exceed the default budget on Windows.
	test.setTimeout(120_000);
	await page.goto(`/academy.html?${kind === 'general' ? 'generalDocument' : 'academyExtension'}&m6Pages&locale=${locale}`);
	await page.waitForFunction(() => !!window.ashAcademyIntegration);
	await page.evaluate(() => window.ashAcademyIntegration.layoutStructured(1000, 700));
	const editor = page.locator('#document-editor');
	const last = page.locator('#document-editor [data-node-id="pages-last"]');
	await last.click();
	await editor.getByRole('button', { name: locale === 'en' ? 'Start section here' : '在此开始新节', exact: true }).click();
	await expect(page.locator('#document-editor .ash-document-page-section')).toHaveCount(2);
	await chooseParagraphOption(page, editor.getByRole('combobox', { name: locale === 'en' ? 'Paper' : '纸张', exact: true }), 'Letter');
	await editor.locator('summary').filter({ hasText: locale === 'en' ? 'Pagination options' : '分页选项' }).click();
	await chooseParagraphOption(page, editor.getByRole('combobox', { name: locale === 'en' ? 'Orientation' : '纸张方向', exact: true }), locale === 'en' ? 'Landscape' : '横向');
	await editor.locator('summary').filter({ hasText: locale === 'en' ? 'Pagination options' : '分页选项' }).click();
	const editable = page.locator('#document-editor [data-node-id="pages-last"] [contenteditable="true"]');
	await editable.click(); await page.keyboard.press('End'); await page.keyboard.type(' Section');
	await editor.getByRole('textbox', { name: locale === 'en' ? 'Comment text' : '批注内容', exact: true }).fill('Check section');
	await editor.getByRole('button', { name: locale === 'en' ? 'Add comment' : '添加批注', exact: true }).click();
	await chooseParagraphOption(page, editor.getByRole('combobox', { name: locale === 'en' ? 'Track block revisions' : '跟踪块级修订', exact: true }), locale === 'en' ? 'On' : '开启');
	await editable.click(); await page.keyboard.press('End'); await page.keyboard.type(' reviewed');
	await expect(editor.getByRole('button', { name: locale === 'en' ? 'Reject block revision' : '拒绝块级修订', exact: true })).toHaveCount(1);
	const before = await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup());
	const docx = await page.evaluate(() => window.ashAcademyIntegration.exportArtifact('docx'));
	expect(docx.slice(0, 4)).toEqual([80, 75, 3, 4]);
	const imported = await page.evaluate(bytes => window.ashAcademyIntegration.importArtifact(bytes), docx);
	expect(imported).toMatchObject({ backup: before, scheme: 'untitled', dirty: true, source: before });
	expect(await page.evaluate(() => window.ashAcademyIntegration.exportArtifact('docx', true))).toEqual(docx);
	const pdf = await page.evaluate(() => window.ashAcademyIntegration.exportArtifact('pdf'));
	expect(Buffer.from(pdf).subarray(0, 8).toString()).toBe('%PDF-1.4');
	const loading = loadPdf({ data: new Uint8Array(pdf), isImageDecoderSupported: false });
	try {
		const output = await loading.promise;
		expect(output.numPages).toBe(4);
		for (let index = 1; index <= output.numPages; index++) {
			const paper = await output.getPage(index), operations = await paper.getOperatorList();
			const at = operations.fnArray.indexOf(OPS.paintImageXObject);
			expect(at).toBeGreaterThanOrEqual(0);
			const image = paper.objs.get(operations.argsArray[at]![0]) as { data: Uint8Array; };
			expect(image.data.filter(value => value < 180).length).toBeGreaterThan(100);
			if (index === 4) { expect(paper.view[2]).toBeCloseTo(792, 0); expect(paper.view[3]).toBeCloseTo(612, 0); }
		}
	} finally { await loading.destroy(); }
	const frozen = await page.evaluate(async () => {
		const pending = window.ashAcademyIntegration.exportArtifact('pdf');
		const changed = JSON.parse(window.ashAcademyIntegration.getStructuredBackup());
		const append = (node: { text?: string; content: typeof node[]; }): boolean => { if (node.text?.includes('End Section')) { node.text += ' later edit'; return true; } return node.content.some(append); };
		append(changed.document);
		window.ashAcademyIntegration.restoreStructuredBackup(JSON.stringify(changed));
		return pending;
	});
	expect(Buffer.from(frozen)).toEqual(Buffer.from(pdf));
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toContain('later edit');
	await page.evaluate(backup => window.ashAcademyIntegration.restoreStructuredBackup(backup), before);
	await testInfo.attach('academy-m6.pdf', { body: Buffer.from(pdf), contentType: 'application/pdf' });
	await testInfo.attach('academy-m6.docx', { body: Buffer.from(docx), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
	expect(await page.evaluate(() => window.ashAcademyIntegration.getStructuredBackup())).toBe(before);
	await editor.getByRole('button', { name: locale === 'en' ? 'Reject block revision' : '拒绝块级修订', exact: true }).first().click();
	await expect(editable).toHaveText('End Section');
	await page.evaluate(() => window.ashAcademyIntegration.saveStructured());
	await page.evaluate(() => window.ashAcademyIntegration.reopenStructured());
	await expect(page.locator('#document-editor .ash-document-page-section')).toHaveCount(2);
	await expect(page.locator('#document-editor .ash-document-review-record')).toHaveCount(1);
});
