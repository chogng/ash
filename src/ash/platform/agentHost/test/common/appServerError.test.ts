import assert from 'node:assert/strict';
import { test } from 'mocha';
import { readFileSync } from 'node:fs';
import { AppServerRemoteError } from '../../common/appServerError.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { decodeAppServerResponse } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';

test('stopping initialization preserves the structured cause and localizes its explanation', () => {
	try {
		const bundles = JSON.parse(readFileSync('localization/zh-CN/workbench.json', 'utf8'));
		setNlsMessages('zh-CN', bundles);
		const response = decodeAppServerResponse('initialize', { jsonrpc: '2.0', id: 42, error: { code: -32600, message: 'diagnostic changed', data: { kind: 'ServerShuttingDown' } } });
		assert.ok('error' in response);
		const error = new AppServerRemoteError(response.error.code, response.error.message, response.error.data);
		assert.deepEqual({ code: error.code, kind: error.errorName, message: error.message }, { code: -32600, kind: 'ServerShuttingDown', message: 'App Server 正在停止。请等待停止完成后重新连接。' });
		const rejection = new AppServerRemoteError(-32600, 'rejected', { kind: 'InvalidRequest' });
		assert.equal(rejection.message, 'rejected');
	} finally {
		resetNlsResolver();
	}
});
