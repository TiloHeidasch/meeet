#!/usr/bin/env python3
"""Validate the canonical application-compatible routing manifest contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from routing_identity import IdentityError, digest_hex, normalize_digest, parse_image_reference


CONTRACT_VERSION = "meeet-routing-manifest/v1"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
IMAGE = re.compile(r"^[^@\s]+@sha256:[a-f0-9]{64}$")
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
TOP_LEVEL = {
    "accessEnvelope",
    "artifacts",
    "config",
    "contractVersion",
    "engine",
    "engines",
    "feeds",
    "generatedAt",
    "manifestId",
    "officialBoundary",
    "osm",
    "profiles",
    "realtime",
}
TRANSFORMATION_IDS = {
    "mvv-authoritative-schedule",
    "mvg-metadata-enrichment",
    "realtime-overlay",
    "official-munich-access-envelope-15km",
    "otp-graph-import",
    "graphhopper-profile-import",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--attestation", type=Path)
    args = parser.parse_args()
    validate_manifest(read_json(args.fixture))
    if args.manifest:
        manifest = read_json(args.manifest)
        validate_manifest(manifest)
        if args.attestation:
            validate_attestation(read_json(args.attestation), manifest)
        print(f"canonical routing manifest validated: {args.manifest}")
    else:
        print(f"canonical routing manifest fixture validated: {args.fixture}")
    return 0


def validate_manifest(value: dict[str, Any]) -> None:
    if set(value) != TOP_LEVEL:
        raise ValueError(f"manifest top-level keys differ from canonical output: {sorted(set(value) ^ TOP_LEVEL)}")
    if value.get("contractVersion") != CONTRACT_VERSION:
        raise ValueError("manifest version is invalid")
    for key in ("manifestId", "generatedAt"):
        require_string(value, key)
    if not ISO_INSTANT.fullmatch(value["generatedAt"]):
        raise ValueError("manifest generatedAt must be a canonical UTC instant")
    if value.get("engine") != "otp-graphhopper":
        raise ValueError("manifest engine is invalid")

    engines = value.get("engines")
    if not isinstance(engines, dict) or set(engines) != {"otp", "graphhopper"}:
        raise ValueError("manifest must identify OTP and GraphHopper")
    for name, image in engines.items():
        validate_image_identity(image, name)

    profiles = value.get("profiles")
    if not isinstance(profiles, dict) or set(profiles) != {"otp", "bike", "car"}:
        raise ValueError("manifest profiles are incomplete")
    for profile in profiles.values():
        if not isinstance(profile, str) or not profile:
            raise ValueError("manifest profiles must be non-empty strings")

    validate_feeds(value.get("feeds"))
    validate_osm(value.get("osm"))
    validate_config(value.get("config"))
    artifacts = value.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != {"graph", "input"}:
        raise ValueError("manifest artifacts must contain graph and input identities")
    for name, artifact in artifacts.items():
        validate_artifact(artifact, f"artifacts.{name}")
    validate_artifact(value.get("officialBoundary"), "officialBoundary")
    validate_access_envelope(value.get("accessEnvelope"))
    validate_realtime(value.get("realtime"))


def validate_image_identity(value: Any, label: str) -> None:
    if not isinstance(value, dict) or set(value) != {"id", "contentHash", "image", "digest", "version"}:
        raise ValueError(f"{label} image identity has the wrong fields")
    validate_string(value["id"], f"{label}.id")
    validate_hash(value["contentHash"], f"{label}.contentHash")
    if not isinstance(value["image"], str) or not IMAGE.fullmatch(value["image"]):
        raise ValueError(f"{label}.image must be digest-qualified")
    try:
        normalized_digest = normalize_digest(value["digest"])
        parsed_image = parse_image_reference(value["image"])
    except IdentityError as error:
        raise ValueError(f"{label} digest or image reference is invalid") from error
    if parsed_image.digest != normalized_digest:
        raise ValueError(f"{label}.digest must be sha256 plus 64 lowercase hex characters")
    if value["contentHash"] != digest_hex(normalized_digest):
        raise ValueError(f"{label}.contentHash and digest disagree")
    validate_string(value["version"], f"{label}.version")


def validate_feeds(value: Any) -> None:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError("manifest must contain exactly MVV and MVG feeds")
    names: set[str] = set()
    roles: set[str] = set()
    expected = {"MVV": "authoritative-schedule", "MVG": "metadata-enrichment"}
    feed_keys = {"name", "sourceUrl", "license", "attribution", "version", "retrievedAt", "feedId", "contentHash", "asOf", "role"}
    for feed in value:
        if not isinstance(feed, dict) or set(feed) != feed_keys:
            raise ValueError("feed fields are not canonical")
        name = feed.get("name")
        role = feed.get("role")
        if name not in expected or role != expected[name] or name in names or role in roles:
            raise ValueError("feed names and roles must identify MVV and MVG exactly once")
        names.add(str(name))
        roles.add(str(role))
        validate_https(feed["sourceUrl"], "feed.sourceUrl")
        validate_license(feed["license"])
        validate_string(feed["attribution"], "feed.attribution")
        validate_string(feed["version"], "feed.version")
        validate_instant(feed["retrievedAt"], "feed.retrievedAt")
        validate_string(feed["feedId"], "feed.feedId")
        validate_hash(feed["contentHash"], "feed.contentHash")
        validate_instant(feed["asOf"], "feed.asOf")


def validate_osm(value: Any) -> None:
    expected = {"id", "contentHash", "sourceUrl", "license", "attribution", "version", "retrievedAt", "asOf"}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("OSM provenance fields are not canonical")
    validate_string(value["id"], "osm.id")
    validate_hash(value["contentHash"], "osm.contentHash")
    validate_https(value["sourceUrl"], "osm.sourceUrl")
    validate_license(value["license"])
    validate_string(value["attribution"], "osm.attribution")
    validate_string(value["version"], "osm.version")
    validate_instant(value["retrievedAt"], "osm.retrievedAt")
    validate_instant(value["asOf"], "osm.asOf")


def validate_config(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"id", "contentHash", "asOf"}:
        raise ValueError("routing config identity fields are not canonical")
    validate_string(value["id"], "config.id")
    validate_hash(value["contentHash"], "config.contentHash")
    validate_instant(value["asOf"], "config.asOf")


def validate_artifact(value: Any, label: str) -> None:
    if not isinstance(value, dict) or set(value) != {"id", "contentHash"}:
        raise ValueError(f"{label} identity fields are not canonical")
    validate_string(value["id"], f"{label}.id")
    validate_hash(value["contentHash"], f"{label}.contentHash")


def validate_access_envelope(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"artifact", "extentKm", "bounds"}:
        raise ValueError("access-envelope fields are not canonical")
    validate_artifact(value["artifact"], "accessEnvelope.artifact")
    if value["extentKm"] != 15:
        raise ValueError("access envelope must be exactly 15km")
    bounds = value["bounds"]
    if not isinstance(bounds, dict) or set(bounds) != {"minLatitude", "maxLatitude", "minLongitude", "maxLongitude"}:
        raise ValueError("access-envelope bounds are not canonical")
    for key in bounds:
        if isinstance(bounds[key], bool) or not isinstance(bounds[key], (int, float)):
            raise ValueError(f"accessEnvelope.bounds.{key} must be numeric")
    if not (-90 <= bounds["minLatitude"] < bounds["maxLatitude"] <= 90):
        raise ValueError("access-envelope latitude bounds are invalid")
    if not (-180 <= bounds["minLongitude"] < bounds["maxLongitude"] <= 180):
        raise ValueError("access-envelope longitude bounds are invalid")


def validate_realtime(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"state", "dataState", "artifact", "timestamp"}:
        raise ValueError("realtime fields are not canonical")
    if value["state"] != "frozen" or value["dataState"] not in {"scheduled", "live", "unknown"}:
        raise ValueError("realtime state is invalid")
    validate_artifact(value["artifact"], "realtime.artifact")
    if value["timestamp"] is not None:
        validate_instant(value["timestamp"], "realtime.timestamp")
    if value["dataState"] == "live" and value["timestamp"] is None:
        raise ValueError("live realtime requires a timestamp")
    if value["dataState"] != "live" and value["timestamp"] is not None:
        raise ValueError("only live realtime may carry a timestamp")


def validate_attestation(value: dict[str, Any], manifest: dict[str, Any]) -> None:
    required = {"contractVersion", "manifestId", "manifestSha256", "generatedAt", "transformations", "inputs", "config", "artifacts", "images", "profiles", "accessEnvelope", "runtimeLocks"}
    if set(value) != required or value["contractVersion"] != CONTRACT_VERSION:
        raise ValueError("deployment attestation fields are not canonical")
    if value["manifestId"] != manifest["manifestId"] or value["generatedAt"] != manifest["generatedAt"] or not SHA256.fullmatch(value["manifestSha256"]):
        raise ValueError("deployment attestation does not identify the manifest")
    validate_instant(value["generatedAt"], "deployment attestation.generatedAt")
    transformations = value["transformations"]
    if not isinstance(transformations, list):
        raise ValueError("deployment transformations must be a list")
    by_id = {item.get("id"): item for item in transformations if isinstance(item, dict)}
    if set(by_id) != TRANSFORMATION_IDS or any(not isinstance(item.get("applied"), bool) for item in by_id.values()):
        raise ValueError("deployment transformations are incomplete")
    required_states = {
        "mvv-authoritative-schedule": True,
        "mvg-metadata-enrichment": False,
        "realtime-overlay": False,
        "official-munich-access-envelope-15km": True,
        "otp-graph-import": True,
        "graphhopper-profile-import": True,
    }
    for identifier, applied in required_states.items():
        if by_id[identifier]["applied"] is not applied:
            raise ValueError(f"deployment transformation {identifier} has a false provenance state")
    for collection in (value["inputs"], value["config"], value["artifacts"]):
        if not isinstance(collection, (list, dict)):
            raise ValueError("deployment attestation identity collection is malformed")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, dict) or set(artifacts) != {"otpGraph", "graphhopper", "runtimeIdentity"}:
        raise ValueError("deployment attestation artifacts are incomplete")
    for artifact_name, artifact in artifacts.items():
        if not isinstance(artifact, dict) or set(artifact) != {"id", "role", "path", "contentHash"}:
            raise ValueError(f"deployment attestation artifact {artifact_name} is malformed")
        validate_string(artifact["id"], f"attestation.artifacts.{artifact_name}.id")
        validate_string(artifact["role"], f"attestation.artifacts.{artifact_name}.role")
        validate_string(artifact["path"], f"attestation.artifacts.{artifact_name}.path")
        validate_hash(artifact["contentHash"], f"attestation.artifacts.{artifact_name}.contentHash")
    runtime_locks = value["runtimeLocks"]
    if not isinstance(runtime_locks, dict) or set(runtime_locks) != {"manifest", "otp", "graphhopper", "verify"}:
        raise ValueError("deployment runtime locks are incomplete")
    for lock_name, lock in runtime_locks.items():
        if not isinstance(lock, dict) or set(lock) != {"id", "path", "contentHash", "files"}:
            raise ValueError(f"deployment runtime lock {lock_name} is malformed")
        validate_string(lock["id"], f"attestation.runtimeLocks.{lock_name}.id")
        validate_string(lock["path"], f"attestation.runtimeLocks.{lock_name}.path")
        validate_hash(lock["contentHash"], f"attestation.runtimeLocks.{lock_name}.contentHash")
        if not isinstance(lock["files"], list) or not lock["files"]:
            raise ValueError(f"deployment runtime lock {lock_name} has no file digests")
        for file_entry in lock["files"]:
            if not isinstance(file_entry, dict) or set(file_entry) != {"sourcePath", "targetPath", "contentHash"}:
                raise ValueError(f"deployment runtime lock {lock_name} contains a malformed file digest")
            validate_string(file_entry["sourcePath"], "runtime lock sourcePath")
            validate_string(file_entry["targetPath"], "runtime lock targetPath")
            validate_hash(file_entry["contentHash"], "runtime lock contentHash")
    if not isinstance(value["images"], dict) or set(value["images"]) != {"otp", "graphhopper"}:
        raise ValueError("deployment attestation images are incomplete")
    for name, image in value["images"].items():
        if not isinstance(image, dict) or set(image) != {"id", "contentHash", "image", "digest", "imageId", "version", "revision"}:
            raise ValueError(f"attestation.images.{name} identity fields are not canonical")
        validate_image_identity({key: image[key] for key in ("id", "contentHash", "image", "digest", "version")}, f"attestation.images.{name}")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image["imageId"]):
            raise ValueError(f"attestation.images.{name}.imageId is invalid")
        if not re.fullmatch(r"[0-9a-f]{40}", image["revision"]):
            raise ValueError(f"attestation.images.{name}.revision is invalid")
        public = {key: image[key] for key in ("id", "contentHash", "image", "digest", "version")}
        if public != manifest["engines"][name]:
            raise ValueError(f"attestation.images.{name} disagrees with the manifest")
    if value["profiles"] != manifest["profiles"]:
        raise ValueError("deployment profile attestation disagrees with manifest")
    if value["accessEnvelope"].get("crs") != "EPSG:25832" or value["accessEnvelope"].get("radiusMeters") != 15000:
        raise ValueError("deployment access-envelope attestation is not EPSG:25832/15km")


def validate_license(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"name", "url"}:
        raise ValueError("license fields are not canonical")
    validate_string(value["name"], "license.name")
    validate_https(value["url"], "license.url")


def validate_https(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.startswith("https://"):
        raise ValueError(f"{label} must be an HTTPS URL")


def validate_hash(value: Any, label: str) -> None:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")


def validate_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")


def require_string(value: dict[str, Any], key: str) -> None:
    validate_string(value.get(key), key)


def validate_instant(value: Any, label: str) -> None:
    if not isinstance(value, str) or not ISO_INSTANT.fullmatch(value):
        raise ValueError(f"{label} must be a canonical UTC instant")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"canonical routing manifest validation failed: {error}", file=sys.stderr)
        raise SystemExit(2)
