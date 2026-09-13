#!/usr/bin/env bash
# Sets up an isolated network namespace ("tsns") running its own Tailscale
# daemon (separate state/socket from any host-level tailscaled), routing only
# its own traffic through a Tailscale exit node. A SOCKS5 proxy inside it is
# reachable from the host at 10.200.201.2:1080. The host's own default
# route/SSH is never touched -- scoped entirely via a veth pair.
#
# Usage: sudo bash ts-netns-up.sh <exit-node-name-or-ip>
set -euo pipefail

EXIT_NODE="${1:?Usage: $0 <exit-node-name-or-ip>}"
NS=tsns
HOST_IF=enp0s6
VETH_HOST=veth-ts-h
VETH_NS=veth-ts-n
HOST_IP=10.200.201.1
NS_IP=10.200.201.2
TS_STATE_DIR=/var/lib/tailscale-ns
TS_SOCK=/var/run/tailscale-ns.sock

echo "==> Making sure host-level tailscaled is not running (avoid any full-tunnel risk on the host)"
systemctl disable --now tailscaled 2>/dev/null || true

echo "==> Cleaning up any previous instance"
ip netns exec "$NS" pkill microsocks 2>/dev/null || true
if ip netns exec "$NS" test -S "$TS_SOCK" 2>/dev/null; then
  ip netns exec "$NS" tailscale --socket="$TS_SOCK" down 2>/dev/null || true
fi
pkill -f "tailscaled.*$TS_SOCK" 2>/dev/null || true
sleep 1
ip link del "$VETH_HOST" 2>/dev/null || true
ip netns del "$NS" 2>/dev/null || true

echo "==> Creating namespace and veth pair"
mkdir -p "$TS_STATE_DIR"
ip netns add "$NS"
ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
ip link set "$VETH_NS" netns "$NS"

ip addr add "$HOST_IP/24" dev "$VETH_HOST"
ip link set "$VETH_HOST" up

ip netns exec "$NS" ip addr add "$NS_IP/24" dev "$VETH_NS"
ip netns exec "$NS" ip link set "$VETH_NS" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip route add default via "$HOST_IP"

echo "==> Enabling forwarding + NAT + FORWARD/INPUT accept for this namespace"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -t nat -C POSTROUTING -s 10.200.201.0/24 -o "$HOST_IF" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 10.200.201.0/24 -o "$HOST_IF" -j MASQUERADE
iptables -C FORWARD -s 10.200.201.0/24 -o "$HOST_IF" -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 1 -s 10.200.201.0/24 -o "$HOST_IF" -j ACCEPT
iptables -C FORWARD -d 10.200.201.0/24 -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  iptables -I FORWARD 2 -d 10.200.201.0/24 -m state --state ESTABLISHED,RELATED -j ACCEPT
# The host's own default-REJECT INPUT chain also blocks the host from
# reaching into the namespace (e.g. the SOCKS5 proxy) unless explicitly
# allowed -- this is separate from the FORWARD rules above.
iptables -C INPUT -s 10.200.201.0/24 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT 5 -s 10.200.201.0/24 -j ACCEPT

mkdir -p "/etc/netns/$NS"
echo 'nameserver 1.1.1.1' > "/etc/netns/$NS/resolv.conf"

echo "==> Starting an isolated tailscaled inside the namespace"
ip netns exec "$NS" tailscaled \
  --state="$TS_STATE_DIR/tailscaled.state" \
  --socket="$TS_SOCK" \
  --tun=ts-ns0 \
  > "$TS_STATE_DIR/tailscaled.log" 2>&1 &
sleep 2

echo "==> Bringing up Tailscale (this namespace only) with exit node: $EXIT_NODE"
# --accept-dns=false is required: even though tailscaled runs inside this
# network namespace, its resolv.conf writer uses an atomic rename() that
# escapes the /etc/netns bind-mount and overwrites the HOST's real
# /etc/resolv.conf with Tailscale's MagicDNS servers, breaking all normal
# DNS resolution on the VPS host (confirmtkt, npm, apt, etc). We already
# provide DNS for this namespace's own traffic via /etc/netns/$NS/resolv.conf
# above, so the namespace doesn't need Tailscale's MagicDNS anyway.
ip netns exec "$NS" tailscale --socket="$TS_SOCK" up \
  --exit-node="$EXIT_NODE" \
  --exit-node-allow-lan-access=false \
  --hostname=irctc-vps-ns \
  --accept-routes \
  --accept-dns=false

echo "==> Tailscale status inside namespace:"
ip netns exec "$NS" tailscale --socket="$TS_SOCK" status

# Belt-and-suspenders: guarantee the HOST's real DNS config is sane
# regardless of what the namespaced tailscaled did above. Oracle's metadata
# service (169.254.169.254) is always reachable from the host directly.
if ! grep -q '^nameserver 169.254.169.254$' /etc/resolv.conf 2>/dev/null || grep -qi tailscale /etc/resolv.conf 2>/dev/null; then
  echo "==> Host /etc/resolv.conf was hijacked -- restoring it"
  chattr -i /etc/resolv.conf 2>/dev/null || true
  rm -f /etc/resolv.conf
  printf 'nameserver 169.254.169.254\n' > /etc/resolv.conf
fi

# Tailscale's own routing setup sometimes mirrors our directly-connected veth
# subnet into ITS OWN table pointed at the tunnel interface instead of the
# real local link -- this breaks host<->namespace traffic (e.g. reaching the
# SOCKS5 proxy below) even though internet-bound traffic works fine. Force it
# back to the correct local route.
ip netns exec "$NS" ip route replace 10.200.201.0/24 dev "$VETH_NS" table 52 2>/dev/null || true

echo "==> Starting SOCKS5 proxy inside the namespace on ${NS_IP}:1080"
ip netns exec "$NS" sh -c 'nohup microsocks -i 10.200.201.2 -p 1080 >/tmp/microsocks-ts.log 2>&1 &'
sleep 1

echo "==> Verifying: outbound IP through the namespace"
ip netns exec "$NS" curl -s -m 10 https://ifconfig.me || echo "(curl failed)"
echo
echo "==> Verifying: SOCKS5 proxy reachable from host"
curl -s --socks5-hostname "${NS_IP}:1080" -m 10 -o /dev/null -w 'proxy reachable from host: HTTP %{http_code}\n' https://ifconfig.me || true
echo "(Note: a plain curl through this proxy to irctc.co.in itself will still show blocked/000 --"
echo " that's expected, curl's own client fingerprint gets flagged regardless of IP. Only a real"
echo " browser, e.g. via Playwright with IRCTC_PROXY_SERVER=socks5://${NS_IP}:1080, gets through.)"

echo "==> Done. SOCKS5 proxy available to the host at socks5://${NS_IP}:1080"
