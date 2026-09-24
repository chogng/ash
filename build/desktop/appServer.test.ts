import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cargoArtifactExecutable, cargoRenderedDiagnostic, parseCargoMessage } from "../lib/cargo.ts";
import { publishAppServerGeneration, relativeWatchedDirectory, shouldRebuildAppServer, shouldRebuildWorkspaceManifest, watchAppServer } from "./appServer.ts";

test("reads executable paths and diagnostics from Cargo JSON messages", () => {
  const artifact = parseCargoMessage(JSON.stringify({
    executable: "/custom/target/aarch64-apple-darwin/dev-small/ash-app-server",
    reason: "compiler-artifact",
    target: { kind: ["bin"], name: "ash-app-server" },
  }));
  assert.ok(artifact && typeof artifact === "object");
  assert.equal(cargoArtifactExecutable(artifact, "ash-app-server"), "/custom/target/aarch64-apple-darwin/dev-small/ash-app-server");
  assert.equal(cargoArtifactExecutable(artifact, "other"), undefined);
  assert.equal(cargoArtifactExecutable({ ...artifact, executable: null }, "ash-app-server"), undefined);
  assert.equal(cargoRenderedDiagnostic({ reason: "compiler-message", message: { rendered: "warning\n" } }), "warning\n");
  assert.equal(parseCargoMessage("not JSON"), undefined);
});

test("app-server watcher selects Rust sources and Cargo manifests", () => {
  assert.equal(shouldRebuildAppServer("ash-rs/app-server/src/main.rs"), true);
  assert.equal(shouldRebuildAppServer("ash-rs/app-server/build.rs"), true);
  assert.equal(shouldRebuildAppServer("ash-rs/app-server/Cargo.toml"), true);
  assert.equal(shouldRebuildAppServer("Cargo.lock"), true);
  assert.equal(shouldRebuildAppServer("target/debug/ash-app-server"), false);
  assert.equal(shouldRebuildAppServer("target/debug/build/generated/out/schema.rs"), false);
  assert.equal(shouldRebuildAppServer("crate/target/debug/build/generated/out/schema.rs"), false);
  assert.equal(shouldRebuildAppServer("ash-ts/src/main.ts"), false);
  assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_decoder.template.ts'), true);
  assert.equal(shouldRebuildAppServer('app-server-protocol/src/typescript_web.template.ts'), true);
  assert.equal(shouldRebuildAppServer('app-server-protocol/schema/typescript/index.ts'), false);
});

test("app-server watcher excludes a custom Cargo target directory inside Rust sources", () => {
  const sourceRoot = join("/workspace", "ash", "ash-rs");
  const customTarget = join(sourceRoot, ".cargo-cache");
  const ignored = relativeWatchedDirectory(sourceRoot, customTarget);
  assert.equal(ignored, ".cargo-cache");
  assert.equal(shouldRebuildAppServer(".cargo-cache/debug/build/codegen/out/generated.rs", ignored), false);
  assert.equal(shouldRebuildAppServer("app-server/src/main.rs", ignored), true);
  assert.equal(relativeWatchedDirectory(sourceRoot, join("/workspace", "ash", "target")), undefined);
});

test("workspace-root watcher accepts only canonical root manifests", () => {
  assert.equal(shouldRebuildWorkspaceManifest("Cargo.toml"), true);
  assert.equal(shouldRebuildWorkspaceManifest("Cargo.lock"), true);
  assert.equal(shouldRebuildWorkspaceManifest("app/main.rs"), false);
  assert.equal(shouldRebuildWorkspaceManifest("target/debug/build/generated/out/schema.rs"), false);
  assert.equal(shouldRebuildWorkspaceManifest("ash-rs/app-server/Cargo.toml"), false);
});

test("app-server publisher reuses identical content and retains one rollback generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-app-server-publisher-"));
  const source = join(root, "target", "debug", "ash-app-server");
  const generations = join(root, "generations");
  const pointer = join(generations, "current.json");
  try {
    await mkdir(join(root, "target", "debug"), { recursive: true });
    await writeFile(source, "one");
    const first = await publishAppServerGeneration(source, generations, pointer, "darwin");
    assert.equal(first.changed, true);
    assert.match(first.generation, /^ash-app-server\.[a-f0-9]{64}$/u);
    assert.equal((await readdir(generations)).filter(name => name.startsWith("ash-app-server.")).length, 1);

    const unchanged = await publishAppServerGeneration(source, generations, pointer, "darwin");
    assert.deepEqual(unchanged, { changed: false, generation: first.generation });
    assert.equal((await readdir(generations)).filter(name => name.startsWith("ash-app-server.")).length, 1);

    await writeFile(source, "two");
    const second = await publishAppServerGeneration(source, generations, pointer, "darwin");
    await utimes(join(generations, first.generation), new Date(1_000), new Date(1_000));
    await utimes(join(generations, second.generation), new Date(2_000), new Date(2_000));
    await writeFile(source, "three");
    const third = await publishAppServerGeneration(source, generations, pointer, "darwin");
    const published = (await readdir(generations)).filter(name => name.startsWith("ash-app-server.")).sort();
    assert.deepEqual(published, [second.generation, third.generation].sort());
    assert.deepEqual(JSON.parse(await readFile(pointer, "utf8")), { version: 1, executable: third.generation });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("app-server publisher removes duplicate legacy generations while preserving distinct rollback content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-app-server-publisher-"));
  const source = join(root, "target", "debug", "ash-app-server");
  const generations = join(root, "generations");
  const pointer = join(generations, "current.json");
  try {
    await mkdir(join(root, "target", "debug"), { recursive: true });
    await mkdir(generations);
    await writeFile(source, "current");
    await writeFile(join(generations, "ash-app-server.100.0"), "rollback");
    await writeFile(join(generations, "ash-app-server.200.0"), "current");
    await writeFile(join(generations, "ash-app-server.300.0"), "current");
    await writeFile(pointer, `${JSON.stringify({ version: 1, executable: "ash-app-server.300.0" })}\n`);

    const published = await publishAppServerGeneration(source, generations, pointer, "darwin");
    const files = (await readdir(generations)).filter(name => name.startsWith("ash-app-server.")).sort();
    assert.deepEqual(files, ["ash-app-server.100.0", published.generation].sort());
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("watcher regenerates protocol metadata before compiling and stops on generation failure", async (t) => {
  const commands: string[] = [];
  const failure = Promise.withResolvers<string>();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "watch", () => ({ close() {} }));
  t.mock.method(fsPromises, "readFile", async () => {
    throw Object.assign(new Error("No published generation"), { code: "ENOENT" });
  });
  t.mock.method(console, "error", (message: string) => failure.resolve(message));
  t.mock.method(childProcess, "spawn", (_command: string, args: readonly string[]) => {
    commands.push(args[0]);
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    setImmediate(() => child.emit("close", 1, null));
    return child;
  });
  syncBuiltinESMExports();
  const stop = await watchAppServer();
  t.after(stop);
  assert.match(await failure.promise, /Protocol generation exited with status 1/);
  assert.deepEqual(commands, ["run"]);
});
