import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `VITE_*` value the frontend reads must be settable on the container
 * image (issue #51).
 *
 * `frontend/Dockerfile` builds a static bundle, so Vite resolves
 * `import.meta.env.VITE_*` at build time and the *only* way to point a running
 * container at a non-local backend or a different contract set is to pass it as
 * a build arg. The Dockerfile had args for the escrow/dispute/reputation/USDC
 * contract ids but not for `VITE_API_URL` (frontend/src/lib/api.ts) or
 * `VITE_XLM_CONTRACT_ID` (frontend/src/lib/assets.ts), so a containerised
 * frontend silently fell back to `http://localhost:3000` and could not offer
 * XLM — while `docker-compose.yml` forwarded neither.
 *
 * Reading the files compose actually consumes means dropping an `ARG` or a
 * compose key fails here instead of shipping a misconfigured image.
 */

/** Read a file from the repo root regardless of whether cwd is repo or backend. */
function repoFile(...segments: string[]): string {
  const cwd = process.cwd();
  const root = [cwd, path.resolve(cwd, "..")].find((dir) =>
    existsSync(path.join(dir, "docker-compose.yml")),
  );
  if (!root) throw new Error(`repo root not found from ${cwd}`);
  return readFileSync(path.join(root, ...segments), "utf8").replace(/\r/g, "");
}

/** `ARG VITE_…` names declared in the frontend Dockerfile. */
function dockerfileViteArgs(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^ARG (VITE_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
}

/** `VITE_…` keys under the `frontend` service's `build.args` in compose. */
function composeFrontendArgs(compose: string): string[] {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => /^ {2}frontend:\s*$/.test(line));
  expect(start, "docker-compose.yml has no `frontend:` service").toBeGreaterThanOrEqual(0);

  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // A line indented two spaces starts the next top-level key/service.
    if (/^ {2}\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return [...block.join("\n").matchAll(/^ {8}(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]);
}

describe("frontend/Dockerfile build args", () => {
  it("declares the API URL and XLM contract id alongside the other contract ids", () => {
    const declared = dockerfileViteArgs(repoFile("frontend", "Dockerfile"));

    expect(declared).toContain("VITE_API_URL");
    expect(declared).toContain("VITE_XLM_CONTRACT_ID");
  });

  it("exports every declared arg into the build environment", () => {
    const dockerfile = repoFile("frontend", "Dockerfile");
    const env = /^ENV ([\s\S]*?)\n\n/m.exec(dockerfile)?.[1] ?? "";

    for (const arg of dockerfileViteArgs(dockerfile)) {
      expect(env, `${arg} is declared but never reaches \`npm run build\``).toContain(arg);
    }
  });
});

describe("docker-compose.yml frontend build args", () => {
  it("forwards exactly the args the Dockerfile declares", () => {
    const declared = dockerfileViteArgs(repoFile("frontend", "Dockerfile")).sort();
    const forwarded = composeFrontendArgs(repoFile("docker-compose.yml")).sort();

    expect(forwarded).toEqual(declared);
  });

  it("forwards VITE_API_URL and VITE_XLM_CONTRACT_ID", () => {
    const forwarded = composeFrontendArgs(repoFile("docker-compose.yml"));

    expect(forwarded).toContain("VITE_API_URL");
    expect(forwarded).toContain("VITE_XLM_CONTRACT_ID");
  });
});
