import assert from "node:assert/strict";
import { test } from "mocha";
import { parseLaunchConfigurationDocument, parseLaunchConfigurations } from "../../common/launchConfiguration.js";

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
		adapter: { program: "adapter", arguments: ["--stdio"] },
		arguments: { program: "${workspaceFolder}/app", stopOnEntry: true },
	}]);
});

test("launch configurations reject implicit adapter discovery", () => {
	assert.throws(() => parseLaunchConfigurations('{"version":"0.2.0","configurations":[{"name":"Debug","type":"node","request":"launch"}]}'), /debugAdapter must be an object/);
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
