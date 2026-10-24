import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event, type Event as EventContract } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../files/common/files.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { MemoryFileService } from '../../../../workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { IUriIdentityService } from '../../common/uriIdentity.js';
import { UriIdentityService } from '../../common/uriIdentityService.js';
import { TestUriIdentityServices } from './uriIdentityTestServices.js';

suite('Provider-aware URI identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses comparison keys and refreshes the same URI after provider path identity changes', () => {
		using changes = new Emitter<void>();
		let reads = 0;
		let path = '/first';
		const provider = new class extends MemoryFileService {
			readonly onDidChangePathIdentity = changes.event;
			retainPathIdentity() { return Disposable.None; }
			async resolvePathIdentity(): Promise<void> { }
			getPathIdentity(resource: URI) {
				reads++;
				return { comparisonResource: resource.with({ path }) };
			}
		}([]);
		using files = new FileService();
		using registration = files.registerProvider('identity', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = URI.parse('identity:/File?revision=1#one');
		const full = identity.extUri.getComparisonKey(resource);
		const withoutFragment = identity.extUri.getComparisonKeyIgnoringFragment(resource);
		assert.notEqual(full, withoutFragment);
		for (let index = 0; index < 10; index++) {
			assert.equal(identity.extUri.getComparisonKey(resource), full);
			assert.equal(identity.extUri.getComparisonKeyIgnoringFragment(resource), withoutFragment);
		}
		assert.equal(reads, 2);
		assert.notEqual(identity.extUri.getComparisonKey(resource.with({ query: 'revision=2' })), full);
		assert.notEqual(identity.extUri.getComparisonKey(resource.with({ fragment: 'two' })), full);
		assert.equal(identity.extUri.getComparisonKeyIgnoringFragment(resource.with({ fragment: 'two' })), withoutFragment);
		path = '/second';
		changes.fire();
		assert.notEqual(identity.extUri.getComparisonKey(resource), full);
		assert.notEqual(identity.extUri.getComparisonKeyIgnoringFragment(resource), withoutFragment);
	});

	test('invalidates warmed URI keys on capability changes and provider replacement', () => {
		using changes = new Emitter<void>();
		using files = new FileService();
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const lower = URI.parse('identity:/file#anchor');
		const upper = URI.parse('identity:/FILE#anchor');
		assert.equal(identity.extUri.isEqual(lower, upper), false);
		const provider = new IdentityProvider(false, changes.event);
		const registration = files.registerProvider('identity', provider);
		assert.equal(identity.extUri.isEqual(lower, upper), true);
		provider.capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
		changes.fire();
		assert.equal(identity.extUri.isEqual(lower, upper), false);
		assert.notEqual(identity.extUri.getComparisonKeyIgnoringFragment(lower), identity.extUri.getComparisonKeyIgnoringFragment(upper));
		registration.dispose();
		using replacement = files.registerProvider('identity', new IdentityProvider(false));
		assert.equal(identity.extUri.isEqual(lower, upper), true);
		assert.equal(identity.extUri.getComparisonKeyIgnoringFragment(lower), identity.extUri.getComparisonKeyIgnoringFragment(upper));
	});

	test('provider capabilities select path casing independently of the renderer OS', () => {
		using files = new FileService();
		using insensitive = files.registerProvider('insensitive', new IdentityProvider(false));
		using sensitive = files.registerProvider('sensitive', new IdentityProvider(true));
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		assert.deepEqual(['insensitive', 'sensitive', 'unknown'].map(scheme => identity.extUri.isEqual(URI.parse(`${scheme}:/Root/File`), URI.parse(`${scheme}:/root/file`))), [true, false, false]);
	});

	test('canonical spelling normalizes registered paths while retaining query and requested fragments', () => {
		using files = new FileService();
		using registration = files.registerProvider('identity', new IdentityProvider(false));
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const first = URI.parse('identity:/Root/file?revision=1#first');
		assert.equal(identity.asCanonicalUri(first), first);
		assert.deepEqual([
			identity.asCanonicalUri(URI.parse('identity:/ROOT/./folder/../FILE?revision=1#second%2Fanchor')).toString(),
			identity.asCanonicalUri(URI.parse('identity:/ROOT/FILE?revision=2')).toString(),
			identity.asCanonicalUri(URI.parse('identity:/Root/a%2Fb')).toString(),
			identity.asCanonicalUri(URI.parse('identity:/Root/a/b')).toString(),
		], ['identity:/Root/file?revision=1#second%2Fanchor', 'identity:/ROOT/FILE?revision=2', 'identity:/Root/a%2Fb', 'identity:/Root/a/b']);
	});

	test('unregistered schemes preserve their URI without applying file path normalization', () => {
		using services = new TestUriIdentityServices();
		const resource = URI.parse('document:/folder/../File#anchor');
		assert.equal(services.get(IUriIdentityService).asCanonicalUri(resource), resource);
	});

	test('capability changes discard only the affected scheme canonical spelling', () => {
		using changes = new Emitter<void>();
		const provider = new IdentityProvider(false, changes.event);
		using files = new FileService();
		using firstRegistration = files.registerProvider('identity', provider);
		using otherRegistration = files.registerProvider('other', new IdentityProvider(false));
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		identity.asCanonicalUri(URI.parse('identity:/lower'));
		const other = identity.asCanonicalUri(URI.parse('other:/lower'));
		provider.capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
		changes.fire();
		assert.equal(identity.extUri.isEqual(URI.parse('identity:/lower'), URI.parse('identity:/LOWER')), false);
		assert.equal(identity.asCanonicalUri(URI.parse('identity:/LOWER')).toString(), 'identity:/LOWER');
		assert.equal(identity.asCanonicalUri(URI.parse('other:/LOWER')), other);
	});

	test('provider removal and replacement reset identity even without intervening queries', () => {
		using files = new FileService();
		const registration = files.registerProvider('identity', new IdentityProvider(false));
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		identity.asCanonicalUri(URI.parse('identity:/lower'));
		registration.dispose();
		using replacement = files.registerProvider('identity', new IdentityProvider(true));
		const upper = URI.parse('identity:/UPPER');
		assert.equal(identity.asCanonicalUri(upper), upper);
		assert.equal(identity.asCanonicalUri(URI.parse('identity:/LOWER')).toString(), 'identity:/LOWER');
	});

	test('cache eviction preserves recently used identities and allows old transient identities to expire', () => {
		using files = new FileService();
		using registration = files.registerProvider('identity', new IdentityProvider(false));
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const first = identity.asCanonicalUri(URI.parse('identity:/first'));
		const second = identity.asCanonicalUri(URI.parse('identity:/second'));
		for (let index = 0; index < 4094; index++) identity.asCanonicalUri(URI.parse(`identity:/temporary-${index}`));
		assert.equal(identity.asCanonicalUri(URI.parse('identity:/FIRST')), first);
		identity.asCanonicalUri(URI.parse('identity:/overflow'));
		assert.equal(identity.asCanonicalUri(URI.parse('identity:/FIRST')), first);
		assert.notEqual(identity.asCanonicalUri(URI.parse('identity:/second')), second);
	});

	test('service construction rejects a missing file-service registration', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(UriIdentityService), /fileService/);
	});

	test('disposal releases provider listeners and rejects new canonicalization', () => {
		using files = new FileService();
		using services = new InstantiationService();
		services.registerInstance(IFileService, files);
		const identity = services.createInstance(UriIdentityService);
		identity.dispose();
		using registration = files.registerProvider('identity', new IdentityProvider(false));
		assert.throws(() => identity.asCanonicalUri(URI.parse('identity:/file')), ReferenceError);
	});
});

class IdentityProvider extends MemoryFileService {
	public override capabilities: FileSystemProviderCapabilities;
	public override readonly onDidChangeCapabilities: EventContract<void>;

	constructor(caseSensitive: boolean, changes: EventContract<void> = Event.None) {
		super([]);
		this.capabilities = FileSystemProviderCapabilities.FileReadWrite | (caseSensitive ? FileSystemProviderCapabilities.PathCaseSensitive : FileSystemProviderCapabilities.None);
		this.onDidChangeCapabilities = changes;
	}
}
