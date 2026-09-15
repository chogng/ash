import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractMember, materialize } from "./artifacts.ts";

test("a failed concurrent download preserves the verified cache and cached reads stay offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-download-"));
  const body = Buffer.from("verified runtime");
  const digest = createHash("sha256").update(body).digest("hex");
  let badResponse: ServerResponse;
  let requested!: () => void;
  const badRequested = new Promise<void>(resolve => { requested = resolve; });
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    if (request.url === "/bad") { badResponse = response; requested(); }
    else response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const destination = join(root, "runtime");
  try {
    const bad = assert.rejects(materialize({ url: `${url}/bad`, sha256: digest, size: body.length }, destination, 100), /SHA-256/);
    await badRequested;
    await materialize({ url, sha256: digest, size: body.length }, destination, 100);
    badResponse!.end("wrong");
    await bad;
    await materialize({ url: `${url}/unused`, sha256: digest, size: body.length }, destination, 100);
    assert.equal(count, 2);
    assert.deepEqual(await readFile(destination), body);
    assert.deepEqual(await readdir(root), ["runtime"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads enforce the byte limit while streaming and preserve an existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-download-limit-"));
  const server = createServer((_request, response) => { response.write(Buffer.alloc(1024)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const destination = join(root, "runtime");
  try {
    await writeFile(destination, "previous");
    await assert.rejects(materialize({ url: `http://127.0.0.1:${address.port}`, sha256: "0".repeat(64) }, destination, 32), /exceeds size limit/);
    assert.equal(await readFile(destination, "utf8"), "previous");
    assert.deepEqual(await readdir(root), ["runtime"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel extraction publishes complete content and extraction failure preserves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-extract-"));
  try {
    await writeFile(join(root, "member"), "archive payload");
    const archive = join(root, "input.tar");
    const result = spawnSync("tar", ["-cf", archive, "-C", root, "member"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const destination = join(root, "output");
    await Promise.all(Array.from({ length: 8 }, () => extractMember(archive, "member", destination, 100)));
    assert.equal(await readFile(destination, "utf8"), "archive payload");
    await assert.rejects(extractMember(archive, "member", destination, 2), /exceeds size limit/);
    await assert.rejects(extractMember(archive, "missing", destination, 100), /Could not extract/);
    assert.equal(await readFile(destination, "utf8"), "archive payload");
    assert.deepEqual((await readdir(root)).sort(), ["input.tar", "member", "output"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
