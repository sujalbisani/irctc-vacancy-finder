#!/usr/bin/env bash
# Tears down the isolated VPN namespace created by vpn-netns-up.sh.
set -uo pipefail
ip netns exec wgns pkill microsocks 2>/dev/null || true
ip netns exec wgns wg-quick down wg0 2>/dev/null || true
ip link del veth-h 2>/dev/null || true
ip netns del wgns 2>/dev/null || true
echo "Torn down."
