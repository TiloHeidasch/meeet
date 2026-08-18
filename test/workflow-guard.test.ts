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

test("unified publication triggers on push to main, dev, and feature branches as well as tags and workflow_dispatch", () => {
  const triggers = triggerBlock(publishWorkflow);
  assert.match(triggers, /^\s*push:/m);
  assert.match(triggers, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev/m);
  assert.match(triggers, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev\s*\n\s*-\s*["']feature\/\*\*["']/m);
  assert.match(triggers, /tags:\s*\n\s*-\s*["']v\*["']/m);
  assert.match(triggers, /workflow_dispatch:/m);
});

test("validation job runs Node 24 checks before publication", () => {
  const validateWorkflow = read(".github/workflows/validate.yml");
  assert.match(validateWorkflow, /node-version:\s*24\.x/);
  assert.match(validateWorkflow, /npm ci/);
  assert.match(validateWorkflow, /npm test/);
  assert.match(validateWorkflow, /npx tsc --noEmit/);
  assert.match(validateWorkflow, /npm run lint/);

  // Both callers reuse the shared workflow and preserve their job names.
  const beforePublish = publishWorkflow.slice(0, publishWorkflow.indexOf("  publish:"));
  assert.match(beforePublish, /uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.match(beforePublish, /name:\s*Validate on Node 24/);
  const ciWorkflow = read(".github/workflows/ci.yml");
  assert.match(ciWorkflow, /uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.match(ciWorkflow, /name:\s*Validate Node 24 \(merge result\)/);
});

test("publish job builds and publishes both runner and compiler images with multi-platform and provenance", () => {
  const job = publishJob(publishWorkflow);

  // Runner image configuration
  assert.match(job, /images:\s*ghcr\.io\/\${{\s*steps\.owner\.outputs\.owner\s*}}\/meeet\b/);
  assert.match(job, /target:\s*runner/);
  assert.match(job, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(job, /cache-from:\s*type=gha,scope=meeet-runner/);
  assert.match(job, /cache-to:\s*type=gha,mode=max,scope=meeet-runner/);

  // Compiler image configuration
  assert.match(job, /images:\s*ghcr\.io\/\${{\s*steps\.owner\.outputs\.owner\s*}}\/meeet-artifact-compiler\b/);
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

test("compiler is published only on main pushes and release tags", () => {
  const job = publishJob(publishWorkflow);
  const compilerGuard =
    "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')";
  const guardMatches = job.match(new RegExp(compilerGuard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
  assert.ok(
    guardMatches && guardMatches.length === 2,
    "compiler metadata and compiler build steps must both carry the main/tag guard",
  );

  // The runner build step must not be gated.
  const runnerSection = job.slice(
    job.indexOf("Build and publish runner"),
    job.indexOf("Extract compiler image metadata"),
  );
  assert.doesNotMatch(runnerSection, /^\s*if:/m);
});

test("tags are produced by docker/metadata-action without raw ref interpolation", () => {
  const metadataMatches = publishWorkflow.match(/uses:\s*docker\/metadata-action/g);
  assert.ok(
    metadataMatches && metadataMatches.length === 2,
    "both runner and compiler must use docker/metadata-action",
  );
  assert.match(publishWorkflow, /type=sha,format=long,prefix=sha-/);
  assert.match(publishWorkflow, /type=ref,event=branch/);
  assert.match(publishWorkflow, /type=ref,event=tag/);
  assert.doesNotMatch(publishWorkflow, /\$\{\{\s*github\.ref(?:_name)?\s*\}\}/);
});

test("runner and compiler images carry SBOM attestation and OCI revision labels", () => {
  const sbomMatches = publishWorkflow.match(/sbom:\s*true/g);
  assert.ok(
    sbomMatches && sbomMatches.length === 2,
    "both runner and compiler builds must emit an SBOM attestation",
  );
  assert.match(publishWorkflow, /labels:\s*\$\{\{\s*steps\.meta_runner\.outputs\.labels\s*\}\}/);
  assert.match(publishWorkflow, /labels:\s*\$\{\{\s*steps\.meta_compiler\.outputs\.labels\s*\}\}/);
});

test("PR CI validates the merge result with least privilege", () => {
  const ciWorkflow = read(".github/workflows/ci.yml");
  const ciTriggers = triggerBlock(ciWorkflow);
  assert.match(ciTriggers, /^\s*pull_request:/m);
  assert.match(ciTriggers, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev/m);
  assert.doesNotMatch(ciWorkflow, /pull_request_target/);
  assert.match(ciWorkflow, /^permissions:\n  contents:\s*read/m);
  assert.doesNotMatch(ciWorkflow, /packages:\s*write/);
  assert.doesNotMatch(ciWorkflow, /id-token:/);
  assert.doesNotMatch(ciWorkflow, /attestations:/);
  assert.doesNotMatch(ciWorkflow, /secrets\./);
  assert.match(ciWorkflow, /uses:\s*\.\/\.github\/workflows\/validate\.yml/);
  assert.match(ciWorkflow, /name:\s*Validate Node 24 \(merge result\)/);

  // The shared validation workflow itself stays least privilege.
  const validateWorkflow = read(".github/workflows/validate.yml");
  assert.match(validateWorkflow, /^permissions:\n  contents:\s*read/m);
  assert.doesNotMatch(validateWorkflow, /secrets\./);
  assert.doesNotMatch(validateWorkflow, /packages:/);
  assert.doesNotMatch(validateWorkflow, /id-token:/);
  assert.doesNotMatch(validateWorkflow, /attestations:/);
});

test("branch protection check context is pinned by the guard tests", () => {
  // The required check context on dev/main is "<caller job name> / <reusable
  // job id>", i.e. "Validate Node 24 (merge result) / validate"; renaming
  // either breaks the merge gate.
  const validateWorkflow = read(".github/workflows/validate.yml");
  assert.match(validateWorkflow, /^jobs:\n  validate:/m);
  const ciWorkflow = read(".github/workflows/ci.yml");
  assert.match(ciWorkflow, /name:\s*Validate Node 24 \(merge result\)/);
});

test("PR CI includes an e2e gate that builds, starts meeet, and runs a functional calculation", () => {
  const ciWorkflow = read(".github/workflows/ci.yml");
  assert.match(ciWorkflow, /name:\s*E2E build, spin up, calculate/);
  assert.match(ciWorkflow, /npm run build/);
  assert.match(ciWorkflow, /schedule:compile:fixture/);
  assert.match(ciWorkflow, /MEEET_SCHEDULE_ARTIFACT_PATH:\s*\/tmp\/mvv-scheduled-artifact\.json/);
  assert.match(ciWorkflow, /npm start/);
  assert.match(ciWorkflow, /MEEET_PROVIDER_MODE:\s*fixture/);
  assert.match(ciWorkflow, /node scripts\/e2e-calculation\.mjs/);
  assert.match(ciWorkflow, /needs:\s*validate/);

  const e2eScript = read("scripts/e2e-calculation.mjs");
  assert.match(e2eScript, /\/api\/meeting\/calculate/);
  assert.match(e2eScript, /meeet-meeting\/v3/);
  assert.match(e2eScript, /"ok"/);
  assert.match(e2eScript, /participants\.length/);
  assert.match(e2eScript, /"red"/);
  assert.match(e2eScript, /"blue"/);
  assert.match(e2eScript, /stationAreas/);
  assert.match(e2eScript, /Date\.now/);
  assert.match(e2eScript, /5 \* 60 \* 1000/);
});

test("docs describe the feature/dev/main promotion path", () => {
  const promotionPath = "feature/<slug> → dev → main";
  for (const doc of [agentsGuide, readme, deploymentGuide]) {
    assert.match(doc, new RegExp(promotionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("docs state dev and feature branch pushes publish the runner image only", () => {
  assert.match(readme, /dev and feature branch pushes publish the runner image only/);
  assert.match(readme, /`?main`? and release tags publish both/);
});

test("docs state the compiler is published only on main pushes and release tags", () => {
  assert.match(deploymentGuide, /dev and feature branch pushes publish the runner only/);
  assert.match(readme, /`?main`? and release tags publish both/);
});

test("deployment guide documents GHCR image retention with no automated deletion", () => {
  const retentionSection = deploymentGuide.slice(deploymentGuide.indexOf("## GHCR image retention"));
  assert.match(retentionSection, /GHCR image retention/i);
  assert.match(retentionSection, /no automated deletion/i);
  assert.match(retentionSection, /#40/);
});

test("deployment guide runtime .env sample uses digest-pinned runner image", () => {
  assert.match(deploymentGuide, /MEEET_IMAGE=ghcr\.io\/tiloheidasch\/meeet@sha256:/);
});
