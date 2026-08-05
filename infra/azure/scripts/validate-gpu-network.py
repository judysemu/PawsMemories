#!/usr/bin/env python3
"""Fail closed before Azure creates a regional GPU lane with overlapping CIDRs."""

from __future__ import annotations

import argparse
import ipaddress
import json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core-vnet-prefixes-json", required=True)
    parser.add_argument("--core-subnet-prefix", required=True)
    parser.add_argument("--gpu-vnet-prefix", required=True)
    parser.add_argument("--gpu-subnet-prefix", required=True)
    parser.add_argument("--gpu-private-ip", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    decoded = json.loads(args.core_vnet_prefixes_json)
    if not isinstance(decoded, list) or not decoded or not all(isinstance(value, str) for value in decoded):
        raise SystemExit("Existing core VNet returned no valid address prefixes")

    core_vnets = [ipaddress.ip_network(value, strict=True) for value in decoded]
    core_subnet = ipaddress.ip_network(args.core_subnet_prefix, strict=True)
    gpu_vnet = ipaddress.ip_network(args.gpu_vnet_prefix, strict=True)
    gpu_subnet = ipaddress.ip_network(args.gpu_subnet_prefix, strict=True)
    gpu_ip = ipaddress.ip_address(args.gpu_private_ip)

    if not any(core_subnet.subnet_of(network) for network in core_vnets):
        raise SystemExit("Configured core subnet is outside the existing core VNet")
    if any(network.overlaps(gpu_vnet) for network in core_vnets):
        raise SystemExit("Core and GPU VNet address spaces overlap")
    if not gpu_subnet.subnet_of(gpu_vnet):
        raise SystemExit("GPU subnet is not contained by the GPU VNet")
    if gpu_ip not in gpu_subnet or gpu_ip in {gpu_subnet.network_address, gpu_subnet.broadcast_address}:
        raise SystemExit("GPU private IP is not a usable address inside the GPU subnet")


if __name__ == "__main__":
    main()
