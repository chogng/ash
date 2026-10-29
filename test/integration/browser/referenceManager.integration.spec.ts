import { test, expect } from '@playwright/test';
import { compileEditorClient } from '../../../build/builtin/editorClients.ts';
import { prepareClientEditorExtension, startClientEditorExtension } from '../../fixtures/clientEditorExtension.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const packages = [
	{
		name: 'reference-manager',
		binary: 'ash-reference-manager',
		channel: 'editor.resource.v1',
		id: 'ash.reference-manager',
	},
	{ name: 'academy', binary: 'ash-academy', channel: 'editor.client.v1', id: 'ash.academy' },
	{ name: 'pdf-viewer', binary: 'ash-pdf-viewer', channel: 'editor.resource.v1', id: 'ash.pdf-viewer' },
];
const clients = new Map<string, Awaited<ReturnType<typeof compileEditorClient>>>();
const manifests = new Map<string, string>();
const running = new WeakMap<object, Map<string, Awaited<ReturnType<typeof startClientEditorExtension>>>>();
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function pdf() {
	const stream = 'BT /F1 18 Tf 20 200 Td (Reference Manager attached PDF) Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let result = '%PDF-1.4\n';
	const offsets: number[] = [];
	for (const [index, value] of objects.entries()) {
		offsets.push(result.length);
		result += `${index + 1} 0 obj\n${value}\nendobj\n`;
	}
	const start = result.length;
	result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(result);
}
test.beforeAll(async () => {
	test.setTimeout(300000);
	for (const pkg of packages) {
		prepareClientEditorExtension(pkg.binary);
		clients.set(pkg.id, await compileEditorClient(resolve(`extensions/${pkg.name}`)));
		manifests.set(pkg.id, await readFile(`extensions/${pkg.name}/package.json`, 'utf8'));
	}
});
test.beforeEach(async ({ page }) => {
	const runtimes = new Map<string, Awaited<ReturnType<typeof startClientEditorExtension>>>();
	running.set(page, runtimes);
	let generation = 0;
	const incarnations = new Map<string, number>();
	await page.route('**/__references_pdf', route => route.fulfill({ body: pdf(), contentType: 'application/pdf' }));
	await page.route('**/__references_catalog', route =>
		route.fulfill({
			json: {
				generation,
				diagnostics: [],
				extensions: packages
					.filter(pkg => runtimes.has(pkg.id))
					.map(pkg => ({
						id: pkg.id,
						name: pkg.name,
						publisher: 'ash',
						version: '1.0.0',
						displayName: pkg.name,
						sourceKind: 'registry',
						manifestJson: manifests.get(pkg.id)!,
						manifestSha256: hash(manifests.get(pkg.id)!),
						packageSha256: hash(JSON.stringify(clients.get(pkg.id)!.resources)),
						rendererClient: { ...clients.get(pkg.id)!.client, runtimeId: pkg.id },
					})),
			},
		}),
	);
	await page.route('**/__references_resource?*', route => {
		const params = new URL(route.request().url()).searchParams;
		const id = params.get('id')!;
		const path = params.get('path')!;
		const value = clients.get(id)?.resources[path];
		if (!runtimes.has(id) || params.get('generation') !== String(generation) || value === undefined)
			return route.fulfill({ status: 410 });
		return route.fulfill({ body: value, contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
	});
	await page.route('**/__references_enable?*', async route => {
		const { name, enabled } = route.request().postDataJSON();
		const pkg = packages.find(pkg => pkg.name === name)!;
		if (!enabled) {
			await runtimes.get(pkg.id)?.dispose();
			runtimes.delete(pkg.id);
		} else if (!runtimes.has(pkg.id)) {
			runtimes.set(
				pkg.id,
				await startClientEditorExtension(
					pkg.binary,
					pkg.id,
					new URL(route.request().url()).searchParams.get('locale') ?? 'en',
				),
			);
			incarnations.set(pkg.id, generation + 1);
		}
		await route.fulfill({
			json: {
				generation: ++generation,
				extensions: packages
					.filter(pkg => runtimes.has(pkg.id))
					.map(pkg => ({
						id: pkg.id,
						version: '1.0.0',
						packageDigest: hash(JSON.stringify(clients.get(pkg.id)!.resources)),
						runtimeApiVersion: 1,
						activationGeneration: incarnations.get(pkg.id)!,
						incarnation: incarnations.get(pkg.id)!,
						lifecycle: 'ready',
						stderr: '',
						outputEvents: [],
						registrations: runtimes.get(pkg.id)!.registrations,
					})),
			},
		});
	});
	await page.route('**/__references_invoke?*', async route => {
		const pkg = packages.find(pkg => pkg.id === new URL(route.request().url()).searchParams.get('id'))!;
		await route.fulfill({
			json: await runtimes.get(pkg.id)!.invoke(pkg.channel, 'receiveData', route.request().postDataJSON()),
		});
	});
});
test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.referenceManagerTest?.dispose()).catch(() => {});
	for (const runtime of running.get(page)?.values() ?? []) await runtime.dispose();
	running.delete(page);
});

