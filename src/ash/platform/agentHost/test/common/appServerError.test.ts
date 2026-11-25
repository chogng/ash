import { languagePackCatalog as chineseCatalog } from '../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AppServerRemoteError } from '../../common/appServerError.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { decodeAppServerResponse } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';

test('App Server errors preserve structured causes and localize actionable recovery', () => {
	try {
		const bundles = chineseCatalog.bundles;
		setNlsMessages('zh-CN', bundles);
		const response = decodeAppServerResponse('initialize', { jsonrpc: '2.0', id: 42, error: { code: -32600, message: 'diagnostic changed', data: { kind: 'ServerShuttingDown' } } });
		assert.ok('error' in response);
		const error = new AppServerRemoteError(response.error.code, response.error.message, response.error.data);
		assert.deepEqual({ code: error.code, kind: error.errorName, message: error.message }, { code: -32600, kind: 'ServerShuttingDown', message: 'App Server 正在停止。请等待停止完成后重新连接。' });
		for (const [kind, prefix] of [
			['GitWorktreePathTooLong', '工作树路径超出文件系统限制。'],
			['GitWorktreeLfsUnavailable', '此仓库需要 Git LFS。'],
			['GitWorktreeLocked', 'Git 锁阻止了工作树创建。'],
		] as const) {
			const failure = decodeAppServerResponse('git/worktree/create', {
				jsonrpc: '2.0', id: 43, error: { code: -32061, message: kind, data: { kind } },
			});
			assert.ok('error' in failure);
			const worktreeError = new AppServerRemoteError(failure.error.code, failure.error.message, failure.error.data);
			assert.equal(worktreeError.errorName, kind);
			assert.ok(worktreeError.message.startsWith(prefix), worktreeError.message);
		}
		const rejection = new AppServerRemoteError(-32600, 'rejected', { kind: 'InvalidRequest' });
		assert.equal(rejection.message, 'rejected');
	} finally {
		resetNlsResolver();
	}
});
