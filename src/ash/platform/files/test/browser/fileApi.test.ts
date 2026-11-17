import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { createAppServerFileApi } from '../../browser/fileApi.js';

test('remote directory resolution converts URI drive and UNC spelling at the file adapter boundary', async () => {
	for (const [uriPath, hostPath, backendRoot] of [
		['/C:/Work/Project', 'C:/Work/Project', 'C:\\Work\\Project'],
		['//server/Share/Project', '//server/Share/Project', '\\\\server\\Share\\Project'],
		['/home/user/Project', '/home/user/Project', '/home/user/Project'],
	]) {
		const requests: unknown[] = [];
		const client = {
			request: async (_method: unknown, params: unknown) => {
				requests.push(params);
				return { root: backendRoot, target: { type: 'environment', dirId: 'published-root' } };
			}
		} as unknown as AppServerProtocolClient;
		const resource = URI.from({ scheme: 'ash-remote', authority: 'tunnel+6c65617365', path: uriPath });
		const directory = await createAppServerFileApi(client).resolvePath(resource);
		assert.deepEqual(requests, [{ path: hostPath }]);
		assert.deepEqual(directory, { uri: resource, target: { type: 'environment', dirId: 'published-root' } });
		const linked = await createAppServerFileApi(client).resolvePath(resource.with({ query: 'view=code', fragment: 'L8' }));
		assert.deepEqual(linked, directory);
		assert.deepEqual(requests, [{ path: hostPath }, { path: hostPath }]);
	}
});