for (const locale of ['en', 'zh-CN'])
	test(`Reference Manager imports, manages, inserts, updates and reuses optional PDF in ${locale}`, async ({
		page,
	}, testInfo) => {
		test.setTimeout(120000);
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/referenceManager.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.referenceManagerTest);
		await page.evaluate(async () => {
			await window.referenceManagerTest.enable('reference-manager', true);
			await window.referenceManagerTest.open();
		});
		const library = page.locator('.stanza-reference-library');
		await expect(library.getByRole('listbox').getByRole('option')).toHaveCount(2);
		await expect(library).toHaveAttribute('aria-label', locale === 'zh-CN' ? '文献库' : 'Reference library');
		const ids = await page.evaluate(() =>
			window.referenceManagerTest.library().entries.map((entry: any) => entry.id),
		);
		await page.evaluate(() => window.referenceManagerTest.dialogs(['/fixture/library.ash-library']));
		if (locale === 'en') await page.evaluate(() => window.referenceManagerTest.saveLibrary());
		else await library.locator('[data-action="saveAs"]').click();
		await expect.poll(() => page.evaluate(() => window.referenceManagerTest.dirty())).toBe(false);
		expect(
			(await page.evaluate(() => window.referenceManagerTest.persisted('/fixture/source.ris'))).startsWith(
				'TY  - JOUR',
			),
		).toBe(true);
		await page.evaluate(() => window.referenceManagerTest.dialogs(['/fixture/source.ris']));
		await library.locator('[data-action="import"]').click();
		await expect(library.getByRole('status')).toContainText(locale === 'zh-CN' ? '2' : '2 duplicates');
		expect(
			await page.evaluate(() => window.referenceManagerTest.library().entries.map((entry: any) => entry.id)),
		).toEqual(ids);
		await library.getByRole('searchbox').fill('second');
		await expect(library.getByRole('listbox').getByRole('option')).toHaveCount(1);
		await expect(library.locator('article h2')).toHaveText('A second book');
		await library.getByRole('searchbox').fill('no matching record');
		await expect(library.getByRole('listbox').getByRole('option')).toHaveCount(0);
		await expect(library.locator('[data-action="edit"]')).toBeDisabled();
		await library.getByRole('searchbox').fill('');
		await library.getByRole('listbox').getByRole('option').first().focus();
		await library.getByRole('listbox').getByRole('option').first().press('End');
		await expect(library.getByRole('listbox').getByRole('option').last()).toBeFocused();
		await library.getByRole('listbox').getByRole('option').last().press('Home');
		await page.evaluate(async () => {
			await window.referenceManagerTest.enable('academy', true);
			await window.referenceManagerTest.open('/fixture/paper.ash-academy');
		});
		await page.locator('#document textarea.stanza-document-text-input').last().click();
		await expect(library.locator('[data-action="insert"]')).toBeEnabled();
		await library.locator('[data-action="insert"]').click();
		await expect(page.locator('.ash-citation')).toHaveCount(1);
		const inserted = await page.evaluate(() => window.referenceManagerTest.document());
		expect(JSON.stringify(inserted)).toContain('libraryEntryId');
		expect(await page.evaluate(() => window.referenceManagerTest.undo())).toBe(true);
		await expect(page.locator('.ash-citation')).toHaveCount(0);
		await page.evaluate(() => window.referenceManagerTest.redo());
		await page.evaluate(() => window.referenceManagerTest.captureApi());
		await page.evaluate(() =>
			window.referenceManagerTest.dialogs(
				[],
				[
					'Renamed2025',
					'Corrected paper',
					'Smith, Jane',
					'2025',
					'10.1234/abc',
					'Journal',
					'1',
					'2',
					'10',
					'20',
					'',
					'Abstract',
					'tag',
				],
			),
		);
		await library.locator('[data-action="edit"]').click();
		await expect(library.getByRole('listbox').getByRole('option').first()).toContainText('Corrected paper');
		await expect.poll(() => page.evaluate(() => window.referenceManagerTest.dirty())).toBe(false);
		await library.locator('[data-action="update"]').click();
		await expect(library.getByRole('status')).toContainText('1');
		expect(JSON.stringify(await page.evaluate(() => window.referenceManagerTest.document()))).toContain(
			'Renamed2025',
		);
		expect(
			await page.evaluate(() =>
				window.referenceManagerTest.invokeSaved({
					version: 1,
					operation: 'update',
					libraryId: 'x',
					references: [],
				}),
			),
		).toMatch(locale === 'zh-CN' ? /已更改|更改|变化/ : /changed/);
		expect(await page.evaluate(() => window.referenceManagerTest.undo())).toBe(true);
		expect(await page.evaluate(() => window.referenceManagerTest.document())).toEqual(inserted);
		await page.evaluate(() => window.referenceManagerTest.redo());
		await page.evaluate(() => window.referenceManagerTest.saveDocument());
		expect(
			await page.evaluate(() => window.referenceManagerTest.persisted('/fixture/paper.ash-academy')),
		).toContain('Renamed2025');
		await page.evaluate(() => window.referenceManagerTest.dialogs(['/fixture/paper.pdf']));
		await library.locator('[data-action="attach"]').click();
		await expect(library.locator('[data-action="pdf"]')).toBeEnabled();
		await library.locator('[data-action="pdf"]').click();
		await expect(library.getByRole('status')).toContainText('PDF');
		await expect(page.locator('canvas')).toHaveCount(0);
		await page.evaluate(() => window.referenceManagerTest.enable('pdf-viewer', true));
		await library.locator('[data-action="pdf"]').click();
		await expect(page.locator('.ash-pdf-editor canvas')).toHaveCount(1);
		await library.focus();
		expect(await page.evaluate(() => window.referenceManagerTest.accessible())).toContain('Corrected paper');
		await library.locator('[data-action="delete"]').click();
		await expect(library.getByRole('listbox').getByRole('option')).toHaveCount(1);
		expect(JSON.stringify(await page.evaluate(() => window.referenceManagerTest.document()))).toContain(
			'Renamed2025',
		);
		await library.locator('[data-action="update"]').click();
		await expect(library.getByRole('status')).toContainText('1');
		await page.screenshot({ path: testInfo.outputPath(`reference-manager-${locale}.png`), fullPage: true });
		expect(errors).toEqual([]);
	});

