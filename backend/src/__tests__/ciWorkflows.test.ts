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
    const offenders: string[] = [];

    for (const { name, lines } of workflows()) {
      for (const block of permissionBlocks(lines)) {
        for (const entry of block.entries) {
          if (/:\s*write\s*$/.test(entry.text)) {
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
