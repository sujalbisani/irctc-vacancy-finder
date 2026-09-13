#!/usr/bin/env bash
# Sets up an isolated network namespace ("wgns") that routes ALL of its own
# traffic through a WireGuard VPN, with a SOCKS5 proxy inside it reachable
# from the host at 10.200.200.2:1080. The host's own default route/SSH is
# never touched -- this is scoped entirely to the namespace via a veth pair.
#
# Usage: sudo bash vpn-netns-up.sh /path/to/wg0.conf
set -euo pipefail

WG_CONF="${1:?Usage: $0 /path/to/wg0.conf}"
NS=wgns
HOST_IF=enp0s6
VETH_HOST=veth-h
VETH_NS=veth-n
HOST_IP=10.200.200.1
NS_IP=10.200.200.2

echo "==> Cleaning up any previous instance"
ip netns exec "$NS" pkill microsocks 2>/dev/null || true
ip netns exec "$NS" wg-quick down wg0 2>/dev/null || true
ip link del "$VETH_HOST" 2>/dev/null || true
ip netns del "$NS" 2>/dev/null || true

echo "==> Creating namespace and veth pair"
ip netns add "$NS"
ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
ip link set "$VETH_NS" netns "$NS"

ip addr add "$HOST_IP/24" dev "$VETH_HOST"
ip link set "$VETH_HOST" up

ip netns exec "$NS" ip addr add "$NS_IP/24" dev "$VETH_NS"
ip netns exec "$NS" ip link set "$VETH_NS" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip route add default via "$HOST_IP"

echo "==> Enabling forwarding + NAT so the namespace can reach the internet (to reach the VPN endpoint)"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -t nat -C POSTROUTING -s 10.200.200.0/24 -o "$HOST_IF" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 10.200.200.0/24 -o "$HOST_IF" -j MASQUERADE

# Oracle's stock image has a default-REJECT FORWARD chain (in addition to the
# default-REJECT INPUT chain) -- without these, the namespace's traffic never
# reaches the internet at all, silently.
iptables -C FORWARD -s 10.200.200.0/24 -o "$HOST_IF" -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 1 -s 10.200.200.0/24 -o "$HOST_IF" -j ACCEPT
iptables -C FORWARD -d 10.200.200.0/24 -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 2 -d 10.200.200.0/24 -m state --state ESTABLISHED,RELATED -j ACCEPT

# The host's default DNS (127.0.0.53, systemd-resolved's stub) is only
# reachable on the host's own loopback -- not from this namespace -- so give
# the namespace a real public resolver instead.
mkdir -p /etc/netns/$NS
echo 'nameserver 1.1.1.1' > /etc/netns/$NS/resolv.conf

echo "==> Bringing up WireGuard inside the namespace"
cp "$WG_CONF" /etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
ip netns exec "$NS" wg-quick up wg0

echo "==> Starting SOCKS5 proxy inside the namespace on ${NS_IP}:1080"
ip netns exec "$NS" sh -c 'nohup microsocks -i 10.200.200.2 -p 1080 >/tmp/microsocks.log 2>&1 &'
sleep 1

echo "==> Verifying: fetching ifconfig.me through the namespace"
ip netns exec "$NS" curl -s -m 10 https://ifconfig.me || echo "(curl inside namespace failed)"
echo
echo "==> Verifying: IRCTC reachability through the namespace"
ip netns exec "$NS" curl -s -o /dev/null -w 'IRCTC_HTTP:%{http_code}\n' -m 15 https://www.irctc.co.in/online-charts/ || true

echo "==> Done. SOCKS5 proxy available to the host at socks5://${NS_IP}:1080"
echo "Host's own default route is untouched -- run 'ip route' to confirm."