test('Reference Manager retains conflicted drafts across provider retirement and rejects read-only edits', async ({
	page,
}) => {
	await page.goto('/referenceManager.html');
	await page.waitForFunction(() => !!window.referenceManagerTest);
	await page.evaluate(async () => {
		await window.referenceManagerTest.enable('reference-manager', true);
		await window.referenceManagerTest.open();
		window.referenceManagerTest.dialogs(['/fixture/library.ash-library']);
	});
	const library = page.locator('.stanza-reference-library');
	await library.locator('[data-action="saveAs"]').click();
	await expect.poll(() => page.evaluate(() => window.referenceManagerTest.dirty())).toBe(false);
	await page.evaluate(async () => {
		const raw = JSON.parse(await window.referenceManagerTest.persisted());
		raw.entries[0].title = 'External writer';
		await window.referenceManagerTest.write('/fixture/library.ash-library', JSON.stringify(raw));
		window.referenceManagerTest.dialogs(
			[],
			['Draft2024', 'Preserved draft', 'Smith', '2024', '', '', '', '', '', '', '', '', ''],
		);
	});
	await library.locator('[data-action="edit"]').click();
	await expect(library.getByRole('status')).toContainText('retained');
	expect(await page.evaluate(() => window.referenceManagerTest.dirty())).toBe(true);
	await page.evaluate(() => window.referenceManagerTest.enable('reference-manager', false));
	await expect(library.locator('[data-action="edit"]')).toBeDisabled();
	await expect(library.getByRole('listbox').getByRole('option').first()).toContainText('Preserved draft');
	await page.evaluate(async () => {
		await window.referenceManagerTest.enable('reference-manager', true);
		await window.referenceManagerTest.open('/fixture/library.ash-library');
	});
	await expect(library.getByRole('listbox').getByRole('option').first()).toContainText('Preserved draft');
	expect(await page.evaluate(() => window.referenceManagerTest.dirty())).toBe(true);
	await page.evaluate(() => window.referenceManagerTest.dialogs(['/fixture/recovered.ash-library']));
	await library.locator('[data-action="saveAs"]').click();
	await expect.poll(() => page.evaluate(() => window.referenceManagerTest.dirty())).toBe(false);
	expect(await page.evaluate(() => window.referenceManagerTest.persisted('/fixture/library.ash-library'))).toContain(
		'External writer',
	);
	expect(
		await page.evaluate(() => window.referenceManagerTest.persisted('/fixture/recovered.ash-library')),
	).toContain('Preserved draft');
	await page.evaluate(() => window.referenceManagerTest.open('/fixture/recovered.ash-library', true));
	await expect(library.locator('[data-action="edit"]')).toBeDisabled();
	await expect(library.locator('[data-action="import"]')).toBeDisabled();
	await page.evaluate(() => window.referenceManagerTest.open('/fixture/recovered.ash-library'));
	await expect(library.locator('[data-action="edit"]')).toBeEnabled();
	await page.evaluate(() =>
		window.referenceManagerTest.dialogs(
			[],
			['Manual2026', 'Manual reference', 'Author', '2026', '', '', '', '', '', '', '', '', ''],
		),
	);
	await library.locator('[data-action="add"]').click();
	await expect(library.getByRole('listbox').getByRole('option')).toHaveCount(3);
	const before = await page.evaluate(() => window.referenceManagerTest.library());
	await page.evaluate(async () => {
		await window.referenceManagerTest.write('/fixture/bad.ris', 'TY  - JOUR\nTI  - Missing ER\n');
		window.referenceManagerTest.dialogs(['/fixture/bad.ris']);
	});
	await library.locator('[data-action="import"]').click();
	await expect(library.getByRole('status')).toContainText('RIS import failed');
	expect(await page.evaluate(() => window.referenceManagerTest.library())).toEqual(before);
});
