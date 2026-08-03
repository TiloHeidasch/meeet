#!/usr/bin/env python3
"""Generate or verify the official Munich boundary plus a 15km access envelope.

The operation uses Shapely deliberately instead of a bounding-box shortcut.
That keeps the generated envelope a real metric buffer around the official
application boundary.  Shapely is a deployment/CI prerequisite for this stage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


RADIUS_METERS = 15_000
SOURCE_CRS = "EPSG:4326"
TARGET_CRS = "EPSG:25832"
SHAPELY_VERSION = "2.0.6"
PYPROJ_VERSION = "3.7.1"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate = subparsers.add_parser("generate")
    generate.add_argument("--boundary", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--boundary", type=Path, required=True)
    verify.add_argument("--envelope", type=Path, required=True)
    args = parser.parse_args()
    try:
        check_tool_versions()
        if args.command == "generate":
            generate_envelope(args.boundary, args.output)
        else:
            verify_envelope(args.boundary, args.envelope)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"Munich access-envelope stage failed: {error}", file=sys.stderr)
        return 2
    return 0


def check_tool_versions() -> None:
    import pyproj  # type: ignore[import-not-found]
    import shapely
    if shapely.__version__ != SHAPELY_VERSION or pyproj.__version__ != PYPROJ_VERSION:
        raise RuntimeError(
            f"access-envelope tools must be Shapely {SHAPELY_VERSION} and pyproj {PYPROJ_VERSION}; "
            f"found {shapely.__version__} and {pyproj.__version__}"
        )


def generate_envelope(boundary_path: Path, output_path: Path) -> None:
    if output_path.exists():
        raise ValueError(f"refusing to replace immutable access-envelope artifact: {output_path}")
    geometry = boundary_geometry(boundary_path)
    projected = to_projected(geometry)
    result = projected.buffer(RADIUS_METERS, resolution=32)
    feature = {
        "type": "Feature",
        "properties": {
            "kind": "official-munich-access-envelope",
            "radiusMeters": RADIUS_METERS,
            "crs": TARGET_CRS,
            "boundarySha256": sha256_file(boundary_path),
            "sourceBoundary": "data/official/munich-districts.json",
        },
        "geometry": geometry_mapping(result),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "crs": {"type": "name", "properties": {"name": TARGET_CRS}},
                "features": [feature],
            },
            indent=2,
            sort_keys=True,
        ) + "\n",
        encoding="utf-8",
    )
    verify_envelope(boundary_path, output_path)


def verify_envelope(boundary_path: Path, envelope_path: Path) -> None:
    boundary = boundary_geometry(boundary_path)
    value = read_json(envelope_path)
    features = value.get("features") if isinstance(value, dict) else None
    if not isinstance(features, list) or len(features) != 1 or not isinstance(features[0], dict):
        raise ValueError("access envelope must be a one-feature GeoJSON FeatureCollection")
    feature = features[0]
    properties = feature.get("properties")
    if not isinstance(properties, dict) or properties.get("radiusMeters") != RADIUS_METERS:
        raise ValueError("access envelope radius is not exactly 15000 metres")
    if properties.get("kind") != "official-munich-access-envelope" or properties.get("sourceBoundary") != "data/official/munich-districts.json":
        raise ValueError("access envelope is not the canonical Munich artifact")
    if properties.get("boundarySha256") != sha256_file(boundary_path):
        raise ValueError("access envelope was generated from a different boundary artifact")
    crs = value.get("crs")
    if (
        properties.get("crs") != TARGET_CRS
        or not isinstance(crs, dict)
        or not isinstance(crs.get("properties"), dict)
        or crs["properties"].get("name") != TARGET_CRS
    ):
        raise ValueError("access envelope must declare EPSG:25832")
    envelope = shape_from_geojson(feature.get("geometry"))
    if envelope.geom_type not in {"Polygon", "MultiPolygon"}:
        raise ValueError("access envelope geometry must be a polygon")
    expected = to_projected(boundary).buffer(RADIUS_METERS, resolution=32)
    if not envelope.is_valid or not envelope.equals_exact(expected, tolerance=1e-7):
        raise ValueError("access envelope polygon does not equal the canonical EPSG:25832 15km buffer")
    print(f"verified 15km Munich access envelope: {envelope_path}")


def boundary_geometry(path: Path) -> Any:
    value = read_json(path)
    features = value.get("features") if isinstance(value, dict) else None
    if not isinstance(features, list) or not features:
        raise ValueError("official boundary must be a non-empty GeoJSON FeatureCollection")
    from shapely.geometry import shape
    from shapely.ops import unary_union

    geometries = []
    for feature in features:
        if not isinstance(feature, dict) or not isinstance(feature.get("geometry"), dict):
            raise ValueError("official boundary contains an invalid feature")
        geometries.append(shape(feature["geometry"]))
    result = unary_union(geometries)
    if result.is_empty or not result.is_valid:
        raise ValueError("official boundary geometry is empty or invalid")
    return result


def to_projected(geometry: Any) -> Any:
    from pyproj import Transformer  # type: ignore[import-not-found]
    from shapely.ops import transform
    transformer = Transformer.from_crs(SOURCE_CRS, TARGET_CRS, always_xy=True)
    return transform(transformer.transform, geometry)


def shape_from_geojson(value: Any) -> Any:
    if not isinstance(value, dict):
        raise ValueError("access envelope geometry is missing")
    from shapely.geometry import shape
    return shape(value)


def geometry_mapping(value: Any) -> dict[str, Any]:
    from shapely.geometry import mapping
    return mapping(value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
