import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

const compilerWorkflow = read(".github/workflows/publish-compiler.yml");
const runnerWorkflow = read(".github/workflows/publish-runner.yml");
const agentsGuide = read("AGENTS.md");
const readme = read("README.md");

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

test("compiler publication is workflow_dispatch-only and cannot be reached by push events", () => {
  const triggers = triggerBlock(compilerWorkflow);
  assert.match(triggers, /workflow_dispatch/);
  assert.doesNotMatch(triggers, /^\s*push:/m);
});

test("compiler dispatch requires and validates an explicit full source SHA", () => {
  assert.match(compilerWorkflow, /source_sha/);
  assert.match(compilerWorkflow, /required:\s*true/);
  assert.match(compilerWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(compilerWorkflow, /ref:\s*\${{ inputs\.source_sha }}/);
  assert.match(compilerWorkflow, /Verify checked-out revision/);
});

test("compiler workflow publishes only the immutable sha-<full-sha> compiler image", () => {
  assert.match(publishJob(compilerWorkflow), /target:\s*artifact-compiler/);
  assert.match(publishJob(compilerWorkflow), /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(publishJob(compilerWorkflow), /type=raw,value=sha-\${{\s*inputs\.source_sha\s*}}/);
  assert.doesNotMatch(publishJob(compilerWorkflow), /type=ref/);
  assert.match(publishJob(compilerWorkflow), /org\.opencontainers\.image\.revision=\${{\s*inputs\.source_sha\s*}}/);
  assert.match(publishJob(compilerWorkflow), /provenance:\s*mode=max/);
  assert.match(publishJob(compilerWorkflow), /sbom:\s*true/);
  assert.match(publishJob(compilerWorkflow), /attest-build-provenance/);
  assert.match(publishJob(compilerWorkflow), /outputs\.digest/);
});

test("compiler publication cannot deploy, rotate artifacts, or retag production images", () => {
  const forbidden = [/compose/, /cloudflared/, /TUNNEL_TOKEN/, /MEEET_IMAGE/, /unraid/, /\bdeploy\b/, /\bschedule\b/];
  for (const pattern of forbidden) {
    assert.doesNotMatch(compilerWorkflow, pattern, `compiler workflow must not reference ${pattern}`);
  }
});

test("routine runner publication stays compiler-free and dispatch-free", () => {
  assert.match(triggerBlock(runnerWorkflow), /^\s*push:/m);
  assert.doesNotMatch(runnerWorkflow, /artifact-compiler/);
  assert.match(publishJob(runnerWorkflow), /target:\s*runner/);
  const imageLines = runnerWorkflow.match(/^[ \t]+images:\s*ghcr\.io\/.*$/gm);
  assert.ok(imageLines && imageLines.length === 1, "runner workflow must publish exactly one image");
  assert.doesNotMatch(imageLines![0], /artifact-compiler/);
});

test("each workflow grants registry and attestation writes only in its publish job", () => {
  for (const workflow of [compilerWorkflow, runnerWorkflow]) {
    const beforePublish = workflow.slice(0, workflow.indexOf("  publish:"));
    assert.doesNotMatch(beforePublish, /packages:\s*write/);
    assert.match(publishJob(workflow), /packages:\s*write/);
    assert.match(workflow, /^permissions:\n  contents:\s*read/m);
  }
  assert.match(publishJob(compilerWorkflow), /id-token:\s*write/);
  assert.match(publishJob(compilerWorkflow), /attestations:\s*write/);
  assert.doesNotMatch(runnerWorkflow, /id-token|attestations/);
});

test("documented dispatch command matches the compiler workflow and carries no credentials", () => {
  const commandPattern = /gh workflow run publish-compiler\.yml --ref <[^>]+> -f source_sha=<[^>]+>/;
  for (const doc of [agentsGuide, readme]) {
    assert.match(doc, commandPattern);
    assert.doesNotMatch(doc, /https?:\/\/[^\s]*api\.github\.com|webhook|ghp_|github_pat_/i);
  }
  const command = agentsGuide.match(commandPattern);
  assert.ok(command);
  assert.match(command[0], /source_sha=<full-commit-sha>/);
});

test("agent and README documentation state the compiler rebuild trigger conditions", () => {
  for (const doc of [agentsGuide, readme]) {
    assert.match(doc, /compiler image target/);
    assert.match(doc, /compiler\/import scripts|import scripts/);
    assert.match(doc, /GTFS\/artifact model|GTFS|artifact model/);
    assert.match(doc, /locked dependencies/);
    assert.match(doc, /App-only changes do not trigger/i);
  }
});
