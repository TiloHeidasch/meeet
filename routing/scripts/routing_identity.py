"""Shared immutable image/digest identity normalization for routing tooling."""

from __future__ import annotations

import re
from dataclasses import dataclass


_DIGEST = re.compile(r"^(?:sha256:)?([a-f0-9]{64})$")
_IMAGE = re.compile(r"^(?P<repository>[^@\s]+)@(?P<digest>sha256:[a-f0-9]{64})$")


class IdentityError(ValueError):
    pass


@dataclass(frozen=True)
class ImageReference:
    repository: str
    digest: str

    @property
    def canonical(self) -> str:
        return f"{self.repository}@{self.digest}"


def normalize_digest(value: str) -> str:
    """Return every accepted bare or prefixed digest as sha256:<64hex>."""
    if not isinstance(value, str):
        raise IdentityError("digest must be a string")
    match = _DIGEST.fullmatch(value.strip())
    if not match:
        raise IdentityError("digest must be 64 lowercase hex characters, with optional sha256: prefix")
    return f"sha256:{match.group(1)}"


def digest_hex(value: str) -> str:
    return normalize_digest(value).removeprefix("sha256:")


def parse_image_reference(value: str) -> ImageReference:
    if not isinstance(value, str):
        raise IdentityError("image reference must be a string")
    match = _IMAGE.fullmatch(value.strip())
    if not match:
        raise IdentityError("image must be repository@sha256:<64 lowercase hex>")
    return ImageReference(match.group("repository"), normalize_digest(match.group("digest")))


def parse_repository_digest(value: str) -> ImageReference:
    """Parse Docker's repository@digest form without comparing it to a bare digest."""
    return parse_image_reference(value)
