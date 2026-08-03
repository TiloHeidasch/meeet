#!/usr/bin/env python3
"""Verify a generated routing manifest and its mounted deployment artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from routing_identity import IdentityError, normalize_digest, parse_image_reference, parse_repository_digest


SHA256 = re.compile(r"^[a-f0-9]{64}$")


class VerificationError(RuntimeError):
    pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--attestation", type=Path)
    parser.add_argument("--skip-images", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest_path = resolve(root, args.manifest)
    attestation_path = resolve(root, args.attestation or manifest_path.with_name("deployment-attestation.json"))
    manifest = read_json(manifest_path)
    attestation = read_json(attestation_path)

    validate_canonical(root, manifest_path, attestation_path)
    expected_manifest_hash = attestation.get("manifestSha256")
    if not isinstance(expected_manifest_hash, str) or not SHA256.fullmatch(expected_manifest_hash):
        raise VerificationError("deployment attestation has no manifest SHA-256")
    if hash_file(manifest_path) != expected_manifest_hash:
        raise VerificationError("manifest bytes do not match deployment attestation")

    checked = 0
    inputs = attestation.get("inputs")
    if not isinstance(inputs, dict):
        raise VerificationError("deployment attestation inputs are malformed")
    for entry in inputs.values():
        checked += verify_entry(root, entry)

    config = attestation.get("config")
    if not isinstance(config, dict) or not isinstance(config.get("identity"), dict) or not isinstance(config.get("files"), list):
        raise VerificationError("deployment config attestation is malformed")
    config_entries = config["files"]
    for entry in config_entries:
        checked += verify_entry(root, entry)
    if combine_hashes(config_entries) != config["identity"].get("contentHash"):
        raise VerificationError("config aggregate hash does not match its files")

    artifacts = attestation.get("artifacts")
    if not isinstance(artifacts, dict):
        raise VerificationError("deployment artifact attestation is malformed")
    for entry in artifacts.values():
        checked += verify_entry(root, entry)

    runtime_locks = attestation.get("runtimeLocks")
    if not isinstance(runtime_locks, dict):
        raise VerificationError("deployment runtime locks are malformed")
    for lock in runtime_locks.values():
        checked += verify_runtime_lock(root, lock)

    envelope = attestation.get("accessEnvelope")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("path"), str):
        raise VerificationError("access-envelope attestation is malformed")
    verify_access_envelope(root, inputs, envelope["path"])

    images = attestation.get("images")
    if not isinstance(images, dict):
        raise VerificationError("deployment image attestation is malformed")
    if not args.skip_images:
        for image in images.values():
            verify_image(image)

    print(f"routing manifest and deployment attestation verified: {checked} artifact entries")
    return 0


def validate_canonical(root: Path, manifest: Path, attestation: Path) -> None:
    validator = root / "routing/scripts/validate-routing-manifest.py"
    fixture = root / "routing/manifest/canonical-output.fixture.json"
    try:
        subprocess.run(
            [sys.executable, str(validator), "--fixture", str(fixture), "--manifest", str(manifest), "--attestation", str(attestation)],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise VerificationError(f"canonical manifest validation failed: {detail}") from error


def verify_entry(root: Path, entry: Any) -> int:
    if not isinstance(entry, dict):
        raise VerificationError("deployment artifact entry is not an object")
    path = entry.get("path")
    expected = entry.get("contentHash")
    if not isinstance(path, str) or not isinstance(expected, str) or not SHA256.fullmatch(expected):
        raise VerificationError("deployment artifact entry has an invalid path or SHA-256")
    actual = hash_path(resolve(root, path))
    if actual != expected:
        raise VerificationError(f"hash mismatch for {path}: expected {expected}, got {actual}")
    return 1


def verify_access_envelope(root: Path, inputs: dict[str, Any], envelope_path: str) -> None:
    boundary = inputs.get("officialBoundary")
    if not isinstance(boundary, dict) or not isinstance(boundary.get("path"), str):
        raise VerificationError("official boundary input is missing")
    script = root / "routing/scripts/munich-access-envelope.py"
    try:
        subprocess.run(
            [sys.executable, str(script), "verify", "--boundary", boundary["path"], "--envelope", envelope_path],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise VerificationError("Python is required for access-envelope verification") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip()
        raise VerificationError(f"canonical access-envelope verification failed: {detail}") from error


def verify_runtime_lock(root: Path, lock: Any) -> int:
    if not isinstance(lock, dict):
        raise VerificationError("runtime lock is not an object")
    checked = verify_entry(root, lock)
    files = lock.get("files")
    if not isinstance(files, list) or not files:
        raise VerificationError("runtime lock has no attested files")
    expected = []
    for entry in files:
        if not isinstance(entry, dict):
            raise VerificationError("runtime lock file entry is malformed")
        source_path = entry.get("sourcePath")
        target_path = entry.get("targetPath")
        expected_hash = entry.get("contentHash")
        if not isinstance(source_path, str) or not isinstance(target_path, str) or not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            raise VerificationError("runtime lock file entry has an invalid source, target, or digest")
        if hash_path(resolve(root, source_path)) != expected_hash:
            raise VerificationError(f"runtime source digest mismatch for {source_path}")
        expected.append((expected_hash, target_path))
        checked += 1
    actual_lines = []
    lock_path = resolve(root, lock["path"])
    for line in lock_path.read_text(encoding="utf-8").splitlines():
        digest, separator, target = line.partition("  ")
        if not separator or not SHA256.fullmatch(digest) or not target:
            raise VerificationError(f"runtime lock has a malformed line: {line}")
        actual_lines.append((digest, target))
    if sorted(actual_lines) != sorted(set(expected)):
        raise VerificationError(f"runtime lock contents disagree with attestation: {lock_path}")
    return checked


def verify_image(entry: Any) -> None:
    if not isinstance(entry, dict):
        raise VerificationError("engine image attestation is malformed")
    image = entry.get("image")
    digest = entry.get("digest")
    try:
        requested = parse_image_reference(image) if isinstance(image, str) else None
        expected_digest = normalize_digest(digest) if isinstance(digest, str) else None
    except IdentityError as error:
        raise VerificationError("engine image is not digest-qualified") from error
    if requested is None:
        raise VerificationError("engine image is not digest-qualified")
    if expected_digest is None or requested.digest != expected_digest:
        raise VerificationError("engine image digest is invalid")
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .}}", requested.canonical],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise VerificationError("Docker is required to verify loaded engine image identities") from error
    except subprocess.CalledProcessError as error:
        raise VerificationError(f"Docker cannot inspect {image}: {error.stderr.strip()}") from error
    try:
        inspection = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise VerificationError(f"Docker returned invalid image metadata for {requested.canonical}") from error
    if not isinstance(inspection, dict):
        raise VerificationError(f"Docker returned malformed identity for {image}")
    repo_digests = inspection.get("RepoDigests")
    if not isinstance(repo_digests, list):
        raise VerificationError(f"Docker returned no repository digests for {requested.canonical}")
    found = False
    for repo_digest in repo_digests:
        if not isinstance(repo_digest, str):
            continue
        try:
            parsed = parse_repository_digest(repo_digest)
        except IdentityError:
            continue
        if parsed.repository == requested.repository and parsed.digest == requested.digest:
            found = True
            break
    if not found:
        raise VerificationError(f"loaded image digest changed for {requested.canonical}")
    image_id = inspection.get("Id")
    expected_image_id = entry.get("imageId")
    if expected_image_id is not None and image_id != expected_image_id:
        raise VerificationError(f"loaded image ID changed for {requested.canonical}")
    labels = inspection.get("Config", {}).get("Labels") if isinstance(inspection.get("Config"), dict) else None
    if not isinstance(labels, dict):
        raise VerificationError(f"loaded image {requested.canonical} has no OCI metadata labels")
    if labels.get("org.opencontainers.image.version") != entry.get("version"):
        raise VerificationError(f"loaded image release metadata changed for {requested.canonical}")
    actual_revision = labels.get("org.opencontainers.image.revision")
    if not isinstance(actual_revision, str) or actual_revision.lower() != entry.get("revision"):
        raise VerificationError(f"loaded image revision metadata changed for {requested.canonical}")


def combine_hashes(entries: list[Any]) -> str:
    digest = hashlib.sha256()
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("contentHash"), str):
            raise VerificationError("config file attestation is malformed")
        normalized.append(entry)
    for entry in sorted(normalized, key=lambda item: item["path"]):
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(entry["contentHash"]))
        digest.update(b"\0")
    return digest.hexdigest()


def hash_path(path: Path) -> str:
    if path.is_file():
        return hash_file(path)
    if path.is_dir():
        files = [item for item in path.rglob("*") if item.is_file() and not item.is_symlink()]
        if not files:
            raise VerificationError(f"artifact directory is empty: {path}")
        digest = hashlib.sha256()
        for item in sorted(files, key=lambda value: value.relative_to(path).as_posix()):
            digest.update(item.relative_to(path).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(bytes.fromhex(hash_file(item)))
            digest.update(b"\0")
        return digest.hexdigest()
    raise VerificationError(f"artifact does not exist: {path}")


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve(root: Path, value: Path | str) -> Path:
    candidate = (root / Path(value)).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise VerificationError(f"path escapes verification root: {value}") from error
    return candidate


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise VerificationError(f"expected JSON object: {path}")
    return value


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"routing manifest verification failed: {error}", file=sys.stderr)
        raise SystemExit(2)
