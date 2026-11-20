import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI supply-chain hardening (issue #111): every GitHub Action is referenced by
 * an immutable commit SHA, and the workflow's GITHUB_TOKEN is scoped to what
 * the jobs actually use (`contents: read`).
 *
 * These tests read the exact files GitHub Actions executes, so re-pointing a
 * tag (`@v4`), switching back to a branch (`@stable`) or dropping the
 * `permissions:` block fails the suite before the workflow can run unreviewed
 * code with the repository's token. The conventions themselves live in
 * CONTRIBUTING.md → CI workflows.
 */

interface Workflow {
  name: string;
  lines: string[];
}

/** Read `.github/workflows/*` regardless of whether cwd is repo root or backend. */
function workflows(): Workflow[] {
  const cwd = process.cwd();
  const root = [cwd, path.resolve(cwd, "..")].find((dir) =>
    existsSync(path.join(dir, ".github", "workflows")),
  );
  if (!root) throw new Error(`repo root not found from ${cwd}`);
  const dir = path.join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => ({
      name: file,
      lines: readFileSync(path.join(dir, file), "utf8").split(/\r?\n/),
    }));
}

interface PermissionBlock {
  line: number; // 1-based
  entries: { line: number; text: string }[];
}

/** Every `permissions:` block (workflow-level or job-level) with its child entries. */
function permissionBlocks(lines: string[]): PermissionBlock[] {
  const blocks: PermissionBlock[] = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)permissions:(.*)$/.exec(line);
    if (!match) return;
    const indent = match[1].length;
    const entries: { line: number; text: string }[] = [];

    const inline = match[2].trim();
    if (inline && !inline.startsWith("#")) {
      entries.push({ line: index + 1, text: inline.replace(/^\{\s*|\s*\}$/g, "") });
    }
    for (let j = index + 1; j < lines.length; j++) {
      const child = lines[j];
      if (!child.trim() || /^\s*#/.test(child)) continue;
      const childIndent = child.length - child.trimStart().length;
      if (childIndent <= indent) break;
      entries.push({ line: j + 1, text: child.trim() });
    }
    blocks.push({ line: index + 1, entries });
  });
  return blocks;
}

describe("GitHub Actions pinning (issue #111)", () => {
  it("pins every `uses:` to a full commit SHA with the version in a trailing comment", () => {
    const offenders: string[] = [];

    for (const { name, lines } of workflows()) {
      lines.forEach((line, index) => {
        const match = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!match) return;
        const [, spec, rest] = match;
        const where = `${name}:${index + 1}`;

        // Local composite actions run straight from this checkout; docker
        // images must be pinned to a digest to be immutable.
        if (spec.startsWith("./")) return;
        if (spec.startsWith("docker://")) {
          if (!/@sha256:[0-9a-f]{64}$/.test(spec)) {
            offenders.push(`${where} ${spec} — docker actions must be pinned to a sha256 digest`);
          }
          return;
        }

        const at = spec.lastIndexOf("@");
        const ref = at === -1 ? "" : spec.slice(at + 1);
        if (!/^[0-9a-f]{40}$/.test(ref)) {
          offenders.push(
            `${where} ${spec} — mutable ref "@${ref || "(none)"}"; pin to the full 40-char commit SHA and keep the version in a trailing comment`,
          );
        } else if (!/#\s*\S/.test(rest)) {
          offenders.push(
            `${where} ${spec} — pinned SHA needs the version in a trailing comment, e.g. "${spec.split("@")[0]}@${ref} # v4.4.0"`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("Docker layer cache (issue #289)", () => {
  it("builds both images with buildx and the GitHub Actions cache", () => {
    const ci = workflows().find((workflow) => workflow.name === "ci.yml");
    if (!ci) throw new Error("ci.yml not found");
    const text = ci.lines.join("\n");

    // buildx is what makes `cache-to: type=gha` work; the default builder
    // cannot export to the Actions cache backend.
    expect(text).toMatch(/uses:\s*docker\/setup-buildx-action@[0-9a-f]{40}\s+#/);
    expect(text.match(/uses:\s*docker\/build-push-action@[0-9a-f]{40}\s+#/g)).toHaveLength(2);

    // One cache scope per image: shared scopes would make the backend and
    // frontend evict each other's layers.
    const scopes = (pattern: RegExp) =>
      [...text.matchAll(pattern)].map((match) => match[1]).sort();
    expect(scopes(/cache-from:\s*type=gha,scope=([a-z]+)/g)).toEqual([
      "backend",
      "frontend",
    ]);
    // `mode=max` caches intermediate layers too — without it only the final
    // image is reused and `npm ci` is rebuilt on every run.
    expect(scopes(/cache-to:\s*type=gha,mode=max,scope=([a-z]+)/g)).toEqual([
      "backend",
      "frontend",
    ]);
  });
});

describe("workflow token scope (issue #111)", () => {
  it("declares a workflow-level `permissions:` block granting `contents: read` in every workflow", () => {
    const offenders: string[] = [];

    for (const { name, lines } of workflows()) {
      const topLevel = permissionBlocks(lines).filter(
        (block) => block.line === 1 || !/^\s/.test(lines[block.line - 1]),
      );
      if (!topLevel.length) {
        offenders.push(
          `${name}: no top-level \`permissions:\` block — the token falls back to the repository's default scope`,
        );
      } else if (
        !topLevel.some((block) =>
          block.entries.some((entry) => /^contents:\s*read(\s|$)/.test(entry.text)),
        )
      ) {
        offenders.push(`${name}: top-level \`permissions:\` must grant \`contents: read\``);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("restates `contents: read` in every permissions block", () => {
    // A job-level `permissions:` key *replaces* the workflow-level block, so a
    // job that forgets `contents: read` breaks its own checkout.
    const offenders: string[] = [];

    for (const { name, lines } of workflows()) {
      for (const block of permissionBlocks(lines)) {
        if (
          !block.entries.some((entry) => /^contents:\s*read(\s|$)/.test(entry.text))
        ) {
          offenders.push(
            `${name}:${block.line} permissions block omits \`contents: read\` — job-level blocks replace the workflow-level one`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never grants a write scope", () => {
    // Every job in this workflow only checks out, builds and tests (see issue
    // #111). If a step ever genuinely needs write access, grant it in that
    // job's block, justify it there, and update this assertion.
    //
    // One exception is justified: the PR safety check publishes its verdict as
    // a commit status, so a crash or cancellation leaves a pending status
    // instead of a silently missing one. It runs on `pull_request_target` and
    // never checks out PR code.
    const allowedWrites: Record<string, string[]> = {
      "pr-safety-check.yml": ["statuses: write"],
    };
    const offenders: string[] = [];

    for (const { name, lines } of workflows()) {
      for (const block of permissionBlocks(lines)) {
        for (const entry of block.entries) {
          if (
            /:\s*write\s*$/.test(entry.text) &&
            !(allowedWrites[name] ?? []).includes(entry.text)
          ) {
            offenders.push(
              `${name}:${entry.line} grants \`${entry.text}\` — CI here is read-only`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
