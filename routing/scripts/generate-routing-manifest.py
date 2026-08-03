#!/usr/bin/env python3
"""Generate the immutable application-compatible routing manifest handoff.

Generation is intentionally an attestation step, not a metadata formatter.  It
hashes the files that will be mounted, checks the exact access-envelope
geometry, resolves image IDs from Docker, and records a separate deployment
attestation for the GraphHopper artifact and unapplied transformations.  The
small manifest itself is the strict application handoff contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from routing_identity import IdentityError, digest_hex, normalize_digest, parse_image_reference, parse_repository_digest


CONTRACT_VERSION = "meeet-routing-manifest/v1"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
UTC_INSTANT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
PLACEHOLDER_RE = re.compile(r"REPLACE_WITH|TODO|CHANGE_ME")


class ManifestError(RuntimeError):
    pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest-id", required=True)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--otp-image", required=True)
    parser.add_argument("--graphhopper-image", required=True)
    args = parser.parse_args()

    root = args.root.resolve()
    inventory_path = resolve_path(root, args.inventory)
    inventory = read_json(inventory_path)
    reject_placeholders(inventory, "inventory")
    validate_timestamp(args.generated_at, "generatedAt")
    validate_manifest_id(args.manifest_id)

    input_version = required_string(inventory, "inputVersion")
    input_root = resolve_path(root, required_string(inventory, "inputRoot"))
    require_directory(input_root, "inputRoot")
    require_versioned_path(input_root, "inputRoot")

    mvv = required_object(inventory, "mvv")
    mvg = required_object(inventory, "mvg")
    realtime = required_object(inventory, "realtime")
    osm = required_object(inventory, "osm")
    boundary = required_object(inventory, "boundary")
    access_envelope = required_object(inventory, "accessEnvelope")
    otp_graph = required_object(inventory, "otpGraph")
    graphhopper_artifact = required_object(inventory, "graphhopperArtifact")

    # The only applied transit transformation in this foundation is the MVV
    # schedule import.  MVG metadata and realtime are inputs/provenance, not
    # silently applied overlays.
    if required_bool(mvv, "applied") is not True:
        raise ManifestError("MVV authoritative schedule must be explicitly applied by OTP graph construction.")
    if required_bool(mvg, "applied") is not False:
        raise ManifestError("MVG enrichment is not implemented and must be explicitly unapplied.")
    if required_bool(realtime, "applied") is not False:
        raise ManifestError("Realtime overlay is not implemented and must be explicitly unapplied.")

    mvv_input_entry = input_entry(root, mvv, "mvv", "authoritative-schedule")
    mvg_input_entry = input_entry(root, mvg, "mvg", "metadata-enrichment")
    mvv_entry = feed_entry(root, mvv, "MVV", "authoritative-schedule")
    mvg_entry = feed_entry(root, mvg, "MVG", "metadata-enrichment")
    realtime_entry = input_entry(root, realtime, "realtime", "realtime")
    osm_entry = input_entry(root, osm, "osm", "street-network")
    boundary_entry = input_entry(root, boundary, "official-boundary", "official-boundary")
    envelope_entry = input_entry(root, access_envelope, "access-envelope", "derived-access-envelope")
    envelope_path = resolve_path(root, required_string(access_envelope, "path"))
    if envelope_path.name != "munich-access-envelope-15km.geojson":
        raise ManifestError("The access-envelope artifact must be munich-access-envelope-15km.geojson.")
    verify_access_envelope(root, boundary_entry["path"], envelope_entry["path"])
    envelope_bounds = geographic_bounds(envelope_path)

    config_paths = inventory.get("config")
    if not isinstance(config_paths, list) or not config_paths or not all(isinstance(item, str) for item in config_paths):
        raise ManifestError("inventory.config must be a non-empty list of paths.")
    config_entries = [
        file_entry(resolve_path(root, path), root, f"config-{index + 1}", "engine-config")
        for index, path in enumerate(config_paths)
    ]
    config_hash = combine_hashes(config_entries)
    config_identity = {
        "id": "otp-graphhopper-config-europe-berlin-mvv",
        "contentHash": config_hash,
        "asOf": args.generated_at,
    }

    otp_graph_entry = path_entry(root, otp_graph, "otp-graph", "generated-graph")
    graphhopper_entry = path_entry(root, graphhopper_artifact, "graphhopper-artifact", "generated-graph")
    require_versioned_path(resolve_path(root, otp_graph_entry["path"]), "otpGraph")
    require_versioned_path(resolve_path(root, graphhopper_entry["path"]), "graphhopperArtifact")
    input_identity = {
        "id": f"routing-inputs/{input_version}",
        "contentHash": hash_tree(input_root),
    }

    otp_image = image_identity(args.otp_image, "otp", "2.6.0")
    graphhopper_image = image_identity(args.graphhopper_image, "graphhopper", "10.2")
    otp_manifest_image = public_image_identity(otp_image)
    graphhopper_manifest_image = public_image_identity(graphhopper_image)
    realtime_state = enum_value(realtime, "state", {"scheduled", "live", "unknown"})
    realtime_timestamp = realtime.get("timestamp")
    if realtime_state == "live":
        if not isinstance(realtime_timestamp, str):
            raise ManifestError("live realtime input must include its frozen timestamp")
        validate_timestamp(realtime_timestamp, "realtime.timestamp")
    elif realtime_timestamp is not None:
        raise ManifestError("scheduled or unknown realtime input must not include a timestamp")
    effective_realtime_state = realtime_state if realtime_state == "scheduled" else "unknown"

    manifest: dict[str, Any] = {
        "contractVersion": CONTRACT_VERSION,
        "engine": "otp-graphhopper",
        "manifestId": args.manifest_id,
        "generatedAt": args.generated_at,
        "engines": {"otp": otp_manifest_image, "graphhopper": graphhopper_manifest_image},
        "profiles": {"otp": "TRANSIT,WALK", "bike": "bike", "car": "car"},
        "feeds": [mvv_entry, mvg_entry],
        "osm": {
            "id": required_string(osm, "id"),
            "contentHash": osm_entry["contentHash"],
            "sourceUrl": required_https(osm, "sourceUrl", "osm.sourceUrl"),
            "license": license_value(osm, "osm.license"),
            "attribution": required_string(osm, "attribution"),
            "version": required_string(osm, "version"),
            "retrievedAt": validate_timestamp(required_string(osm, "retrievedAt"), "osm.retrievedAt"),
            "asOf": validate_timestamp(required_string(osm, "asOf"), "osm.asOf"),
        },
        "config": config_identity,
        "artifacts": {
            "graph": {"id": otp_graph_entry["id"], "contentHash": otp_graph_entry["contentHash"]},
            "input": input_identity,
        },
        "officialBoundary": {"id": boundary_entry["id"], "contentHash": boundary_entry["contentHash"]},
        "accessEnvelope": {
            "artifact": {"id": envelope_entry["id"], "contentHash": envelope_entry["contentHash"]},
            "extentKm": 15,
            "bounds": envelope_bounds,
        },
        "realtime": {
            "state": "frozen",
            "dataState": effective_realtime_state,
            "artifact": {"id": realtime_entry["id"], "contentHash": realtime_entry["contentHash"]},
            "timestamp": None,
        },
    }

    output_dir = resolve_path(root, args.output_dir)
    if output_dir.exists():
        raise ManifestError(f"refusing to replace existing immutable manifest directory: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir()
    manifest_path = output_dir / "meeet-routing-manifest.json"
    manifest_bytes = canonical_json(manifest)
    manifest_path.write_bytes(manifest_bytes)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()

    manifest_lock_path = output_dir / "manifest.sha256"
    write_manifest_lock(manifest_lock_path, manifest_hash)
    identity_path = output_dir / "runtime-identity.env"
    write_runtime_identity(
        identity_path,
        manifest_hash,
        config_identity["contentHash"],
        manifest["profiles"],
        otp_graph_entry["contentHash"],
        graphhopper_entry["contentHash"],
        otp_image,
        graphhopper_image,
    )

    otp_runtime_records = runtime_file_records(
        root,
        otp_graph_entry["path"],
        "/var/opentripplanner/graphs/europe-berlin-mvv-2.6.0",
        [
            (root / "routing/otp/config/router-config.europe-berlin.json", "/var/opentripplanner/router-config.json"),
            (root / "routing/otp/config/logback.xml", "/var/opentripplanner/logback.xml"),
            (root / "routing/otp/entrypoint.sh", "/usr/local/bin/meeet-otp-entrypoint"),
            (identity_path, "/run/meeet-routing/runtime-identity.env"),
        ],
    )
    graphhopper_runtime_records = runtime_file_records(
        root,
        graphhopper_entry["path"],
        "/data/artifacts/graphhopper-10.2",
        [
            (root / "routing/graphhopper/config/config.yml", "/etc/graphhopper/config.yml"),
            (root / "routing/graphhopper/config/car.json", "/etc/graphhopper/car.json"),
            (root / "routing/graphhopper/config/bike.json", "/etc/graphhopper/bike.json"),
            (root / "routing/graphhopper/entrypoint.sh", "/usr/local/bin/meeet-graphhopper-entrypoint"),
            (identity_path, "/run/meeet-routing/runtime-identity.env"),
        ],
    )
    verify_records = runtime_file_records(
        root,
        otp_graph_entry["path"],
        "/verify/otp-graph",
        [
            (root / "routing/otp/config/router-config.europe-berlin.json", "/verify/config/otp-router-config.json"),
            (root / "routing/otp/config/build-config.europe-berlin.json", "/verify/config/otp-build-config.json"),
            (root / "routing/otp/entrypoint.sh", "/verify/config/otp-entrypoint.sh"),
        ],
    ) + runtime_file_records(
        root,
        graphhopper_entry["path"],
        "/verify/graphhopper",
        [
            (root / "routing/graphhopper/config/config.yml", "/verify/config/graphhopper-config.yml"),
            (root / "routing/graphhopper/config/car.json", "/verify/config/car.json"),
            (root / "routing/graphhopper/config/bike.json", "/verify/config/bike.json"),
            (root / "routing/graphhopper/entrypoint.sh", "/verify/config/graphhopper-entrypoint.sh"),
        ],
    )
    otp_lock_path = output_dir / "otp-runtime.files.sha256"
    graphhopper_lock_path = output_dir / "graphhopper-runtime.files.sha256"
    verify_lock_path = output_dir / "verify-all.files.sha256"
    write_lock(otp_lock_path, lock_tuples(otp_runtime_records))
    write_lock(graphhopper_lock_path, lock_tuples(graphhopper_runtime_records))
    write_lock(verify_lock_path, lock_tuples(verify_records))
    runtime_locks = {
        "manifest": runtime_lock_attestation(root, manifest_lock_path, [{
            "sourcePath": relative_path(root, manifest_path),
            "targetPath": "/run/meeet-routing/manifest.json",
            "contentHash": manifest_hash,
        }]),
        "otp": runtime_lock_attestation(root, otp_lock_path, otp_runtime_records),
        "graphhopper": runtime_lock_attestation(root, graphhopper_lock_path, graphhopper_runtime_records),
        "verify": runtime_lock_attestation(root, verify_lock_path, verify_records),
    }
    attestation = deployment_attestation(
        args.manifest_id,
        manifest_hash,
        args.generated_at,
        mvv_input_entry,
        mvg_input_entry,
        realtime_entry,
        osm_entry,
        boundary_entry,
        envelope_entry,
        Path(envelope_entry["path"]),
        config_entries,
        config_identity,
        otp_graph_entry,
        graphhopper_entry,
        otp_image,
        graphhopper_image,
        manifest["profiles"],
        runtime_locks,
        {"id": "runtime-identity", "role": "runtime-identity", "path": relative_path(root, identity_path), "contentHash": hash_file(identity_path)},
    )
    attestation_path = output_dir / "deployment-attestation.json"
    attestation_path.write_bytes(canonical_json(attestation))
    attestation_hash = hash_file(attestation_path)
    validate_generated_output(root, manifest_path, attestation_path)
    write_runtime_env(
        output_dir / "runtime.env",
        root,
        args.manifest_id,
        input_root,
        otp_graph_entry["path"],
        graphhopper_entry["path"],
        manifest_hash,
        attestation_hash,
        hash_file(identity_path),
        hash_file(otp_lock_path),
        hash_file(graphhopper_lock_path),
        hash_file(verify_lock_path),
        otp_image["image"],
        graphhopper_image["image"],
        otp_image["digest"],
        graphhopper_image["digest"],
    )

    print(manifest_path)
    return 0


def deployment_attestation(
    manifest_id: str,
    manifest_hash: str,
    generated_at: str,
    mvv: dict[str, Any],
    mvg: dict[str, Any],
    realtime: dict[str, Any],
    osm: dict[str, Any],
    boundary: dict[str, Any],
    envelope: dict[str, Any],
    envelope_path: Path,
    config_entries: list[dict[str, Any]],
    config_identity: dict[str, Any],
    otp_graph: dict[str, Any],
    graphhopper: dict[str, Any],
    otp_image: dict[str, Any],
    graphhopper_image: dict[str, Any],
    profiles: dict[str, str],
    runtime_locks: dict[str, Any],
    runtime_identity: dict[str, str],
) -> dict[str, Any]:
    return {
        "contractVersion": CONTRACT_VERSION,
        "manifestId": manifest_id,
        "manifestSha256": manifest_hash,
        "generatedAt": generated_at,
        "transformations": [
            {"id": "mvv-authoritative-schedule", "applied": True, "inputIds": ["mvv"]},
            {"id": "mvg-metadata-enrichment", "applied": False, "inputIds": ["mvg"]},
            {"id": "realtime-overlay", "applied": False, "inputIds": ["realtime"]},
            {"id": "official-munich-access-envelope-15km", "applied": True, "inputIds": ["official-boundary", "access-envelope"]},
            {"id": "otp-graph-import", "applied": True, "inputIds": ["mvv", "osm"]},
            {"id": "graphhopper-profile-import", "applied": True, "inputIds": ["osm"]},
        ],
        "inputs": {
            "mvv": mvv,
            "mvg": mvg,
            "realtime": realtime,
            "osm": osm,
            "officialBoundary": boundary,
            "accessEnvelope": envelope,
        },
        "config": {"identity": config_identity, "files": config_entries},
        "artifacts": {"otpGraph": otp_graph, "graphhopper": graphhopper, "runtimeIdentity": runtime_identity},
        "images": {"otp": otp_image, "graphhopper": graphhopper_image},
        "profiles": profiles,
        "runtimeLocks": runtime_locks,
        "accessEnvelope": {
            "path": envelope_path.as_posix(),
            "crs": "EPSG:25832",
            "radiusMeters": 15_000,
            "boundarySha256": boundary["contentHash"],
            "artifact": {"id": envelope["id"], "contentHash": envelope["contentHash"]},
        },
    }


def validate_generated_output(root: Path, manifest: Path, attestation: Path) -> None:
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
    except FileNotFoundError as error:
        raise ManifestError("Python is required for generated manifest validation") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip()
        raise ManifestError(f"generated manifest failed canonical validation: {detail}") from error


def write_runtime_identity(
    path: Path,
    manifest_hash: str,
    config_hash: str,
    profiles: dict[str, str],
    otp_graph_hash: str,
    graphhopper_hash: str,
    otp_image: dict[str, str],
    graphhopper_image: dict[str, str],
) -> None:
    values = {
        "ROUTING_IDENTITY_MANIFEST_SHA256": manifest_hash,
        "ROUTING_IDENTITY_CONFIG_SHA256": config_hash,
        "ROUTING_IDENTITY_OTP_PROFILE": profiles["otp"],
        "ROUTING_IDENTITY_BIKE_PROFILE": profiles["bike"],
        "ROUTING_IDENTITY_CAR_PROFILE": profiles["car"],
        "ROUTING_IDENTITY_OTP_GRAPH_SHA256": otp_graph_hash,
        "ROUTING_IDENTITY_GRAPHHOPPER_GRAPH_SHA256": graphhopper_hash,
        "ROUTING_IDENTITY_OTP_IMAGE": otp_image["image"],
        "ROUTING_IDENTITY_OTP_IMAGE_ID": otp_image["imageId"],
        "ROUTING_IDENTITY_OTP_RELEASE": otp_image["version"],
        "ROUTING_IDENTITY_OTP_REVISION": otp_image["revision"],
        "ROUTING_IDENTITY_GRAPHHOPPER_IMAGE": graphhopper_image["image"],
        "ROUTING_IDENTITY_GRAPHHOPPER_IMAGE_ID": graphhopper_image["imageId"],
        "ROUTING_IDENTITY_GRAPHHOPPER_RELEASE": graphhopper_image["version"],
        "ROUTING_IDENTITY_GRAPHHOPPER_REVISION": graphhopper_image["revision"],
    }
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")


def required_object(value: dict[str, Any], key: str) -> dict[str, Any]:
    result = value.get(key)
    if not isinstance(result, dict):
        raise ManifestError(f"inventory.{key} must be an object")
    return result


def required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ManifestError(f"{key} must be a non-empty string")
    return result.strip()


def required_bool(value: dict[str, Any], key: str) -> bool:
    result = value.get(key)
    if not isinstance(result, bool):
        raise ManifestError(f"{key} must be an explicit boolean")
    return result


def enum_value(value: dict[str, Any], key: str, allowed: set[str]) -> str:
    result = required_string(value, key)
    if result not in allowed:
        raise ManifestError(f"{key} must be one of {sorted(allowed)}")
    return result


def feed_entry(root: Path, value: dict[str, Any], name: str, role: str) -> dict[str, Any]:
    entry = input_entry(root, value, name.lower(), role)
    return {
        "name": name,
        "sourceUrl": required_https(value, "sourceUrl", f"{name}.sourceUrl"),
        "license": license_value(value, f"{name}.license"),
        "attribution": required_string(value, "attribution"),
        "version": required_string(value, "version"),
        "retrievedAt": validate_timestamp(required_string(value, "retrievedAt"), f"{name}.retrievedAt"),
        "feedId": required_string(value, "feedId"),
        "contentHash": entry["contentHash"],
        "asOf": validate_timestamp(required_string(value, "asOf"), f"{name}.asOf"),
        "role": role,
    }


def license_value(value: dict[str, Any], label: str) -> dict[str, str]:
    license_record = value.get("license")
    if not isinstance(license_record, dict):
        raise ManifestError(f"{label} must be an object")
    return {
        "name": required_string(license_record, "name"),
        "url": required_https(license_record, "url", f"{label}.url"),
    }


def required_https(value: dict[str, Any], key: str, label: str) -> str:
    result = required_string(value, key)
    if not result.startswith("https://"):
        raise ManifestError(f"{label} must be HTTPS")
    return result


def input_entry(root: Path, value: dict[str, Any], identifier: str, role: str) -> dict[str, Any]:
    path = resolve_path(root, required_string(value, "path"))
    return {"id": identifier, "role": role, "path": relative_path(root, path), "contentHash": hash_path(path)}


def path_entry(root: Path, value: dict[str, Any], identifier: str, role: str) -> dict[str, Any]:
    path = resolve_path(root, required_string(value, "path"))
    return {"id": identifier, "role": role, "path": relative_path(root, path), "contentHash": hash_path(path)}


def file_entry(path: Path, root: Path, identifier: str, role: str) -> dict[str, Any]:
    if not path.is_file():
        raise ManifestError(f"required file does not exist: {path}")
    return {"id": identifier, "role": role, "path": relative_path(root, path), "contentHash": hash_path(path)}


def image_identity(image: str, name: str, release: str) -> dict[str, str]:
    if PLACEHOLDER_RE.search(image):
        raise ManifestError(f"{name} image must be registry/image@sha256:<64 lowercase hex>")
    try:
        requested = parse_image_reference(image)
    except IdentityError as error:
        raise ManifestError(f"{name} image must be registry/image@sha256:<64 lowercase hex>") from error
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .}}", requested.canonical],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise ManifestError("Docker is required to resolve immutable engine image IDs") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip()
        raise ManifestError(f"Docker cannot inspect {name} image: {detail}") from error
    try:
        inspection = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ManifestError(f"Docker returned invalid image metadata for {name}") from error
    if not isinstance(inspection, dict):
        raise ManifestError(f"Docker returned malformed image metadata for {name}")
    image_id = inspection.get("Id")
    repo_digests = inspection.get("RepoDigests")
    if not isinstance(image_id, str) or not isinstance(repo_digests, list):
        raise ManifestError(f"Docker returned incomplete image metadata for {name}")
    parsed_repo_digests: list[tuple[str, str]] = []
    for repo_digest in repo_digests:
        if not isinstance(repo_digest, str):
            continue
        try:
            parsed = parse_repository_digest(repo_digest)
        except IdentityError:
            continue
        parsed_repo_digests.append((parsed.repository, parsed.digest))
    if (requested.repository, requested.digest) not in parsed_repo_digests:
        raise ManifestError(f"Docker did not report requested immutable digest for {name}: {requested.canonical}")
    if not image_id.startswith("sha256:") or not SHA256_RE.fullmatch(image_id.removeprefix("sha256:")):
        raise ManifestError(f"Docker returned an invalid image ID for {name}: {image_id}")
    labels = inspection.get("Config", {}).get("Labels") if isinstance(inspection.get("Config"), dict) else None
    if not isinstance(labels, dict):
        raise ManifestError(f"Docker image {name} has no OCI metadata labels")
    actual_release = labels.get("org.opencontainers.image.version")
    revision = labels.get("org.opencontainers.image.revision")
    if not isinstance(actual_release, str) or actual_release != release:
        raise ManifestError(f"Docker image {name} OCI version must be the pinned {release} release")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        raise ManifestError(f"Docker image {name} must expose its immutable 40-hex OCI revision")
    return {
        "id": f"{name}-image",
        "contentHash": digest_hex(requested.digest),
        "image": requested.canonical,
        "digest": normalize_digest(requested.digest),
        "imageId": image_id,
        "version": actual_release,
        "revision": revision.lower(),
    }


def public_image_identity(value: dict[str, str]) -> dict[str, str]:
    return {key: value[key] for key in ("id", "contentHash", "image", "digest", "version")}


def verify_access_envelope(root: Path, boundary: str, envelope: str) -> None:
    script = root / "routing/scripts/munich-access-envelope.py"
    try:
        subprocess.run(
            [sys.executable, str(script), "verify", "--boundary", boundary, "--envelope", envelope],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise ManifestError("Python is required for access-envelope verification") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip()
        raise ManifestError(f"access-envelope verification failed: {detail}") from error


def geographic_bounds(path: Path) -> dict[str, float]:
    try:
        from pyproj import Transformer  # type: ignore[import-not-found]
    except ImportError as error:
        raise ManifestError("pyproj is required to derive WGS84 access-envelope bounds") from error
    value = read_any_json(path)
    transformer = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True)
    coordinates: list[tuple[float, float]] = []

    def visit(node: Any) -> None:
        if isinstance(node, list):
            if len(node) >= 2 and all(isinstance(item, (int, float)) for item in node[:2]):
                longitude, latitude = transformer.transform(float(node[0]), float(node[1]))
                coordinates.append((longitude, latitude))
            else:
                for child in node:
                    visit(child)
        elif isinstance(node, dict):
            if "coordinates" in node:
                visit(node["coordinates"])
            elif "geometry" in node:
                visit(node["geometry"])
            elif "features" in node:
                visit(node["features"])

    visit(value)
    if not coordinates:
        raise ManifestError(f"access envelope has no coordinates: {path}")
    longitudes, latitudes = zip(*coordinates)
    return {
        "minLatitude": min(latitudes),
        "maxLatitude": max(latitudes),
        "minLongitude": min(longitudes),
        "maxLongitude": max(longitudes),
    }


def runtime_file_records(root: Path, source_path: str, target_path: str, extra_files: list[tuple[Path, str]]) -> list[dict[str, str]]:
    source = resolve_path(root, source_path)
    entries: list[dict[str, str]] = []
    if source.is_file():
        entries.append({"sourcePath": relative_path(root, source), "targetPath": target_path, "contentHash": hash_path(source)})
    else:
        for path in sorted(file_paths(source), key=lambda item: item.relative_to(source).as_posix()):
            entries.append({
                "sourcePath": relative_path(root, path),
                "targetPath": f"{target_path}/{path.relative_to(source).as_posix()}",
                "contentHash": hash_path(path),
            })
    for path, target in extra_files:
        entries.append({"sourcePath": relative_path(root, path), "targetPath": target, "contentHash": hash_path(path)})
    if not entries:
        raise ManifestError(f"cannot create lock for empty artifact: {source}")
    return entries


def lock_tuples(entries: list[dict[str, str]]) -> list[tuple[str, str]]:
    return [(entry["contentHash"], entry["targetPath"]) for entry in entries]


def write_lock(path: Path, entries: list[tuple[str, str]]) -> None:
    path.write_text("".join(f"{digest}  {target}\n" for digest, target in sorted(set(entries), key=lambda item: item[1])), encoding="utf-8")


def runtime_lock_attestation(root: Path, path: Path, entries: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "id": path.stem,
        "path": relative_path(root, path),
        "contentHash": hash_file(path),
        "files": sorted(entries, key=lambda entry: entry["targetPath"]),
    }


def write_manifest_lock(path: Path, digest: str) -> None:
    path.write_text(f"{digest}  /run/meeet-routing/manifest.json\n", encoding="utf-8")


def write_runtime_env(
    path: Path,
    root: Path,
    manifest_id: str,
    input_root: Path,
    otp_graph: str,
    graphhopper_artifact: str,
    manifest_hash: str,
    attestation_hash: str,
    identity_hash: str,
    otp_lock_hash: str,
    graphhopper_lock_hash: str,
    verify_lock_hash: str,
    otp_image: str,
    graphhopper_image: str,
    otp_digest: str,
    graphhopper_digest: str,
) -> None:
    output_dir = path.parent
    values = {
        "ROUTING_INPUT_PATH": relative_path(root, input_root),
        "OTP_GRAPH_BUILD_PATH": otp_graph,
        "OTP_GRAPH_ARTIFACT_PATH": otp_graph,
        "GRAPHHOPPER_ARTIFACT_BUILD_PATH": Path(graphhopper_artifact).parent.as_posix(),
        "GRAPHHOPPER_GRAPH_ARTIFACT_PATH": graphhopper_artifact,
        "ROUTING_MANIFEST_PATH": relative_path(root, output_dir / "meeet-routing-manifest.json"),
        "ROUTING_ATTESTATION_PATH": relative_path(root, output_dir / "deployment-attestation.json"),
        "ROUTING_RUNTIME_IDENTITY_PATH": relative_path(root, output_dir / "runtime-identity.env"),
        "ROUTING_MANIFEST_SHA256": manifest_hash,
        "ROUTING_ATTESTATION_SHA256": attestation_hash,
        "ROUTING_RUNTIME_IDENTITY_SHA256": identity_hash,
        "OTP_RUNTIME_LOCK_SHA256": otp_lock_hash,
        "GRAPHHOPPER_RUNTIME_LOCK_SHA256": graphhopper_lock_hash,
        "ROUTING_VERIFY_LOCK_SHA256": verify_lock_hash,
        "OTP_IMAGE": otp_image,
        "GRAPHHOPPER_IMAGE": graphhopper_image,
        "OTP_IMAGE_DIGEST": otp_digest,
        "GRAPHHOPPER_IMAGE_DIGEST": graphhopper_digest,
        "OTP_RUNTIME_LOCK_PATH": relative_path(root, output_dir / "otp-runtime.files.sha256"),
        "GRAPHHOPPER_RUNTIME_LOCK_PATH": relative_path(root, output_dir / "graphhopper-runtime.files.sha256"),
        "ROUTING_VERIFY_LOCK_PATH": relative_path(root, output_dir / "verify-all.files.sha256"),
        "ROUTING_MANIFEST_ID": manifest_id,
    }
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")


def hash_path(path: Path) -> str:
    if path.is_file():
        return hash_file(path)
    if path.is_dir():
        return hash_tree(path)
    raise ManifestError(f"required artifact does not exist: {path}")


def hash_tree(path: Path) -> str:
    files = file_paths(path)
    if not files:
        raise ManifestError(f"artifact directory is empty: {path}")
    digest = hashlib.sha256()
    for file_path in sorted(files, key=lambda item: item.relative_to(path).as_posix()):
        digest.update(file_path.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(hash_file(file_path)))
        digest.update(b"\0")
    return digest.hexdigest()


def combine_hashes(entries: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item["path"]):
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(entry["contentHash"]))
        digest.update(b"\0")
    return digest.hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_paths(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return [item for item in path.rglob("*") if item.is_file() and not item.is_symlink()]


def resolve_path(root: Path, value: Path | str) -> Path:
    candidate = (root / Path(value)).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"path escapes repository root: {value}") from error
    return candidate


def relative_path(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root).as_posix()


def require_directory(path: Path, label: str) -> None:
    if not path.is_dir():
        raise ManifestError(f"{label} does not exist as a directory: {path}")


def require_versioned_path(path: Path, label: str) -> None:
    if "versions" not in path.parts:
        raise ManifestError(f"{label} must be an immutable artifact under a versions directory")


def read_json(path: Path) -> dict[str, Any]:
    value = read_any_json(path)
    if not isinstance(value, dict):
        raise ManifestError(f"expected JSON object: {path}")
    return value


def read_any_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read JSON {path}: {error}") from error


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def reject_placeholders(value: Any, path: str) -> None:
    if isinstance(value, str) and PLACEHOLDER_RE.search(value):
        raise ManifestError(f"unresolved placeholder at {path}")
    if isinstance(value, dict):
        for key, child in value.items():
            reject_placeholders(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_placeholders(child, f"{path}[{index}]")


def validate_timestamp(value: str, label: str) -> str:
    if not UTC_INSTANT_RE.fullmatch(value):
        raise ManifestError(f"{label} must be a canonical UTC ISO instant")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ManifestError(f"{label} is not a valid UTC instant") from error
    return value


def validate_manifest_id(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", value):
        raise ManifestError("manifest-id must be a short filesystem-safe identifier")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ManifestError as error:
        print(f"manifest generation failed: {error}", file=sys.stderr)
        raise SystemExit(2)
