#!/usr/bin/env python3
"""Run a small, introspection-checked paginated OTP 2.6 Relay query."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


INTROSPECTION_QUERY = """
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}
query InspectPlanConnection {
  __schema {
    queryType {
      fields {
        name
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
    }
    types {
      name
      kind
      inputFields { name type { ...TypeRef } }
      enumValues { name }
      fields { name }
    }
  }
}
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8080/otp/gtfs/v1")
    parser.add_argument("--origin-lat", type=float, default=48.1374)
    parser.add_argument("--origin-lon", type=float, default=11.5755)
    parser.add_argument("--destination-lat", type=float, default=48.1351)
    parser.add_argument("--destination-lon", type=float, default=11.5820)
    parser.add_argument("--date-time", default="2026-08-01T08:00:00+02:00")
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--page-size", type=int, default=1)
    args = parser.parse_args()
    if args.max_pages < 1 or args.page_size < 1:
        parser.error("max-pages and page-size must be positive")
    try:
        schema_response = post(args.endpoint, {"query": INTROSPECTION_QUERY})
        schema = schema_response["data"]["__schema"]
        field = find_plan_connection(schema)
        query, variables = build_query(schema, field, args)
        cursor = None
        pages = 0
        total_edges = 0
        reached_end = False
        while pages < args.max_pages:
            variables["after"] = cursor
            response = post(args.endpoint, {"query": query, "variables": variables})
            if response.get("errors"):
                raise RuntimeError(f"OTP planConnection returned errors: {response['errors']}")
            connection = response.get("data", {}).get("planConnection")
            if not isinstance(connection, dict):
                raise RuntimeError("OTP response omitted planConnection")
            page_info = connection.get("pageInfo")
            edges = connection.get("edges")
            if not isinstance(page_info, dict) or not isinstance(edges, list):
                raise RuntimeError("OTP planConnection response is not a Relay connection")
            routing_errors = connection.get("routingErrors")
            if isinstance(routing_errors, list) and routing_errors:
                raise RuntimeError(f"OTP planConnection returned routing errors: {routing_errors}")
            total_edges += len(edges)
            pages += 1
            if not page_info.get("hasNextPage"):
                reached_end = True
                break
            next_cursor = page_info.get("endCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                raise RuntimeError("OTP reported another page without an endCursor")
            cursor = next_cursor
        if not reached_end:
            raise RuntimeError("OTP fixture query exceeded the configured pagination gate")
        if total_edges == 0:
            raise RuntimeError("OTP fixture query returned no itinerary edges")
        print(f"OTP planConnection pagination passed: pages={pages} edges={total_edges}")
        return 0
    except (KeyError, OSError, HTTPError, URLError, RuntimeError, json.JSONDecodeError) as error:
        print(f"OTP paginated query failed: {error}", file=sys.stderr)
        return 2


def find_plan_connection(schema: dict[str, Any]) -> dict[str, Any]:
    fields = schema.get("queryType", {}).get("fields", [])
    for field in fields:
        if isinstance(field, dict) and field.get("name") == "planConnection":
            args = {item["name"]: item["type"] for item in field.get("args", [])}
            required = {"origin", "destination", "dateTime", "modes", "first", "after"}
            if not required.issubset(args):
                raise RuntimeError(f"OTP planConnection schema is missing pagination arguments: {sorted(required - set(args))}")
            expected = {
                "origin": "PlanLabeledLocationInput!",
                "destination": "PlanLabeledLocationInput!",
                "dateTime": "PlanDateTimeInput",
                "modes": "PlanModesInput",
                "first": "Int",
                "after": "String",
            }
            actual = {name: type_string(args[name]) for name in expected}
            if actual != expected:
                raise RuntimeError(f"OTP planConnection argument contract mismatch: expected={expected} actual={actual}")
            types = {
                item.get("name"): item
                for item in schema.get("types", [])
                if isinstance(item, dict) and item.get("name")
            }
            expected_input_fields = {
                "PlanModesInput": {"direct", "directOnly", "transit", "transitOnly"},
                "PlanTransitModesInput": {"access", "egress", "transfer", "transit"},
            }
            for type_name, field_names in expected_input_fields.items():
                actual_fields = {
                    item["name"]
                    for item in types.get(type_name, {}).get("inputFields", [])
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                }
                if actual_fields != field_names:
                    raise RuntimeError(
                        f"OTP {type_name} field contract mismatch: expected={sorted(field_names)} actual={sorted(actual_fields)}"
                    )
            date_time_fields = {
                item["name"]: type_string(item["type"])
                for item in types.get("PlanDateTimeInput", {}).get("inputFields", [])
                if isinstance(item, dict) and isinstance(item.get("name"), str) and item.get("type")
            }
            expected_date_time_fields = {
                "earliestDeparture": "OffsetDateTime",
                "latestArrival": "OffsetDateTime",
            }
            if date_time_fields != expected_date_time_fields:
                raise RuntimeError(
                    f"OTP PlanDateTimeInput field contract mismatch: expected={expected_date_time_fields} actual={date_time_fields}"
                )
            return {"field": field, "args": args}
    raise RuntimeError("OTP schema has no planConnection field at /otp/gtfs/v1")


def build_query(schema: dict[str, Any], plan: dict[str, Any], args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    del schema, plan
    variables = {
        "origin": {
            "label": "origin",
            "location": {
                "coordinate": {"latitude": args.origin_lat, "longitude": args.origin_lon},
            },
        },
        "destination": {
            "label": "destination",
            "location": {
                "coordinate": {"latitude": args.destination_lat, "longitude": args.destination_lon},
            },
        },
        "dateTime": {"earliestDeparture": args.date_time},
        "modes": {
            "transit": {
                "access": ["WALK"],
                "egress": ["WALK"],
                "transfer": ["WALK"],
                "transit": [
                    {"mode": "BUS"},
                    {"mode": "TRAM"},
                    {"mode": "SUBWAY"},
                    {"mode": "RAIL"},
                    {"mode": "GONDOLA"},
                    {"mode": "FERRY"},
                ],
            },
            "transitOnly": True,
        },
        "first": args.page_size,
        "after": None,
    }
    query = f"""
    query PaginatedPlanConnection(
      $origin: PlanLabeledLocationInput!,
      $destination: PlanLabeledLocationInput!,
      $dateTime: PlanDateTimeInput,
      $modes: PlanModesInput,
      $first: Int,
      $after: String
    ) {{
      planConnection(origin: $origin, destination: $destination, dateTime: $dateTime, modes: $modes, first: $first, after: $after) {{
        pageInfo {{ hasNextPage endCursor }}
        edges {{ cursor node {{ start end duration legs {{ mode start {{ scheduledTime estimated {{ time }} }} end {{ scheduledTime estimated {{ time }} }} duration from {{ name lat lon stop {{ gtfsId }} }} to {{ name lat lon stop {{ gtfsId }} }} route {{ gtfsId shortName longName mode }} headsign distance legGeometry {{ points }} }} }} }}
        routingErrors {{ code description }}
      }}
    }}
    """
    return query, variables


def type_string(type_ref: dict[str, Any]) -> str:
    kind = type_ref.get("kind")
    if kind == "NON_NULL":
        return f"{type_string(type_ref['ofType'])}!"
    if kind == "LIST":
        return f"[{type_string(type_ref['ofType'])}]"
    if not type_ref.get("name"):
        raise RuntimeError("OTP schema returned an unnamed argument type")
    return type_ref["name"]


def post(endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"OTP endpoint returned HTTP {response.status}")
        value = json.loads(response.read(512 * 1024).decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("OTP endpoint returned a non-object JSON response")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
