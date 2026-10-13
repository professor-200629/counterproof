/**
 * The /api rewrite in next.config.ts is an external rewrite: Next's router server hands it to
 * proxyRequest (node_modules/next/dist/server/lib/router-utils/proxy-request.js, called from
 * router-server.js for any rewrite whose destination has a protocol), an httpxy proxy with
 * changeOrigin. The judge session depends on what it forwards, so this drives that exact
 * function between two local servers:
 *   - the browser's Cookie, Origin and X-CSRF-Token reach the backend unchanged;
 *   - the backend's Set-Cookie (HttpOnly, SameSite=Strict, Path=/api) reaches the browser
 *     unchanged (no cookieDomainRewrite / cookiePathRewrite is configured);
 *   - Host is rewritten to the backend and the browser's Host travels as X-Forwarded-Host,
 *     which the backend checks against its allowed hosts (DNS rebinding).
 * Docs: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/rewrites.md
 * ("Rewrites act as a URL proxy", "Rewriting to an external URL").
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { parse } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { proxyRequest } = require("next/dist/server/lib/router-utils/proxy-request.js") as {
  proxyRequest: (req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: unknown, upgradeHead?: unknown, body?: unknown, timeout?: number) => Promise<unknown>;
};

let backend: http.Server;
let front: http.Server;
let frontPort = 0;
let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | null = null;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.setHeader("Set-Cookie", "cp_session=new-session-id; HttpOnly; Max-Age=28800; Path=/api; SameSite=strict");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const backendPort = await listen(backend);
  // The same call router-server.js makes for an external rewrite destination.
  front = http.createServer((req, res) => {
    void proxyRequest(req, res, parse(`http://127.0.0.1:${backendPort}${req.url}`, true), undefined, undefined, 5000);
  });
  frontPort = await listen(front);
});

afterAll(() => {
  front?.close();
  backend?.close();
});

function request(path: string, headers: Record<string, string>, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: frontPort, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the /api rewrite proxy", () => {
  it("forwards Cookie, Origin and X-CSRF-Token, and returns Set-Cookie unchanged", async () => {
    const res = await request(
      "/api/runs/run_1/cancel",
      {
        Host: "localhost:3000",
        Cookie: "cp_session=browser-session-id",
        Origin: "http://localhost:3000",
        "X-CSRF-Token": "csrf-abc",
        "Content-Type": "application/json",
      },
      "{}",
    );
    expect(res.status).toBe(200);
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/api/runs/run_1/cancel");
    expect(seen?.headers.cookie).toBe("cp_session=browser-session-id");
    expect(seen?.headers.origin).toBe("http://localhost:3000");
    expect(seen?.headers["x-csrf-token"]).toBe("csrf-abc");
    expect(seen?.body).toBe("{}");
    expect(seen?.headers.host).toMatch(/^127\.0\.0\.1:\d+$/); // changeOrigin
    expect(seen?.headers["x-forwarded-host"]).toBe("localhost:3000");
    expect(res.headers["set-cookie"]).toEqual(["cp_session=new-session-id; HttpOnly; Max-Age=28800; Path=/api; SameSite=strict"]);
  });

  it("puts a rebinding page's Host into X-Forwarded-Host for the backend to refuse", async () => {
    await request("/api/health", { Host: "rebound.attacker.example:3000" }, "");
    expect(seen?.headers["x-forwarded-host"]).toBe("rebound.attacker.example:3000");
  });
});
