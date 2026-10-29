import assert from 'node:assert/strict';
import { test } from 'mocha';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { FileOperationNotSupportedError } from '../../../../../../platform/files/common/files.js';
import { ChatResponseResourceFileSystemProvider } from '../../../common/widget/chatResponseResourceFileSystemProvider.js';
import { URI } from '../../../../../../base/common/uri.js';

test('response resources share immutable bytes by association and release only the last reference', async () => {
	using provider = new ChatResponseResourceFileSystemProvider();
	using files = new FileService();
	using registration = files.registerProvider('chat-response-resource', provider);
	const bytes = new TextEncoder().encode('# File\r\n审阅\r\n');
	const first = provider.associate(bytes, { id: 'result', name: 'review.md' });
	const second = provider.associate(bytes, { id: 'result', name: 'other.md' });
	assert.equal(first.resource.toString(), second.resource.toString());
	bytes[0] = 0;
	const read = await files.readFileBytes(first.resource);
	assert.equal(new TextDecoder().decode(read.bytes), '# File\r\n审阅\r\n');
	read.bytes[0] = 0;
	assert.equal((await files.stat(first.resource)).readonly, true);
	assert.equal(new TextDecoder().decode((await files.readFileBytes(first.resource)).bytes), '# File\r\n审阅\r\n');
	await assert.rejects(async () => files.writeFile({ resource: first.resource, content: 'overwrite' }), FileOperationNotSupportedError);
	await assert.rejects(provider.writeFile(), /read.only/iu);
	assert.equal(new TextDecoder().decode((await files.readFileBytes(first.resource)).bytes), '# File\r\n审阅\r\n');
	first.dispose();
	assert.equal((await files.readFileBytes(second.resource)).bytes.length, new TextEncoder().encode('# File\r\n审阅\r\n').length);
	second.dispose();
	await assert.rejects(files.readFileBytes(second.resource), /no longer available/iu);
});

test('response resource reads cannot substitute a remote URI or another generated association', async () => {
	using provider = new ChatResponseResourceFileSystemProvider();
	using association = provider.associate(Uint8Array.from([0, 255, 1]), { name: 'data.bin' });
	assert.deepEqual((await provider.readFile(association.resource)).bytes, Uint8Array.from([0, 255, 1]));
	for (const resource of [URI.parse('file:///data.bin'), association.resource.with({ authority: 'other' }), association.resource.with({ path: '/other.bin' })]) await assert.rejects(provider.readFile(resource), /no longer available/iu);
	provider.dispose();
	await assert.rejects(provider.readFile(association.resource), /disposed/iu);
});
