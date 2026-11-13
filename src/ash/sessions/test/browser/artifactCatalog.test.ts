import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { observableValue, autorun } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { createTestFileService } from '../../../workbench/test/common/testEditorServices.js';
import { ArtifactCatalog } from '../../contrib/artifact/browser/artifactCatalog.js';
import { artifactDate, selectArtifactCards, type ArtifactCatalogOptions } from '../../contrib/artifact/browser/artifactCatalogView.js';
import type { ArtifactCard } from '../../contrib/artifact/browser/artifactWorkspaceRegistry.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { setNlsMessages, resetNlsResolver } from '../../../nls.js';

const options: ArtifactCatalogOptions = { sort: 'modified', descending: true, owner: 'anyone', kind: 'any' };
const card = (title: string, fields: Partial<ArtifactCard> = {}): ArtifactCard => ({ title, kind: 'docs', detail: 'Docs', owner: 'you', command: { id: 'open', args: [] }, ...fields });

test('Artifact sorting uses real dates, places missing dates last in both directions and combines filters', () => {
	const cards = [card('Beta', { modifiedAt: 200, createdAt: 10 }), card('Alpha', { modifiedAt: 100, createdAt: 20, owner: 'others' }), card('Unknown'), card('Deck', { kind: 'slides', createdAt: 300 })];
	const names = (overrides: Partial<ArtifactCatalogOptions>, query = '') => selectArtifactCards(cards, { ...options, ...overrides }, query).map(card => card.title);
	assert.deepEqual(names({}), ['Deck', 'Beta', 'Alpha', 'Unknown']);
	assert.deepEqual(names({ descending: false }), ['Alpha', 'Beta', 'Deck', 'Unknown']);
	assert.deepEqual(names({ sort: 'created' }), ['Deck', 'Alpha', 'Beta', 'Unknown']);
	assert.deepEqual(names({ sort: 'name', descending: false }), ['Alpha', 'Beta', 'Deck', 'Unknown']);
	assert.deepEqual(names({ owner: 'others', kind: 'docs' }, 'ALP'), ['Alpha']);
	assert.deepEqual(names({ owner: 'others', kind: 'slides' }), []);
	assert.deepEqual(cards.map(card => card.title), ['Beta', 'Alpha', 'Unknown', 'Deck']);
});

test('Artifact dates distinguish recent, absolute and unknown dates and use Chinese localization', () => {
	const now = new Date(2026, 6, 15, 12).getTime();
	assert.equal(artifactDate(now, now).label, 'Just now');
	assert.equal(artifactDate(now - 2 * 3_600_000, now).label, '2 hours ago');
	assert.equal(artifactDate(now - 86_400_000, now).label, 'yesterday');
	assert.match(artifactDate(now - 8 * 86_400_000, now).label, /Jul/u);
	assert.equal(artifactDate(undefined, now).label, 'Date unavailable');
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		assert.equal(artifactDate(now, now).label, '刚刚');
		assert.equal(artifactDate(now - 2 * 3_600_000, now).label, '2小时前');
		assert.equal(artifactDate(undefined, now).label, '日期未知');
	} finally { resetNlsResolver(); }
});

async function waitForCards(catalog: ArtifactCatalog, predicate: (cards: readonly ArtifactCard[]) => boolean): Promise<void> {
	let resolve!: () => void;
	const done = new Promise<void>(complete => { resolve = complete; });
	using observation = autorun(reader => { if (predicate(catalog.cards.read(reader))) resolve(); });
	await done;
}

test('Catalog reads file metadata without writing and observes saved edits without changing creation dates', async () => {
	let timestamp = 1000;
	let writes = 0;
	using provider = new class extends InMemoryFileSystemProvider {
		override async stat(resource: URI) { return { ...await super.stat(resource), modifiedAtMillis: timestamp }; }
	}();
	using files = createTestFileService(provider);
	const resource = URI.file('/draft.md');
	await files.createDirectory(URI.file('/'));
	await files.writeFile({ resource, content: 'original' });
	using changes = files.onDidChangeFiles(() => { writes++; });
	const source = observableValue<readonly ArtifactCard[]>('test', [card('Draft', { resource, createdAt: 500 })]);
	using catalog = new ArtifactCatalog([{ cards: source }], files);
	await waitForCards(catalog, cards => cards[0]?.modifiedAt === 1000);
	assert.equal(writes, 0);
	assert.equal(catalog.cards.get()[0].createdAt, 500);
	timestamp = 2000;
	await files.writeFile({ resource, content: 'edited' });
	await waitForCards(catalog, cards => cards[0]?.modifiedAt === 2000);
	assert.equal(catalog.cards.get()[0].createdAt, 500);
	assert.equal(writes, 1);
	source.set([], undefined);
	assert.deepEqual(catalog.cards.get(), []);
});

test('Catalog preserves dates and order during metadata refresh and ignores equivalent source updates', async () => {
	let timestamp = 1000;
	let pending: { started: DeferredPromise<void>; finish: DeferredPromise<void>; } | undefined;
	using provider = new class extends InMemoryFileSystemProvider {
		override async stat(resource: URI) {
			const result = { ...await super.stat(resource), modifiedAtMillis: timestamp };
			if (pending) {
				const { started, finish } = pending;
				await started.complete();
				await finish.p;
			}
			return result;
		}
	}();
	using files = createTestFileService(provider);
	const resource = URI.file('/draft.md');
	await files.createDirectory(URI.file('/'));
	await files.writeFile({ resource, content: 'original' });
	const draft = card('Draft', { resource, createdAt: 100 });
	const other = card('Other', { modifiedAt: 500 });
	const source = observableValue<readonly ArtifactCard[]>('test', [draft, other]);
	using catalog = new ArtifactCatalog([{ cards: source }], files);
	await waitForCards(catalog, cards => cards[0]?.modifiedAt === 1000);
	const snapshots: { dates: (number | undefined)[]; order: string[]; }[] = [];
	using observation = autorun(reader => {
		const cards = catalog.cards.read(reader);
		snapshots.push({ dates: cards.map(card => card.modifiedAt), order: selectArtifactCards(cards, options, '').map(card => card.title) });
	});
	const initial = { dates: [1000, 500], order: ['Draft', 'Other'] };
	source.set([{ ...draft, command: { id: 'open', args: [] } }, { ...other }], undefined);
	assert.deepEqual(snapshots, [initial]);

	// A slow metadata read must not temporarily fall back to the older creation date.
	await files.writeFile({ resource, content: 'edited' });
	timestamp = 2000;
	pending = { started: new DeferredPromise<void>(), finish: new DeferredPromise<void>() };
	try {
		await pending.started.p;
		assert.deepEqual(snapshots, [initial]);
		// Navigation can publish equivalent source cards while the read is in flight.
		source.set([{ ...draft }, { ...other }], undefined);
		assert.deepEqual(snapshots, [initial]);
	} finally {
		await pending.finish.complete();
		pending = undefined;
	}
	await waitForCards(catalog, cards => cards[0]?.modifiedAt === 2000);
	assert.deepEqual(snapshots, [initial, { dates: [2000, 500], order: ['Draft', 'Other'] }]);
});
