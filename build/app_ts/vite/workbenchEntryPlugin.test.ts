import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { Connect } from "vite";

import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";

test("Workbench entry redirects root requests to the shared Workbench", () => {
  const middleware = configuredMiddleware();
  const result = invoke(middleware, { method: "GET", url: "/?theme=dark" });
  assert.deepEqual(result, {
    ended: true,
    headers: {
      "Cache-Control": "no-store",
      Location: "/browser/workbench/workbench.html?theme=dark",
    },
    nextCalled: false,
    statusCode: 302,
  });
});

test("Workbench entry leaves non-root and mutating requests to Vite", () => {
  const middleware = configuredMiddleware();
  for (const request of [
    { method: "GET", url: "/browser/workbench/workbench.html" },
    { method: "POST", url: "/" },
  ]) {
    assert.deepEqual(invoke(middleware, request), {
      ended: false,
      headers: {},
      nextCalled: true,
      statusCode: undefined,
    });
  }
});

test('Sessions development opens its page directly and preserves workspace parameters', () => {
  const middleware = configuredMiddleware('/browser/sessions/sessions-code.html');
  assert.equal(invoke(middleware, { method: 'HEAD', url: '/?folder=project' }).headers.Location, '/browser/sessions/sessions-code.html?folder=project');
});

function configuredMiddleware(entryPath?: string): Connect.NextHandleFunction {
  let middleware: Connect.NextHandleFunction | undefined;
  workbenchEntryPlugin(entryPath).configureServer({
    middlewares: {
      use(candidate) {
        middleware = candidate;
      },
    },
  });
  assert.ok(middleware);
  return middleware;
}

function invoke(middleware: Connect.NextHandleFunction, request: { readonly method: string; readonly url: string }) {
  const headers: Record<string, string | readonly string[] | number> = {};
  let ended = false;
  let nextCalled = false;
  const response = {
    statusCode: undefined as number | undefined,
    setHeader(name: string, value: string | readonly string[] | number) {
      headers[name] = value;
      return response;
    },
    end() {
      ended = true;
      return response;
    },
  };
  middleware(request as IncomingMessage, response as unknown as ServerResponse, () => {
    nextCalled = true;
  });
  return { ended, headers, nextCalled, statusCode: response.statusCode };
}
