#!/usr/bin/env python3
"""Validate the pinned OTP/GraphHopper deployment templates without Docker."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


OTP_ROUTING_DEFAULT_FIELDS = {"walk", "bike", "car", "transferSlack"}
OTP_SPEED_FIELDS = {"speed"}
OTP_TRANSIT_FIELDS = {"maxNumberOfTransfers"}
MODEL_DEPENDENCY_NAMES = {"road_class", "road_environment", "max_speed"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    root = args.root.resolve()
    build = read_json(root / "routing/otp/config/build-config.europe-berlin.json")
    router = read_json(root / "routing/otp/config/router-config.europe-berlin.json")
    compose = (root / "docker-compose.routing.yml").read_text(encoding="utf-8")
    graphhopper = (root / "routing/graphhopper/config/config.yml").read_text(encoding="utf-8")
    car = read_json(root / "routing/graphhopper/config/car.json")
    bike = read_json(root / "routing/graphhopper/config/bike.json")

    assert_exact_keys(build, {"osm", "transitFeeds"}, "OTP build config")
    if "transit" in build:
        raise ValueError("OTP 2.6 build config must use transitFeeds, not transit")
    if not isinstance(build["transitFeeds"], list) or len(build["transitFeeds"]) != 1:
        raise ValueError("OTP build config must have one transitFeeds entry")
    feed = build["transitFeeds"][0]
    assert_exact_keys(feed, {"type", "source", "feedId"}, "OTP MVV transit feed")
    if feed["type"] != "gtfs" or feed["feedId"] != "mvv" or feed["source"] != "/var/opentripplanner/input/feeds/mvv.zip":
        raise ValueError("OTP build config must bind the MVV feed at the explicit base directory")
    osm = build["osm"]
    if not isinstance(osm, list) or len(osm) != 1 or osm[0].get("source") != "/var/opentripplanner/input/osm/munich.osm.pbf":
        raise ValueError("OTP build config must bind the Munich OSM input under /var/opentripplanner")

    assert_exact_keys(router, {"routingDefaults", "transit"}, "OTP router config")
    if not isinstance(router["routingDefaults"], dict):
        raise ValueError("OTP routingDefaults must be an object")
    assert_exact_keys(router["routingDefaults"], OTP_ROUTING_DEFAULT_FIELDS, "OTP routingDefaults")
    for mode in ("walk", "bike", "car"):
        if not isinstance(router["routingDefaults"][mode], dict):
            raise ValueError(f"OTP routingDefaults.{mode} must be an object")
        assert_exact_keys(router["routingDefaults"][mode], OTP_SPEED_FIELDS, f"OTP {mode} defaults")
        speed = router["routingDefaults"][mode]["speed"]
        if not isinstance(speed, (int, float)) or speed <= 0:
            raise ValueError(f"OTP routingDefaults.{mode}.speed must be positive")
    transfer_slack = router["routingDefaults"]["transferSlack"]
    if not isinstance(transfer_slack, str) or not re.fullmatch(r"PT(?:[1-9][0-9]*H)?(?:[1-9][0-9]*M)?(?:[1-9][0-9]*S)?", transfer_slack):
        raise ValueError("OTP routingDefaults.transferSlack must be a duration string")
    if not isinstance(router["transit"], dict):
        raise ValueError("OTP transit config must be an object")
    assert_exact_keys(router["transit"], OTP_TRANSIT_FIELDS, "OTP transit config")
    if not isinstance(router["transit"]["maxNumberOfTransfers"], int) or router["transit"]["maxNumberOfTransfers"] < 0:
        raise ValueError("OTP transit.maxNumberOfTransfers must be a non-negative integer")

    required_graphhopper_fragments = [
        "datareader.file: /data/input/osm/munich.osm.pbf",
        "graph.location: /data/artifacts/graphhopper-10.2",
        "- name: car",
        "- name: bike",
        "profiles_ch:",
        "graph.encoded_values: road_class, road_environment, max_speed",
    ]
    for fragment in required_graphhopper_fragments:
        if fragment not in graphhopper:
            raise ValueError(f"GraphHopper config is missing required fragment: {fragment}")

    models = {"car": car, "bike": bike}
    for profile, model in models.items():
        model_path = root / f"routing/graphhopper/config/{profile}.json"
        dependencies = model_dependencies(model)
        if "custom_model_files:" not in graphhopper or f"/etc/graphhopper/{profile}.json" not in graphhopper:
            raise ValueError(f"GraphHopper profile {profile} is not bound to its custom model")
        encoded_values_match = re.search(r"graph\.encoded_values:\s*([^\n]+)", graphhopper)
        if encoded_values_match is None:
            raise ValueError("GraphHopper config has no graph.encoded_values declaration")
        encoded_values = {value.strip() for value in encoded_values_match.group(1).split(",")}
        missing = dependencies - encoded_values
        if missing:
            raise ValueError(f"GraphHopper model {model_path} requires omitted encoded values: {sorted(missing)}")

    required_topology_fragments = [
        "--basePath",
        "/var/opentripplanner",
        "--abortOnUnknownConfig",
        "/usr/local/bin/meeet-otp-entrypoint",
        "/run/meeet-routing/manifest.json",
        "/run/meeet-routing/deployment-attestation.json",
        "/run/meeet-routing/runtime-identity.env",
        "/run/meeet-routing/otp-runtime.files.sha256",
        "/run/meeet-routing/graphhopper-runtime.files.sha256",
        "/verify/config/otp-entrypoint.sh",
        "/verify/config/graphhopper-entrypoint.sh",
        "127.0.0.1:8080:8080",
        "127.0.0.1:8989:8989",
        "internal: true",
    ]
    for fragment in required_topology_fragments:
        if fragment not in compose:
            raise ValueError(f"Compose topology is missing required fragment: {fragment}")

    print("routing templates validated: OTP 2.6 keys, runtime attestation topology, and GraphHopper profile/model wiring; pinned import remains required")
    return 0


def model_dependencies(value: Any) -> set[str]:
    serialized = json.dumps(value, sort_keys=True)
    return {name for name in MODEL_DEPENDENCY_NAMES if re.search(rf"\b{re.escape(name)}\b", serialized)}


def assert_exact_keys(value: Any, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise ValueError(f"{label} keys do not match schema allow-list: {actual}")


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read JSON {path}: {error}") from error


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(f"routing config validation failed: {error}", file=sys.stderr)
        raise SystemExit(2)
