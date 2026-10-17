import assert from "node:assert/strict";
import { test } from "mocha";
import { ConfigurationManager, parseLaunchConfigurationDocument, parseLaunchConfigurations } from "../../browser/debugConfigurationManager.js";

test('configuration manager reconciles selection against refreshed catalogs and compounds', async () => {
	using manager = new ConfigurationManager();
	const document = parseLaunchConfigurationDocument(JSON.stringify({
		version: '0.2.0', configurations: [
			{ name: 'First', type: 'demo', request: 'launch' },
			{ name: 'Second', type: 'demo', request: 'launch' },
		], compounds: [{ name: 'Both', configurations: ['First', 'Second'] }]
	}));
	const selections: (string | undefined)[] = [];
	using listener = manager.onDidSelectConfiguration(() => selections.push(manager.selectedConfiguration?.name));
	manager.setConfigurations(document.configurations, document.compounds);
	await manager.selectConfiguration(document.configurations[1]);
	const refreshed = document.configurations.map(configuration => ({ ...configuration, arguments: { changed: true } }));
	manager.setConfigurations(refreshed, document.compounds);
	assert.equal(manager.selectedConfiguration, refreshed[1]);
	await manager.selectConfiguration(document.compounds[0]);
	assert.equal(manager.selectedConfiguration, document.compounds[0]);
	manager.setConfigurations([refreshed[0]!], []);
	assert.equal(manager.selectedConfiguration, refreshed[0]);
	manager.setConfigurations([], []);
	assert.equal(manager.selectedConfiguration, undefined);
	assert.deepEqual(selections, ['First', 'Second', 'Second', 'Both', 'First', undefined]);
});

test("launch configurations parse an explicit generic DAP command", () => {
	const configurations = parseLaunchConfigurations(`{
    // Ash keeps the adapter launch explicit and language-neutral.
    "version": "0.2.0",
    "configurations": [{
      "name": "Debug app",
      "type": "example",
      "request": "launch",
      "debugAdapter": { "program": "adapter", "args": ["--stdio"] },
      "program": "${"${workspaceFolder}"}/app",
      "stopOnEntry": true,
    }],
  }`);

	assert.deepEqual(configurations, [{
		id: "launch:0:debug-app",
		name: "Debug app",
		type: "example",
		request: "launch",
		adapterExplicit: true,
		adapter: { program: "adapter", arguments: ["--stdio"] },
		arguments: { program: "${workspaceFolder}/app", stopOnEntry: true },
	}]);
});

test("launch configurations retain a dormant type before its descriptor factory activates", () => {
	const configuration = parseLaunchConfigurations('{"version":"0.2.0","configurations":[{"name":"Debug","type":"node","request":"launch"}]}')[0]!;
	assert.equal(configuration.type, 'node');
	assert.equal(configuration.adapter, undefined);
	assert.equal(configuration.adapterExplicit, false);
});

test("launch documents keep task orchestration out of DAP arguments and resolve compounds separately", () => {
	const document = parseLaunchConfigurationDocument(`{
    "version": "0.2.0",
    "configurations": [{
      "name": "Server",
      "type": "example",
      "request": "launch",
      "debugAdapter": { "program": "adapter" },
      "program": "server",
      "preLaunchTask": "build",
      "postDebugTask": "cleanup"
    }],
    "compounds": [{ "name": "Everything", "configurations": ["Server"], "preLaunchTask": "prepare", "stopAll": true }]
  }`);

	assert.deepEqual(document.configurations[0], {
		id: "launch:0:server",
		name: "Server",
		type: "example",
		request: "launch",
		adapterExplicit: true,
		adapter: { program: "adapter", arguments: [] },
		arguments: { program: "server" },
		preLaunchTask: "build",
		postDebugTask: "cleanup",
	});
	assert.deepEqual(document.compounds, [{ id: "compound:0:everything", name: "Everything", configurations: ["Server"], preLaunchTask: "prepare", stopAll: true }]);
});

test("launch configurations resolve declarative extension debug adapters by type", () => {
	const configurations = parseLaunchConfigurations('{"version":"0.2.0","configurations":[{"name":"Debug","type":"demo","request":"launch","program":"app"}]}', type => type === "demo" ? { program: "demo-adapter", arguments: ["--stdio"] } : undefined);
	assert.deepEqual(configurations[0]?.adapter, { program: "demo-adapter", arguments: ["--stdio"] });
	assert.deepEqual(configurations[0]?.arguments, { program: "app" });
});


test('launch compounds retain folder-qualified references and reject missing selectors', () => {
	const document = parseLaunchConfigurationDocument(JSON.stringify({ version: '0.2.0', configurations: [], compounds: [{ name: 'Both', configurations: [{ name: 'Launch', folder: 'Server' }, 'Client'] }] }));
	assert.deepEqual(document.compounds[0]?.configurations, [{ name: 'Launch', folder: 'Server' }, 'Client']);
	assert.throws(() => parseLaunchConfigurationDocument(JSON.stringify({ version: '0.2.0', configurations: [], compounds: [{ name: 'Invalid', configurations: [{ name: 'Launch' }] }] })), /folder/);
});
