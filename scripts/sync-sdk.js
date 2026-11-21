#!/usr/bin/env node

/**
 * sync-sdk.js
 *
 * Ensures that the SDK source files in packages/sdk/src/ are synchronized
 * across the backend and frontend lib/sdk directories for local development
 * and standalone Docker builds.
 */

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const sdkSrcDir = path.join(rootDir, "packages", "sdk", "src");
const backendSdkDir = path.join(rootDir, "backend", "src", "lib", "sdk");
const frontendSdkDir = path.join(rootDir, "frontend", "src", "lib", "sdk");

const filesToSync = ["types.ts", "scval.ts", "builders.ts", "errors.ts", "client.ts", "index.ts"];

for (const destDir of [backendSdkDir, frontendSdkDir]) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  for (const file of filesToSync) {
    const src = path.join(sdkSrcDir, file);
    const dest = path.join(destDir, file);
    if (fs.existsSync(src)) {
      const content = fs.readFileSync(src, "utf8");
      fs.writeFileSync(dest, content, "utf8");
    }
  }
}

console.log("SDK files synchronized successfully to backend and frontend workspaces.");
