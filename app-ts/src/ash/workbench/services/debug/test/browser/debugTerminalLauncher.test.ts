import assert from "node:assert/strict";
import { test } from "mocha";
import { type ITerminalService } from "../../../terminal/common/terminal.js";
import { runDebuggeeInTerminal } from "../../browser/debugTerminalLauncher.js";

test("runInTerminal creates an integrated PowerShell terminal with quoted arguments", async () => {
	const writes: string[] = [];
	const terminalService = {
		getProfiles: async () => [{ profileId: "powershell", title: "PowerShell", isDefault: true }],
		createTerminal: async () => ({ write: (value: string) => writes.push(value) }),
	} as unknown as ITerminalService;

	await runDebuggeeInTerminal(terminalService, { kind: "integrated", title: "Debug app", cwd: "C:\\work tree", args: ["C:\\bin\\app.exe", "a b", "don't"], env: { MODE: "debug value", REMOVE_ME: null } });

	assert.deepEqual(writes, ["$env:MODE='debug value'; Remove-Item -LiteralPath 'Env:REMOVE_ME' -ErrorAction SilentlyContinue; Set-Location -LiteralPath 'C:\\work tree'; & 'C:\\bin\\app.exe' 'a b' 'don''t'\r"]);
});

test("runInTerminal rejects unsupported external terminals before creating one", async () => {
	const terminalService = { getProfiles: async () => { throw new Error("must not run"); } } as unknown as ITerminalService;
	await assert.rejects(() => runDebuggeeInTerminal(terminalService, { kind: "external", args: ["app"] }), /External debug terminals are not supported/);
});
