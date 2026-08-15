import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploymentControlled = [
  "MEEET_IMAGE",
  "MEEET_COMPILER_IMAGE",
  "CLOUDFLARED_IMAGE",
  "MEEET_SCHEDULE_HOST_DIR",
  "CLOUDFLARED_TOKEN_FILE",
];

test("production preflight rejects exported Compose overrides without printing values", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-preflight-"));
  const envFile = join(directory, "production.env");
  const script = fileURLToPath(new URL("../deploy/preflight-production.mjs", import.meta.url));
  const marker = "must-not-appear-in-preflight-output";
  const environment = { ...process.env };

  for (const key of deploymentControlled) {
    delete environment[key];
  }
  Object.assign(environment, Object.fromEntries(deploymentControlled.map((key) => [key, marker])));
  writeFileSync(
    envFile,
    [
      `MEEET_IMAGE=ghcr.io/example-owner/meeet@sha256:${"a".repeat(64)}`,
      `MEEET_COMPILER_IMAGE=ghcr.io/example-owner/meeet-artifact-compiler@sha256:${"c".repeat(64)}`,
      `CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:${"b".repeat(64)}`,
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, [script, envFile], {
      encoding: "utf8",
      env: environment,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.equal(result.status, 1);
    for (const key of deploymentControlled) assert.match(output, new RegExp(`\\b${key}\\b`));
    assert.match(output, /unset/);
    assert.doesNotMatch(output, new RegExp(marker));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production preflight rejects non-lowercase or non-GHCR app image refs", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-preflight-"));
  const envFile = join(directory, "production.env");
  const script = fileURLToPath(new URL("../deploy/preflight-production.mjs", import.meta.url));
  writeFileSync(
    envFile,
    [
      "MEEET_IMAGE=ghcr.io/Example-Owner/meeet@sha256:" + "a".repeat(64),
      "MEEET_COMPILER_IMAGE=docker.io/example/meeet-artifact-compiler@sha256:" + "b".repeat(64),
      "CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:" + "c".repeat(64),
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
      "UNEXPECTED_SETTING=must-be-rejected",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, [script, envFile], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /MEEET_IMAGE must be ghcr\.io/);
    assert.match(output, /MEEET_COMPILER_IMAGE must be ghcr\.io/);
    assert.match(output, /unsupported deployment environment keys: UNEXPECTED_SETTING/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production preflight rejects swapped runner and compiler image identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-preflight-"));
  const envFile = join(directory, "production.env");
  const script = fileURLToPath(new URL("../deploy/preflight-production.mjs", import.meta.url));
  writeFileSync(
    envFile,
    [
      "MEEET_IMAGE=ghcr.io/example-owner/meeet-artifact-compiler@sha256:" + "a".repeat(64),
      "MEEET_COMPILER_IMAGE=ghcr.io/example-owner/meeet@sha256:" + "b".repeat(64),
      "CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:" + "c".repeat(64),
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
    ].join("\n"),
  );
  try {
    const result = spawnSync(process.execPath, [script, envFile], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /MEEET_IMAGE must be ghcr\.io/);
    assert.match(output, /MEEET_COMPILER_IMAGE must be ghcr\.io/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production preflight accepts exact GHCR refs without requiring BuildKit", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-preflight-"));
  const envFile = join(directory, "production.env");
  const docker = join(directory, "docker");
  const script = fileURLToPath(new URL("../deploy/preflight-production.mjs", import.meta.url));
  writeFileSync(
    envFile,
    [
      "MEEET_IMAGE=ghcr.io/example-owner/meeet@sha256:" + "a".repeat(64),
      "MEEET_COMPILER_IMAGE=ghcr.io/example-owner/meeet-artifact-compiler@sha256:" + "b".repeat(64),
      "CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:" + "c".repeat(64),
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
    ].join("\n"),
  );
  writeFileSync(
    docker,
    "#!/bin/sh\nif [ \"$1\" = \"compose\" ]; then printf '2.33.0\\n'; elif [ \"$3\" = \"{{.Server.APIVersion}}\" ]; then printf '1.48\\n'; else printf '28.0.0\\n'; fi\n",
  );
  chmodSync(docker, 0o755);

  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      DOCKER_BUILDKIT: "0",
      COMPOSE_DOCKER_CLI_BUILD: "0",
    };
    for (const key of deploymentControlled) delete environment[key];
    const result = spawnSync(process.execPath, [script, envFile], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    assert.match(result.stdout ?? "", /preflight passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler image helper reads the validated dotenv value without shell evaluation", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-compiler-image-"));
  const envFile = join(directory, "production.env");
  const script = fileURLToPath(new URL("../deploy/read-compiler-image.mjs", import.meta.url));
  const compilerImage = `ghcr.io/example-owner/meeet-artifact-compiler@sha256:${"b".repeat(64)}`;
  writeFileSync(
    envFile,
    [
      `MEEET_IMAGE=ghcr.io/example-owner/meeet@sha256:${"a".repeat(64)}`,
      `MEEET_COMPILER_IMAGE=${compilerImage}`,
      `CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:${"c".repeat(64)}`,
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
    ].join("\n"),
  );
  try {
    const result = spawnSync(process.execPath, [script, envFile], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    assert.equal(result.stdout, `${compilerImage}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production preflight rejects old Engine and API versions", () => {
  const script = fileURLToPath(new URL("../deploy/preflight-production.mjs", import.meta.url));
  const cases = [
    { engine: "27.0.0", api: "1.48", message: /Docker Engine 28 or newer/ },
    { engine: "28.0.0", api: "1.47", message: /Docker Engine API v1\.48 or newer/ },
  ];

  for (const candidate of cases) {
    const directory = mkdtempSync(join(tmpdir(), "meeet-preflight-"));
    const envFile = join(directory, "production.env");
    const docker = join(directory, "docker");
    writeFileSync(
      envFile,
      [
        "MEEET_IMAGE=ghcr.io/example-owner/meeet@sha256:" + "a".repeat(64),
        "MEEET_COMPILER_IMAGE=ghcr.io/example-owner/meeet-artifact-compiler@sha256:" + "b".repeat(64),
        "CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:" + "c".repeat(64),
        "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
        "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
      ].join("\n"),
    );
    writeFileSync(
      docker,
      "#!/bin/sh\nif [ \"$1\" = \"compose\" ]; then printf '2.33.0\\n'; elif [ \"$3\" = \"{{.Server.APIVersion}}\" ]; then printf '%s\\n' \"$FAKE_ENGINE_API\"; else printf '%s\\n' \"$FAKE_ENGINE_VERSION\"; fi\n",
    );
    chmodSync(docker, 0o755);
    try {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        FAKE_ENGINE_VERSION: candidate.engine,
        FAKE_ENGINE_API: candidate.api,
      };
      for (const key of deploymentControlled) delete environment[key];
      const result = spawnSync(process.execPath, [script, envFile], { encoding: "utf8", env: environment });
      assert.equal(result.status, 1);
      assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, candidate.message);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("production image verification rejects tampered, swapped, and mixed revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeet-image-verify-"));
  const envFile = join(directory, "production.env");
  const docker = join(directory, "docker");
  const script = fileURLToPath(new URL("../deploy/verify-production-images.mjs", import.meta.url));
  writeFileSync(
    envFile,
    [
      "MEEET_IMAGE=ghcr.io/example-owner/meeet@sha256:" + "a".repeat(64),
      "MEEET_COMPILER_IMAGE=ghcr.io/example-owner/meeet-artifact-compiler@sha256:" + "b".repeat(64),
      "CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.1@sha256:" + "c".repeat(64),
      "MEEET_SCHEDULE_HOST_DIR=/srv/meeet/artifacts",
      "CLOUDFLARED_TOKEN_FILE=/etc/meeet/secrets/cloudflare-tunnel-token",
    ].join("\n"),
  );
  writeFileSync(
    docker,
    "#!/bin/sh\ncase \"$3\" in *meeet-artifact-compiler*) printf '%s\\n' \"$FAKE_COMPILER_REVISION\" ;; *) printf '%s\\n' \"$FAKE_RUNNER_REVISION\" ;; esac\n",
  );
  chmodSync(docker, 0o755);

  try {
    const cases = [
      { runner: "revision-a", compiler: "revision-a", status: 0 },
      { runner: "revision-a", compiler: "revision-b", status: 1 },
      { runner: "", compiler: "revision-a", status: 1 },
      { runner: "revision-a", compiler: "revision-c", status: 1 },
    ];
    for (const candidate of cases) {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        FAKE_RUNNER_REVISION: candidate.runner,
        FAKE_COMPILER_REVISION: candidate.compiler,
      };
      for (const key of deploymentControlled) delete environment[key];
      const result = spawnSync(process.execPath, [script, envFile], { encoding: "utf8", env: environment });
      assert.equal(result.status, candidate.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
