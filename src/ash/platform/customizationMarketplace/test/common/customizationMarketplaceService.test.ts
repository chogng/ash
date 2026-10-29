import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import {
	CustomizationMarketplaceService,
	CustomizationMarketplaceMediaType,
	type ICustomizationMarketplaceProvider,
	type ICustomizationMarketplaceResource,
} from '../../common/customizationMarketplaceService.js';

function resource(sourceId: string, identifier: string): ICustomizationMarketplaceResource {
	return {
		sourceId,
		identifier,
		displayName: identifier,
		description: '',
		version: '1.0.0',
		mediaType: CustomizationMarketplaceMediaType.Skill,
		capabilities: ['skill'],
		installation: { kind: 'providerCatalog', resourceKind: 'skill', selectionId: identifier },
	};
}

suite('Customization marketplace continuations', () => {
	test('overlapping identities across native pages are rendered once', async () => {
		using service = new CustomizationMarketplaceService([
			{
				id: 'source',
				sourceId: 'source',
				query: async options => (options.cursor ? { items: [resource('source', 'first'), resource('source', 'second')] } : { items: [resource('source', 'first')], nextCursor: 'two' }),
			},
		]);
		const page = await service.query({ sourceIds: ['source'], pageSize: 2 }, CancellationToken.None);
		assert.deepEqual(
			page.items.map(item => item.identifier),
			['first', 'second'],
		);
		assert.equal(page.nextCursor, undefined);
	});
	test('pages selected sources and keeps failed sources suspended while healthy pages continue', async () => {
		let failures = 0;
		const calls: (string | undefined)[] = [];
		using service = new CustomizationMarketplaceService([
			{
				id: 'healthy',
				sourceId: 'healthy',
				query: async options => {
					calls.push(options.cursor);
					return options.cursor
						? { items: [resource('healthy', 'third')], total: 3 }
						: {
								items: [resource('healthy', 'first'), resource('healthy', 'second')],
								total: 3,
								nextCursor: 'native-page-two',
							};
				},
			},
			{
				id: 'failed',
				sourceId: 'failed',
				query: async () => {
					failures++;
					throw new Error('Failed feed');
				},
			},
		]);
		const request = { sourceIds: ['healthy', 'failed'], pageSize: 2 };
		const first = await service.query(request, CancellationToken.None);
		assert.deepEqual(
			first.items.map(item => item.identifier),
			['first', 'second'],
		);
		assert.equal(first.total, undefined);
		assert.ok(first.nextCursor);
		const second = await service.query({ ...request, cursor: first.nextCursor }, CancellationToken.None);
		assert.deepEqual(
			second.items.map(item => item.identifier),
			['third'],
		);
		assert.equal(second.nextCursor, undefined);
		assert.deepEqual(second.sourceErrors, [{ sourceId: 'failed', message: 'Failed feed' }]);
		assert.deepEqual(calls, [undefined, 'native-page-two']);
		assert.equal(failures, 1);
	});

	test('unknown, consumed and query-mismatched cursors cannot resume a page', async () => {
		using service = new CustomizationMarketplaceService([
			{
				id: 'source',
				sourceId: 'source',
				query: async () => ({ items: [resource('source', 'one')], nextCursor: 'two', total: 2 }),
			},
		]);
		const request = { sourceIds: ['source'], pageSize: 1 };
		const first = await service.query(request, CancellationToken.None);
		await assert.rejects(service.query({ ...request, query: 'changed', cursor: first.nextCursor }, CancellationToken.None), /expired or changed/);
		await assert.rejects(service.query({ ...request, cursor: { token: 'forged' } }, CancellationToken.None), /expired or changed/);
		await service.query({ ...request, cursor: first.nextCursor }, CancellationToken.None);
		await assert.rejects(service.query({ ...request, cursor: first.nextCursor }, CancellationToken.None), /expired or changed/);
	});

	test('unselected sources perform no work and known totals combine across physical registries', async () => {
		let unselected = 0;
		const providers: ICustomizationMarketplaceProvider[] = ['one', 'two'].map(sourceId => ({
			id: sourceId,
			sourceId,
			query: async () => ({ items: [resource(sourceId, 'same-name')], total: 1 }),
		}));
		providers.push({
			id: 'unselected',
			sourceId: 'unselected',
			query: async () => {
				unselected++;
				throw new Error('Should not query');
			},
		});
		using service = new CustomizationMarketplaceService(providers);
		const page = await service.query({ sourceIds: ['two', 'one'] }, CancellationToken.None);
		assert.equal(page.items.length, 2);
		assert.equal(page.total, 2);
		assert.equal(unselected, 0);
	});

	test('empty native pages advance and cycling cursors terminate', async () => {
		using service = new CustomizationMarketplaceService([
			{
				id: 'source',
				sourceId: 'source',
				query: async options => (options.cursor ? { items: [resource('source', 'one'), resource('source', 'one')], nextCursor: 'cycle' } : { items: [], nextCursor: 'cycle' }),
			},
		]);
		const page = await service.query({ sourceIds: ['source'], pageSize: 3 }, CancellationToken.None);
		assert.equal(page.items.length, 0);
		assert.match(page.sourceErrors![0].message, /invalid page/);
		assert.equal(page.nextCursor, undefined);
	});
});
