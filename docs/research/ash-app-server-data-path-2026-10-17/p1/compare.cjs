// Run from the repository root with Node --expose-gc. This compares source-extracted
// transport methods, not Electron IPC, JSON.parse, schema validation or painting.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");

assert.equal(typeof global.gc, "function", "Run Node with --expose-gc");
const root = process.cwd();
const baseline = JSON.parse(
  fs.readFileSync(path.join(__dirname, "baseline-source.json"), "utf8"),
);
const output = path.join(
  root,
  ".build/investigations/app-server-p1-2026-10-17",
);
fs.mkdirSync(output, { recursive: true });
const hashes = {};

function read(name) {
  const source = fs.readFileSync(path.join(root, name), "utf8");
  hashes[name] = crypto.createHash("sha256").update(source).digest("hex");
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

function declaration(ast, name) {
  return ast.statements
    .find((node) => node.name?.getText(ast) === name)
    .getText(ast);
}

function compile(name, source, environment = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const module = { exports: {} };
  new Function(...Object.keys(environment), "module", "exports", code)(
    ...Object.values(environment),
    module,
    module.exports,
  );
  return module.exports[name];
}

const bufferSource = read("src/ash/base/common/buffer.ts");
const VSBuffer = compile(
  "VSBuffer",
  `let textEncoder, textDecoder;\n${declaration(bufferSource, "VSBuffer")}`,
);
const frameSource = read(
  "src/ash/platform/agentHost/common/appServerTransport.ts",
);
const AppServerFrame = compile(
  "AppServerFrame",
  declaration(frameSource, "AppServerFrame"),
);
const socketSource = read(baseline.appServerSocketTransport.path);
const socketClass = socketSource.statements.find(
  (node) => node.name?.getText(socketSource) === "AppServerSocketTransport",
);
const afterMethods = socketClass.members
  .filter((node) =>
    ["acceptData", "append", "acceptFrame"].includes(
      node.name?.getText(socketSource),
    ),
  )
  .map((node) => node.getText(socketSource));
const protocolSource = read(baseline.appServerProtocolClient.path);
const environment = {
  VSBuffer,
  AppServerFrame,
  framePageBytes: 65536,
  maxFrameBytes: 320 * 1048576,
  MAX_FRAME_BYTES: 320 * 1048576,
  WEB_APP_SERVER_FRAME_EVENT: "frame",
  WEB_APP_SERVER_CLOSED_EVENT: "closed",
  isRecord: (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
};

function framer(methods) {
  return compile(
    "Framer",
    `export class Framer {
    parts = []; bufferedBytes = 0; socket = {}; payload = undefined;
    emit(event, payload) { assert.equal(event, 'frame'); this.payload = payload; }
    disconnect() { this.socket = undefined; }
    ${methods.join("\n")}
  }`,
    { ...environment, assert },
  );
}

const versions = {
  before: {
    Framer: framer(baseline.appServerSocketTransport.methods),
    check: compile(
      "check",
      `${baseline.appServerProtocolClient.validateFramePayload}\nmodule.exports.check = validateFramePayload;`,
      environment,
    ),
  },
  after: {
    Framer: framer(afterMethods),
    check: compile(
      "check",
      `${declaration(protocolSource, "validateFramePayload")}\nmodule.exports.check = validateFramePayload;`,
      environment,
    ),
  },
};

function receive(Framer, input, packetBytes, expected) {
  const receiver = new Framer();
  let totalMs = 0;
  let maxCallbackMs = 0;
  const cpu = process.cpuUsage();
  for (let offset = 0; offset < input.length; offset += packetBytes) {
    const packet = VSBuffer.wrap(input.subarray(offset, offset + packetBytes));
    const started = performance.now();
    receiver.acceptData(packet);
    const elapsed = performance.now() - started;
    totalMs += elapsed;
    maxCallbackMs = Math.max(maxCallbackMs, elapsed);
  }
  const used = process.cpuUsage(cpu);
  assert.equal(receiver.payload.frame, expected);
  assert.equal(receiver.bufferedBytes, 0);
  return { totalMs, maxCallbackMs, cpuMs: (used.user + used.system) / 1000 };
}

function countCopies(run) {
  let copiedBytes = 0;
  const originalSet = Uint8Array.prototype.set;
  const originalSlice = Uint8Array.prototype.slice;
  Uint8Array.prototype.set = function (source, offset) {
    copiedBytes += source.length;
    return originalSet.call(this, source, offset);
  };
  Uint8Array.prototype.slice = function (start, end) {
    const result = originalSlice.call(this, start, end);
    copiedBytes += result.byteLength;
    return result;
  };
  try {
    run();
  } finally {
    Uint8Array.prototype.set = originalSet;
    Uint8Array.prototype.slice = originalSlice;
  }
  return copiedBytes;
}

function median(samples, key) {
  return +samples
    .map((sample) => sample[key])
    .sort((a, b) => a - b)
    [Math.floor(samples.length / 2)].toFixed(3);
}

const results = [];
const cases = [4, 16, 64].flatMap((miB) =>
  [8192, 65536].map((packetBytes) => ({ miB, packetBytes })),
);
cases.push({ miB: 4, packetBytes: Number.MAX_SAFE_INTEGER });
cases.push({ miB: 4, packetBytes: 8192, unicode: true });

for (const scenario of cases) {
  const text = scenario.unicode
    ? "你好😀".repeat(Math.floor((scenario.miB * 1048576) / 10))
    : "x".repeat(scenario.miB * 1048576);
  const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text } });
  const input = new TextEncoder().encode(frame + "\n");
  const samples = { before: [], after: [] };
  for (const version of Object.values(versions)) {
    receive(version.Framer, input, scenario.packetBytes, frame);
  }
  // Alternate order each round; GC and correctness checks are outside timed callbacks.
  for (let round = 0; round < 5; round++) {
    for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
      global.gc();
      samples[name].push(
        receive(versions[name].Framer, input, scenario.packetBytes, frame),
      );
    }
  }
  const record = {
    stage: "framing",
    wireBytes: input.length - 1,
    ...scenario,
    versions: {},
  };
  for (const name of ["before", "after"]) {
    global.gc();
    const copiedBytes = countCopies(() =>
      receive(versions[name].Framer, input, scenario.packetBytes, frame),
    );
    record.versions[name] = {
      medianMs: median(samples[name], "totalMs"),
      medianMaxCallbackMs: median(samples[name], "maxCallbackMs"),
      medianCpuMs: median(samples[name], "cpuMs"),
      copiedBytes,
      copyAmplification: +(copiedBytes / (input.length - 1)).toFixed(3),
      samples: samples[name],
    };
  }
  results.push(record);
  console.log(
    JSON.stringify({
      ...scenario,
      before: record.versions.before.medianMs,
      after: record.versions.after.medianMs,
      copies: [
        record.versions.before.copyAmplification,
        record.versions.after.copyAmplification,
      ],
    }),
  );
}

const frame = JSON.stringify({ result: "x".repeat(64 * 1048576) });
const byteLength = new TextEncoder().encode(frame).byteLength;
const samples = { before: [], after: [] };
for (let round = 0; round < 5; round++) {
  for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
    global.gc();
    const payload =
      name === "after" ? new AppServerFrame(frame, byteLength) : { frame };
    const start = performance.now();
    const checked = versions[name].check(payload);
    samples[name].push({ totalMs: performance.now() - start });
    assert.equal(checked.byteLength, byteLength);
  }
}
results.push({
  stage: "wire-length-check",
  wireBytes: byteLength,
  samples,
  beforeMs: median(samples.before, "totalMs"),
  afterMs: median(samples.after, "totalMs"),
});

const report = {
  node: process.version,
  v8: process.versions.v8,
  cpu: os.cpus()[0].model,
  platform: process.platform,
  arch: process.arch,
  scope:
    "Source-extracted production transport methods and VSBuffer. No Electron IPC or UI latency claims. Copy counters run separately from timings.",
  baselineHashes: Object.fromEntries(
    Object.entries(baseline).map(([name, value]) => [name, value.sha256]),
  ),
  currentHashes: hashes,
  results,
};
fs.writeFileSync(
  path.join(output, "comparison-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
