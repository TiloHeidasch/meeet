#!/usr/bin/env python3
"""Reject mutable runtime image references in a Compose environment file."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from routing_identity import IdentityError, normalize_digest, parse_image_reference


PLACEHOLDER = "REPLACE_WITH_"
COMMIT_LENGTH = 40


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("env_file", type=Path)
    parser.add_argument("--allow-placeholders", action="store_true")
    args = parser.parse_args()
    values = read_env(args.env_file)
    for key in ("OTP_IMAGE", "GRAPHHOPPER_IMAGE"):
        value = values.get(key, "")
        if args.allow_placeholders and PLACEHOLDER in value:
            continue
        try:
            parse_image_reference(value)
        except IdentityError:
            raise ValueError(f"{key} must be an exact image@sha256:<64 lowercase hex> reference")
    for key in ("GRAPHOPPER_BUILD_IMAGE", "GRAPHOPPER_RUNTIME_IMAGE"):
        value = values.get(key, "")
        if args.allow_placeholders and PLACEHOLDER in value:
            continue
        try:
            parse_image_reference(value)
        except IdentityError:
            raise ValueError(f"{key} must be a digest-qualified base image")
    if values.get("GRAPHOPPER_RELEASE") != "10.2" and not args.allow_placeholders:
        raise ValueError("GRAPHOPPER_RELEASE must be exactly 10.2")
    source_commit = values.get("GRAPHOPPER_SOURCE_COMMIT", "")
    if not (args.allow_placeholders and PLACEHOLDER in source_commit) and (len(source_commit) != COMMIT_LENGTH or any(char not in "0123456789abcdefABCDEF" for char in source_commit)):
        raise ValueError("GRAPHOPPER_SOURCE_COMMIT must be the 40-hex release commit")
    source_repository = values.get("GRAPHOPPER_SOURCE_REPOSITORY", "")
    if not (args.allow_placeholders and PLACEHOLDER in source_repository) and not source_repository.startswith(("https://", "ssh://", "git@")):
        raise ValueError("GRAPHOPPER_SOURCE_REPOSITORY must be an explicit repository locator")
    if values.get("GRAPHHOPPER_IMAGE") == values.get("GRAPHHOPPER_BUILD_OUTPUT_IMAGE"):
        raise ValueError("GRAPHHOPPER_IMAGE cannot be the mutable intermediate build output reference")
    for image_key, digest_key in (("OTP_IMAGE", "OTP_IMAGE_DIGEST"), ("GRAPHHOPPER_IMAGE", "GRAPHHOPPER_IMAGE_DIGEST")):
        image = values.get(image_key, "")
        digest = values.get(digest_key, "")
        if not (args.allow_placeholders and (PLACEHOLDER in image or PLACEHOLDER in digest)):
            try:
                if normalize_digest(image.rsplit("@", 1)[-1]) != normalize_digest(digest):
                    raise ValueError(f"{digest_key} must match {image_key}")
            except IdentityError:
                raise ValueError(f"{digest_key} must match {image_key}")
    print(f"runtime image references validated: {args.env_file}")
    return 0


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValueError(f"invalid env line in {path}: {line}")
        key, value = stripped.split("=", 1)
        values[key] = value
    return values


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"routing environment validation failed: {error}", file=sys.stderr)
        raise SystemExit(2)
