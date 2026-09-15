import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH } from "../../ash-ts/generated/app-server/protocol.ts";
import { cargoTargetDirectory } from "../lib/cargo.ts";
import {
  assemblePackage,
  copyBuiltinExtensions,
  hostTarget,
  parseJavaScriptRuntime,
  parsePackageOptions,
  selectNodeArtifact,
  selectRipgrepArtifact,
  selectV8ArtifactPair,
} from "./prepareDevPackage.ts";

test("resolves one shared Cargo target directory for host development builds", () => {
  const workspace = resolve("/workspace/ash");
  assert.equal(cargoTargetDirectory(workspace, {}), join(workspace, ".build", "cargo"));
  assert.equal(cargoTargetDirectory(workspace, { CARGO_TARGET_DIR: "build/cargo" }), join(workspace, "build", "cargo"));
  assert.equal(cargoTargetDirectory(workspace, { CARGO_TARGET_DIR: "/cache/ash" }), resolve("/cache/ash"));
});

test("selects host-provided Node for Desktop and explicit packaged Node for headless hosts", () => {
  assert.equal(parseJavaScriptRuntime([]), "host-provided-node");
  assert.equal(parseJavaScriptRuntime(["--javascript-runtime", "packaged-node"]), "packaged-node");
  assert.throws(() => parseJavaScriptRuntime(["--javascript-runtime", "system-node"]), /Usage/);
});

test("parses an optional packaged Remote runtime bundle", () => {
  assert.deepEqual(parsePackageOptions(["--remote-runtime-bundle", "../runtime-bundle", "--javascript-runtime", "packaged-node"]), {
    javascriptRuntime: "packaged-node",
    remoteRuntimeBundle: resolve("../runtime-bundle"),
    remoteRuntimeRelease: undefined,
  });
  assert.throws(() => parsePackageOptions(["--remote-runtime-bundle"]), /Usage/);
  assert.throws(() => parsePackageOptions(["--remote-runtime-bundle", "one", "--remote-runtime-bundle", "two"]), /Usage/);
});

test("parses only a complete credential-free network Remote runtime release", () => {
  assert.deepEqual(parsePackageOptions([
    "--remote-runtime-catalog-url", "https://releases.example/ash/catalog.json",
    "--remote-runtime-catalog-sha256", "a".repeat(64),
  ]), {
    javascriptRuntime: "host-provided-node",
    remoteRuntimeBundle: undefined,
    remoteRuntimeRelease: { url: "https://releases.example/ash/catalog.json", sha256: "a".repeat(64) },
  });
  assert.throws(() => parsePackageOptions(["--remote-runtime-catalog-url", "https://user@releases.example/catalog.json", "--remote-runtime-catalog-sha256", "a".repeat(64)]), /credential-free HTTPS/);
  assert.throws(() => parsePackageOptions(["--remote-runtime-catalog-url", "https://releases.example/catalog.json"]), /Usage/);
});

