import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const resolvePath = (relativePath: string): string =>
  fileURLToPath(new URL(`../${relativePath}`, import.meta.url));

const read = (relativePath: string): string =>
  readFileSync(resolvePath(relativePath), "utf8");

const publishWorkflowPath = ".github/workflows/publish-image.yml";
const publishWorkflow = read(publishWorkflowPath);
const agentsGuide = read("AGENTS.md");
const readme = read("README.md");
const deploymentGuide = read("docs/application-deployment.md");

const triggerBlock = (workflow: string): string => {
  const match = workflow.match(/^on:([\s\S]*?)^permissions:/m);
  assert.ok(match, "workflow must declare an on: trigger block followed by top-level permissions:");
  return match[1];
};

const publishJob = (workflow: string): string => {
  const start = workflow.indexOf("  publish:");
  assert.ok(start >= 0, "workflow must declare a publish job");
  return workflow.slice(start);
};

test("compiler-specific and runner-specific workflows are replaced by unified workflow", () => {
  assert.equal(existsSync(resolvePath(".github/workflows/publish-compiler.yml")), false);
  assert.equal(existsSync(resolvePath(".github/workflows/publish-runner.yml")), false);
  assert.equal(existsSync(resolvePath(publishWorkflowPath)), true);
});

test("unified publication triggers on push to main and tags as well as workflow_dispatch", () => {
  const triggers = triggerBlock(publishWorkflow);
  assert.match(triggers, /^\s*push:/m);
  assert.match(triggers, /branches:\s*\n\s*-\s*main/m);
  assert.match(triggers, /tags:\s*\n\s*-\s*["']v\*["']/m);
  assert.match(triggers, /workflow_dispatch:/m);
});

test("validation job runs Node 24 checks before publication", () => {
  const beforePublish = publishWorkflow.slice(0, publishWorkflow.indexOf("  publish:"));
  assert.match(beforePublish, /node-version:\s*24\.x/);
  assert.match(beforePublish, /npm ci/);
  assert.match(beforePublish, /npm test/);
  assert.match(beforePublish, /npx tsc --noEmit/);
  assert.match(beforePublish, /npm run lint/);
});

test("publish job builds and publishes both runner and compiler images with multi-platform and provenance", () => {
  const job = publishJob(publishWorkflow);

  // Runner image configuration
  assert.match(job, /images:\s*ghcr\.io\/\${{\s*steps\.image\.outputs\.owner\s*}}\/meeet\b/);
  assert.match(job, /target:\s*runner/);
  assert.match(job, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(job, /cache-from:\s*type=gha,scope=meeet-runner/);
  assert.match(job, /cache-to:\s*type=gha,mode=max,scope=meeet-runner/);

  // Compiler image configuration
  assert.match(job, /images:\s*ghcr\.io\/\${{\s*steps\.image\.outputs\.owner\s*}}\/meeet-artifact-compiler\b/);
  assert.match(job, /target:\s*artifact-compiler/);
  assert.match(job, /cache-from:\s*type=gha,scope=meeet-compiler/);
  assert.match(job, /cache-to:\s*type=gha,mode=max,scope=meeet-compiler/);

  // Shared tags and provenance settings
  const tagMatches = job.match(/type=sha,format=long,prefix=sha-/g);
  assert.ok(tagMatches && tagMatches.length === 2, "both runner and compiler must define sha tags");
  const provenanceMatches = job.match(/provenance:\s*mode=max/g);
  assert.ok(provenanceMatches && provenanceMatches.length === 2, "both runner and compiler must include provenance");

  // Digest summary
  assert.match(job, /MEEET_IMAGE=ghcr\.io\/\${GHCR_OWNER}\/meeet@\${RUNNER_DIGEST}/);
  assert.match(job, /MEEET_COMPILER_IMAGE=ghcr\.io\/\${GHCR_OWNER}\/meeet-artifact-compiler@\${COMPILER_DIGEST}/);
});

test("grants registry write permissions only in the publish job under least privilege", () => {
  assert.match(publishWorkflow, /^permissions:\n  contents:\s*read/m);
  const beforePublish = publishWorkflow.slice(0, publishWorkflow.indexOf("  publish:"));
  assert.doesNotMatch(beforePublish, /packages:\s*write/);
  assert.match(publishJob(publishWorkflow), /packages:\s*write/);
  assert.doesNotMatch(publishWorkflow, /id-token:\s*write/);
  assert.doesNotMatch(publishWorkflow, /attestations:\s*write/);
});

test("publish workflow cannot deploy or reference tunnel secrets", () => {
  const forbidden = [/cloudflared/, /TUNNEL_TOKEN/, /\bUNRAID\b/];
  for (const pattern of forbidden) {
    assert.doesNotMatch(publishWorkflow, pattern, `publish workflow must not reference ${pattern}`);
  }
});

test("documentation does not contain manual compiler dispatch instructions", () => {
  const dispatchPattern = /gh workflow run publish-compiler\.yml/;
  for (const doc of [agentsGuide, readme, deploymentGuide]) {
    assert.doesNotMatch(doc, dispatchPattern);
    assert.doesNotMatch(doc, /publish-runner\.yml/);
  }
});
