#!/usr/bin/env python3
"""Check local OTP and GraphHopper readiness without image utilities."""

from __future__ import annotations

import argparse
import json
import sys
import time
from urllib.parse import urlparse
from urllib.error import URLError
from urllib.request import Request, urlopen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--otp-url", default="http://127.0.0.1:8080/otp/actuators/health")
    parser.add_argument("--graphhopper-url", default="http://127.0.0.1:8989/health")
    parser.add_argument("--attempts", type=int, default=10)
    parser.add_argument("--delay-seconds", type=float, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=5)
    args = parser.parse_args()
    if args.attempts < 1 or args.delay_seconds < 0 or args.timeout_seconds <= 0:
        parser.error("attempts must be positive, delay non-negative, and timeout positive")
    try:
        validate_endpoint(args.otp_url, "/otp/actuators/health")
        validate_endpoint(args.graphhopper_url, "/health")
    except ValueError as error:
        print(f"routing readiness configuration failed: {error}", file=sys.stderr)
        return 2

    last_error = "not checked"
    for attempt in range(args.attempts):
        try:
            otp = get_json(args.otp_url, args.timeout_seconds)
            if not isinstance(otp, dict):
                raise RuntimeError("OTP readiness response is not a JSON object")
            if otp.get("status") != "UP":
                raise RuntimeError(f"OTP readiness status is {otp.get('status')!r}")
            graphhopper = get_json(args.graphhopper_url, args.timeout_seconds)
            if not isinstance(graphhopper, dict):
                raise RuntimeError("GraphHopper readiness response is not a JSON object")
            if graphhopper.get("status") != "UP":
                raise RuntimeError(f"GraphHopper readiness status is {graphhopper.get('status')!r}")
            print("OTP and GraphHopper are ready.")
            return 0
        except (OSError, URLError, RuntimeError, json.JSONDecodeError) as error:
            last_error = str(error)
            if attempt + 1 < args.attempts:
                time.sleep(args.delay_seconds)
    print(f"routing readiness failed after {args.attempts} attempts: {last_error}", file=sys.stderr)
    return 1


def get_json(url: str, timeout: float) -> object:
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    with urlopen(request, timeout=timeout) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        return json.loads(response.read(64 * 1024).decode("utf-8"))


def validate_endpoint(url: str, required_path: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError(f"readiness endpoint must be a credential-free HTTP(S) URL: {url}")
    if parsed.path != required_path:
        raise ValueError(f"readiness endpoint must be exactly {required_path}: {url}")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("HTTP readiness is limited to loopback; use an authenticated TLS proxy externally")


if __name__ == "__main__":
    raise SystemExit(main())