test("maps supported development hosts to Rust targets", () => {
  assert.equal(hostTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(hostTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.throws(() => hostTarget("freebsd", "x64"), /Unsupported/);
});

test("selects the target-specific locked ripgrep artifact", () => {
  const lock = {
    artifacts: {
      windows: {
        archive: "rg.zip",
        executable: "bundle/rg.exe",
        format: "zip",
        sha256: "a".repeat(64),
        size: 123,
      },
    },
    packageTargets: { "x86_64-pc-windows-msvc": "windows" },
    runtime: "ripgrep",
    schemaVersion: 1,
    source: { release: "1.0.0", repository: "https://example.invalid/repo" },
    version: "1.0.0",
  };
  const artifact = selectRipgrepArtifact(lock, "x86_64-pc-windows-msvc");
  assert.equal(artifact.executable, "bundle/rg.exe");
  assert.equal(artifact.url, "https://example.invalid/repo/releases/download/1.0.0/rg.zip");
});

test("selects the target-specific locked Node.js artifact", () => {
  const lock = {
    artifacts: {
      windows: {
        archive: "node.zip",
        executable: "bundle/node.exe",
        format: "zip",
        license: "bundle/LICENSE",
        sha256: "a".repeat(64),
        size: 123,
      },
    },
    packageTargets: { "x86_64-pc-windows-msvc": "windows" },
    runtime: "node",
    schemaVersion: 1,
    source: { baseUrl: "https://example.invalid/node" },
    version: "1.0.0",
  };
  const artifact = selectNodeArtifact(lock, "x86_64-pc-windows-msvc");
  assert.equal(artifact.executable, "bundle/node.exe");
  assert.equal(artifact.url, "https://example.invalid/node/node.zip");

  lock.artifacts.windows.sha256 = "invalid";
  assert.throws(
    () => selectNodeArtifact(lock, "x86_64-pc-windows-msvc"),
    /SHA-256/,
  );
});

test("selects a checksum-locked sandbox-enabled rusty_v8 pair", () => {
  const target = "aarch64-apple-darwin";
  const profile = "ptrcomp_sandbox_release";
  const pair = selectV8ArtifactPair({
    artifacts: {
      [target]: {
        archive: {
          name: `librusty_v8_${profile}_${target}.a.gz`,
          sha256: "a".repeat(64),
        },
        binding: {
          name: `src_binding_${profile}_${target}.rs`,
          sha256: "b".repeat(64),
        },
      },
    },
    profile,
    runtime: "rusty-v8",
    schemaVersion: 1,
    source: {
      release: "rusty-v8-v150.4.0",
      repository: "https://github.com/openai/codex",
    },
    version: "150.4.0",
  }, target);

  assert.equal(pair.archive.url, `https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0/${pair.archive.name}`);
  assert.equal(pair.binding.sha256, "b".repeat(64));
});

test("assembles and validates the canonical Windows development layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-package-test-"));
  const staging = join(root, "package");
  const executables = {
    appServerDaemon: join(root, "ash-app-server-daemon.exe"),
    codeModeHost: join(root, "ash-code-mode-host.exe"),
    windowsSandbox: join(root, "ash-windows-sandbox.exe"),
    appServer: join(root, "ash-app-server.exe"),
    remote: join(root, "ash-remote.exe"),
    remoteServer: join(root, "ash-remote-server.exe"),
    execServer: join(root, "ash-exec-server.exe"),
  };
  const ripgrepExecutable = join(root, "rg.exe");
  const nodeExecutable = join(root, "node.exe");
  const nodeLicense = join(root, "node-license");
  const remoteRuntimeBundle = join(root, "remote-runtime-bundle");
  try {
    await mkdir(join(remoteRuntimeBundle, "artifacts"), { recursive: true });
    await Promise.all([
      writeFile(executables.appServerDaemon, "ash-app-server-daemon"),
      writeFile(executables.codeModeHost, "ash-code-mode-host"),
      writeFile(executables.windowsSandbox, "windows-sandbox"),
      writeFile(executables.appServer, "ash-app-server"),
      writeFile(executables.remote, "ash-remote"),
      writeFile(executables.remoteServer, "ash-remote-server"),
      writeFile(executables.execServer, "ash-exec-server"),
      writeFile(ripgrepExecutable, "ripgrep"),
      writeFile(nodeExecutable, "node"),
      writeFile(nodeLicense, "node license"),
      writeFile(join(remoteRuntimeBundle, "artifacts", "ash-linux.tar.gz"), "remote runtime"),
      writeFile(join(remoteRuntimeBundle, "catalog.json"), JSON.stringify({ formatVersion: 1, artifacts: [{ target: "x86_64-unknown-linux-gnu" }] })),
    ]);
    await assemblePackage(
      staging,
      "x86_64-pc-windows-msvc",
      "win32",
      executables,
      {
        archive: "rg.zip",
        archiveSha256: "a".repeat(64),
        binarySha256: "b".repeat(64),
        executable: ripgrepExecutable,
        source: "upstream-release",
        version: "1.0.0",
      },
      {
        archive: "node.zip",
        archiveSha256: "c".repeat(64),
        binarySha256: "d".repeat(64),
        executable: nodeExecutable,
        license: nodeLicense,
        source: "upstream-release",
        version: "24.18.1",
      },
      remoteRuntimeBundle,
    );
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.layoutVersion, 2);
    assert.equal(metadata.buildProfile, "dev-small");
    assert.equal(metadata.files["bin/ash-app-server.exe"], createHash("sha256").update("ash-app-server").digest("hex"));
    assert.deepEqual(metadata.javascriptRuntime, { kind: "packagedNode" });
    assert.equal(metadata.entrypoint, "bin/ash-app-server.exe");
    assert.equal(metadata.target, "x86_64-pc-windows-msvc");
    assert.equal(metadata.components.appServer.binarySha256, createHash("sha256").update("ash-app-server").digest("hex"));
    assert.equal(metadata.components.appServerDaemon.binarySha256, createHash("sha256").update("ash-app-server-daemon").digest("hex"));
    assert.match(metadata.buildId, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(metadata.protocol, {
      major: APP_SERVER_PROTOCOL_MAJOR,
      revision: APP_SERVER_PROTOCOL_REVISION,
      schemaHash: APP_SERVER_SCHEMA_HASH,
    });
    assert.deepEqual(metadata.remoteRuntimeCatalog, {
      path: "ash-remote-runtimes/catalog.json",
      sha256: createHash("sha256").update(await readFile(join(remoteRuntimeBundle, "catalog.json"))).digest("hex"),
      trustBinding: "signedProductPackage",
    });
    assert.equal(await readFile(join(staging, "ash-remote-runtimes", "artifacts", "ash-linux.tar.gz"), "utf8"), "remote runtime");
    assert.equal(await readFile(join(staging, "ash-path", "rg.exe"), "utf8"), "ripgrep");
    assert.equal(await readFile(join(staging, "bin", "ash-app-server-daemon.exe"), "utf8"), "ash-app-server-daemon");
    assert.equal(await readFile(join(staging, "ash-resources", "node", "bin", "node.exe"), "utf8"), "node");
    assert.equal((await readdir(join(staging, "ash-resources"))).includes("ash-command-runner.exe"), false);
    const productServices = JSON.parse(await readFile(join(staging, "ash-resources", "product-services", "product-services.json"), "utf8"));
    const marketplace = productServices.marketplaces.find((source: { name: string }) => source.name === "ash");
    assert.equal(marketplace.metadataBaseUrl, "https://chogng.github.io/marketplace/metadata/");
    assert.equal(marketplace.catalogRefreshIntervalSeconds, 300);
    assert.equal(
      await readFile(join(staging, "ash-resources", "product-services", "marketplace-root.json"), "utf8"),
      await readFile(new URL("../../resources/product-services/marketplace-root.json", import.meta.url), "utf8"),
    );
    const extensionPackages = (await readdir(join(staging, "ash-resources", "extensions"))).sort();
    assert.deepEqual(extensionPackages, ["css", "html", "javascript", "json", "markdown-basics", "python", "rust", "shellscript", "sql", "theme-defaults", "typescript-basics", "xml", "yaml"]);
    assert.match(await readFile(join(staging, "ash-resources", "extensions", "json", "package.json"), "utf8"), /"name": "json"/);
    assert.equal(
      await readFile(join(staging, "ash-resources", "licenses", "vscode", "LICENSE.txt"), "utf8"),
      await readFile(new URL("../../third_party/vscode/LICENSE.txt", import.meta.url), "utf8"),
    );
    const fileTemplates = [];
    for (const packageName of extensionPackages) {
      const extensionRoot = join(staging, "ash-resources", "extensions", packageName);
      const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8")) as {
        readonly contributes?: { readonly snippets?: ReadonlyArray<{ readonly language: string | readonly string[]; readonly path: string }> };
        readonly name: string;
        readonly publisher: string;
      };
      for (const snippetContribution of manifest.contributes?.snippets ?? []) {
        assert.match(snippetContribution.path, /^\.\//);
        const snippetDocument = JSON.parse(await readFile(join(extensionRoot, ...snippetContribution.path.slice(2).split("/")), "utf8")) as Readonly<Record<string, { readonly isFileTemplate?: boolean }>>;
        const languages: readonly string[] = Array.isArray(snippetContribution.language) ? snippetContribution.language : [snippetContribution.language];
        for (const [snippetName, snippet] of Object.entries(snippetDocument)) {
          if (snippet.isFileTemplate === true) {
            fileTemplates.push(...languages.map(language => [`${manifest.publisher}.${manifest.name}`, language, snippetName]));
          }
        }
      }
    }
    fileTemplates.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
    assert.deepEqual(fileTemplates, [
      ["vscode.html", "html", "html doc"],
      ["vscode.javascript", "javascript", "Class Definition"],
      ["vscode.javascript", "javascriptreact", "Class Definition"],
      ["vscode.typescript", "typescript", "Class Definition"],
      ["vscode.typescript", "typescriptreact", "Class Definition"],
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("host-provided runtime package omits the standalone Node payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-host-runtime-test-"));
  const staging = join(root, "package");
  const executables = {
    appServerDaemon: join(root, "ash-app-server-daemon.exe"),
    codeModeHost: join(root, "ash-code-mode-host.exe"),
    windowsSandbox: join(root, "ash-windows-sandbox.exe"),
    appServer: join(root, "ash-app-server.exe"),
    remote: join(root, "ash-remote.exe"),
    remoteServer: join(root, "ash-remote-server.exe"),
    execServer: join(root, "ash-exec-server.exe"),
  };
  const ripgrepExecutable = join(root, "rg.exe");
  try {
    await Promise.all([
      writeFile(executables.appServerDaemon, "ash-app-server-daemon"),
      writeFile(executables.codeModeHost, "ash-code-mode-host"),
      writeFile(executables.windowsSandbox, "windows-sandbox"),
      writeFile(executables.appServer, "ash-app-server"),
      writeFile(executables.remote, "ash-remote"),
      writeFile(executables.remoteServer, "ash-remote-server"),
      writeFile(executables.execServer, "ash-exec-server"),
      writeFile(ripgrepExecutable, "ripgrep"),
    ]);
    await assemblePackage(
      staging,
      "x86_64-pc-windows-msvc",
      "win32",
      executables,
      {
        archive: "rg.zip",
        archiveSha256: "a".repeat(64),
        binarySha256: "b".repeat(64),
        executable: ripgrepExecutable,
        source: "upstream-release",
        version: "1.0.0",
      },
      undefined,
      undefined,
      { url: "https://releases.example/ash/catalog.json", sha256: "e".repeat(64) },
    );
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.layoutVersion, 2);
    assert.equal(metadata.buildProfile, "dev-small");
    assert.deepEqual(metadata.javascriptRuntime, { kind: "hostProvidedNode" });
    assert.equal(metadata.components.node, undefined);
    assert.deepEqual(metadata.remoteRuntimeCatalog, {
      url: "https://releases.example/ash/catalog.json",
      sha256: "e".repeat(64),
      trustBinding: "signedProductPackage",
    });
    await assert.rejects(readFile(join(staging, "ash-resources", "node", "bin", "node.exe")), /ENOENT/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Linux development packages retain Bubblewrap without a Ash namespace helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-linux-network-package-"));
  try {
    const names = ["ash-remote", "ash-remote-server", "ash-exec-server", "ash-app-server", "ash-app-server-daemon", "ash-code-mode-host", "bwrap", "COPYING", "rg"];
    await Promise.all(names.map((name) => writeFile(join(root, name), name)));
    const staging = join(root, "package");
    await assemblePackage(staging, "x86_64-unknown-linux-gnu", "linux", {
      remote: join(root, "ash-remote"), remoteServer: join(root, "ash-remote-server"),
      execServer: join(root, "ash-exec-server"),
      appServer: join(root, "ash-app-server"), appServerDaemon: join(root, "ash-app-server-daemon"),
      codeModeHost: join(root, "ash-code-mode-host"), packageStore: join(root, "unused-store"),
      bubblewrap: { binary: join(root, "bwrap"), license: join(root, "COPYING"), version: "0.11.2", archive: "bwrap.tar", archiveSha256: "a".repeat(64) },
    }, { executable: join(root, "rg"), archive: "rg.tar", archiveSha256: "b".repeat(64), binarySha256: "c".repeat(64), source: "upstream-release", version: "1" }, undefined);
    assert.equal(await readFile(join(staging, "ash-resources", "bwrap"), "utf8"), "bwrap");
    assert.equal((await readdir(join(staging, "ash-resources"))).includes("ash-linux-sandbox"), false);
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.components.linuxSandbox, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects an empty built-in extension source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /source is empty/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an empty built-in extension package directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "demo"), { recursive: true });
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /missing package.json/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a symbolic built-in extension source directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const target = join(root, "source-target");
    const source = join(root, "source");
    await mkdir(target);
    await symlink(target, source, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /source is not a real directory/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a symbolic built-in extension package directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    const extension = join(root, "demo-target");
    await mkdir(source);
    await mkdir(extension);
    await writeFile(join(extension, "package.json"), '{"name":"demo","publisher":"ash","version":"1.0.0"}');
    await symlink(extension, join(source, "demo"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /Invalid built-in extension package/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
