/**
 * openapi.test.ts
 *
 * Issue #61: a machine-readable spec, served at `/api/docs`, derived from the
 * routes' own schemas.
 *
 * The coverage test walks the routers' `stack` rather than a hand-written list,
 * so a route added to `routes/*.ts` without a `registerPath` entry in
 * `openapi.ts` fails CI instead of silently dropping out of the spec.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express, Router } from "express";
import type { Server } from "node:http";

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { createApp } = await import("../app");
  const app = await createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Every `METHOD /path` a router serves, with `:param` rewritten to the
 * `{param}` form OpenAPI uses.
 */
function routerRoutes(router: Router, mount: string): string[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) => {
      const route = layer.route!;
      const full = route.path === "/" ? mount : `${mount}${route.path}`;
      const normalized = full.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      return Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => `${method.toUpperCase()} ${normalized}`);
    });
}

async function allRouterRoutes(): Promise<string[]> {
  const { usersRouter } = await import("../routes/users");
  const { jobsRouter } = await import("../routes/jobs");
  const { escrowRouter } = await import("../routes/escrow");
  const { disputesRouter } = await import("../routes/disputes");
  const { reputationRouter } = await import("../routes/reputation");
  const { webhooksRouter } = await import("../routes/webhooks");

  return [
    ...routerRoutes(usersRouter, "/api/users"),
    ...routerRoutes(jobsRouter, "/api/jobs"),
    ...routerRoutes(escrowRouter, "/api/escrow"),
    ...routerRoutes(disputesRouter, "/api/disputes"),
    ...routerRoutes(reputationRouter, "/api/reputation"),
    ...routerRoutes(webhooksRouter, "/api/webhooks"),
  ];
}

describe("OpenAPI document", () => {
  it("is served as JSON at /api/docs/openapi.json", async () => {
    const res = await fetch(`${baseUrl}/api/docs/openapi.json`);

    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.title).toMatch(/Stellar Freelance/);
    // Bearer auth is declared, since most routes need it.
    expect(doc.components.securitySchemes.bearerAuth).toBeTruthy();
  });

  it("covers every route the routers register", async () => {
    const { openApiDocument } = await import("../openapi");
    const documented = new Set(
      Object.entries(openApiDocument.paths).flatMap(([path, operations]) =>
        Object.keys(operations as Record<string, unknown>).map(
          (method) => `${method.toUpperCase()} ${path}`,
        ),
      ),
    );

    const missing = (await allRouterRoutes()).filter((route) => !documented.has(route));
    expect(missing).toEqual([]);
    // Plus the liveness and readiness probes, which are registered on the app rather than a router.
    expect(documented.has("GET /health")).toBe(true);
    expect(documented.has("GET /ready")).toBe(true);
  });

  it("derives a request body from the route's Zod schema", async () => {
    const { openApiDocument } = await import("../openapi");
    const body = openApiDocument.paths["/api/jobs"].post!.requestBody as {
      content: { "application/json": { schema: Record<string, unknown> } };
    };
    const schema = body.content["application/json"].schema as {
      properties: Record<string, any>;
      required: string[];
    };

    // Straight from `createJobSchema`: the same object `validate()` enforces.
    expect(schema.required).toEqual(["title", "description", "milestones"]);
    expect(schema.properties.asset.default).toBe("USDC");
    expect(schema.properties.milestones.minItems).toBe(1);
    // `amount` is a union of a positive number and an exact decimal string.
    expect(schema.properties.milestones.items.properties.amount.anyOf).toHaveLength(2);
  });

  it("serves the Swagger UI explorer at /api/docs", async () => {
    const res = await fetch(`${baseUrl}/api/docs/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/swagger/i);
  });

  it("is not mounted in production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    // Production refuses to start with an empty CORS allowlist; supply one so
    // this test observes the docs gate rather than config validation.
    vi.stubEnv("CORS_ORIGIN", "https://app.example.com");

    const { createApp } = (await import("../app")) as { createApp: () => Promise<Express> };
    const app = await createApp();
    const prodServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = prodServer.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/docs/openapi.json`);
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        prodServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("is mounted in production when ENABLE_API_DOCS is true (issue #263)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://app.example.com");
    vi.stubEnv("ENABLE_API_DOCS", "true");

    const { createApp } = (await import("../app")) as { createApp: () => Promise<Express> };
    const app = await createApp();
    const stagingServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = stagingServer.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/docs/openapi.json`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { openapi: string };
      expect(json.openapi).toMatch(/^3\./);
    } finally {
      await new Promise<void>((resolve, reject) =>
        stagingServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
