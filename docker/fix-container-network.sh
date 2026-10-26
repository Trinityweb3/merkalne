#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Merklane — container outbound-network doctor (run on the HOST, not inside a
# container; use sudo).
#
#   sudo bash docker/fix-container-network.sh           # diagnose only
#   sudo bash docker/fix-container-network.sh --fix     # diagnose + repair
#
# Symptom it addresses: app/worker containers on merklane-net cannot reach
# the outside world — Resend (api.resend.com), OAuth (oauth2.googleapis.com,
# github.com) fail with ConnectionRefused or hang — while the same requests
# from the host work fine. Build-time `network: host` masked this for image
# builds; runtime containers use the bridge and hit it.
#
# The four classic root causes, in order of likelihood on Arch/iptables-nft:
#   1. Firewall (ufw / firewalld / raw nftables) flushing or bypassing
#      Docker's iptables rules — FORWARD chain drops/rejects bridge traffic,
#      or the nat POSTROUTING MASQUERADE rule is gone. A REJECT rule is what
#      surfaces as "Connection refused" (not a timeout).
#   2. net.ipv4.ip_forward disabled (some hardening guides switch it off).
#   3. Broken DNS path: host resolv.conf points at a loopback stub
#      (systemd-resolved 127.0.0.53) the container cannot reach.
#      (Mitigated by the `dns: [1.1.1.1, 8.8.8.8]` entries in
#      docker-compose.yml — this script verifies they took effect.)
#   4. Stale network/bridge state after firewall or Docker upgrades —
#      fixed by recreating the network (compose down/up) or restarting the
#      Docker daemon, which re-applies its rules.
#
# `--fix` touches ONLY: ip_forward sysctl (+persistence), ufw forward
# policy, missing DOCKER-chain FORWARD/MASQUERADE rules (inserted at the top
# of the chains), and offers a Docker daemon restart + stack recreate. It
# never edits your other firewall rules. If the bridge still refuses after
# --fix, use docker-compose.egress.yml (runtime host networking) — see the
# README section "Runtime containers cannot reach the internet".
# ---------------------------------------------------------------------------
set -u

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  [OK]    %s\n' "$*"; }
bad()  { printf '  [FAIL]  %s\n' "$*"; }
note() { printf '  [note]  %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo bash $0)" >&2
  exit 1
fi

echo "Merklane container network doctor"
echo "================================="
echo

# --- 0. locate the compose project -----------------------------------------
cd "$(dirname "$0")/.." || exit 1
PROJECT_DIR="$(pwd)"
NET_NAME="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -m1 'merklane' || true)"
if [ -z "${NET_NAME}" ]; then
  NET_NAME="merklane_merklane-net"
fi
say "project dir : ${PROJECT_DIR}"
say "docker net  : ${NET_NAME}"
echo

# --- 1. ip_forward -----------------------------------------------------------
echo "1) Kernel IP forwarding"
IPFWD="$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo '?')"
if [ "${IPFWD}" = "1" ]; then
  ok "net.ipv4.ip_forward = 1"
else
  bad "net.ipv4.ip_forward = ${IPFWD} (must be 1 for bridge egress)"
  if [ "${FIX}" = "1" ]; then
    if sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; then
      printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-merklane-ip-forward.conf
      ok "enabled ip_forward now and persisted via /etc/sysctl.d/99-merklane-ip-forward.conf"
    else
      bad "could not enable ip_forward automatically"
    fi
  else
    note "fix: sysctl -w net.ipv4.ip_forward=1  (persist: /etc/sysctl.d/*.conf)"
  fi
fi
echo

# --- 2. Docker's NAT / FORWARD rules ----------------------------------------
echo "2) Docker iptables rules (nat POSTROUTING + FORWARD)"
BRIDGE="$(docker network inspect "${NET_NAME}" --format '{{(index .Options "com.docker.network.bridge.name")}}' 2>/dev/null || true)"
BRIDGE_SUBNET="$(docker network inspect "${NET_NAME}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)"
# User-defined networks use br-<id> when no explicit bridge name is set.
if [ -z "${BRIDGE}" ] && [ -n "${NET_NAME}" ]; then
  NET_ID="$(docker network inspect "${NET_NAME}" --format '{{.Id}}' 2>/dev/null | cut -c1-12)"
  [ -n "${NET_ID}" ] && BRIDGE="br-${NET_ID}"
fi
say "bridge      : ${BRIDGE:-unknown} (${BRIDGE_SUBNET:-unknown subnet})"

IPT=""
if have iptables; then IPT="iptables"; fi
if [ -n "${IPT}" ]; then
  MASQ="$(iptables -t nat -S POSTROUTING 2>/dev/null | grep -c 'MASQUERADE')"
  if [ "${MASQ}" -gt 0 ]; then
    ok "nat POSTROUTING has ${MASQ} MASQUERADE rule(s)"
  else
    bad "no MASQUERADE rule in nat POSTROUTING — container traffic leaves with a private source IP and never returns"
    if [ "${FIX}" = "1" ] && [ -n "${BRIDGE_SUBNET}" ]; then
      if iptables -t nat -I POSTROUTING 1 -s "${BRIDGE_SUBNET}" ! -o docker0 -j MASQUERADE 2>/dev/null; then
        ok "inserted MASQUERADE for ${BRIDGE_SUBNET} at the top of nat POSTROUTING"
        note "this rule is NOT persistent — a docker restart re-applies Docker's own rules; if the issue returns after reboot, find out which service flushes them (firewalld/ufw reload ordering)"
      else
        bad "could not insert the MASQUERADE rule automatically"
      fi
    else
      note "fix: iptables -t nat -I POSTROUTING 1 -s ${BRIDGE_SUBNET:-<subnet>} ! -o docker0 -j MASQUERADE  (or simply: systemctl restart docker)"
    fi
  fi

  FWD_POLICY="$(iptables -S FORWARD 2>/dev/null | head -1 | awk '{print $3}')"
  FORWARD_BROKEN=0
  if [ "${FWD_POLICY}" = "ACCEPT" ] || [ "${FWD_POLICY}" = "" ]; then
    ok "FORWARD chain policy: ${FWD_POLICY:-ACCEPT}"
  else
    bad "FORWARD chain policy: ${FWD_POLICY} — forwarded bridge traffic is dropped/rejected (this is the usual 'Connection refused' cause)"
    FORWARD_BROKEN=1
  fi
  REJECTS="$(iptables -S FORWARD 2>/dev/null | grep -ci 'reject' || true)"
  [ "${REJECTS}" = "0" ] && ok "no REJECT rules in FORWARD" || { note "${REJECTS} REJECT rule(s) in FORWARD — a REJECT before Docker's ACCEPTs is exactly 'Connection refused'"; FORWARD_BROKEN=1; }

  if [ "${FORWARD_BROKEN}" = "1" ]; then
    if [ "${FIX}" = "1" ] && [ -n "${BRIDGE}" ]; then
      # Insert permissive rules for the compose bridge at the TOP of FORWARD,
      # ahead of any firewall REJECT/DROP. Docker's own chains (DOCKER-USER,
      # DOCKER) are consulted in the FORWARD chain; inserting before them is
      # safe for outbound egress (the DOCKER chain mostly governs inbound).
      if iptables -I FORWARD 1 -i "${BRIDGE}" -j ACCEPT 2>/dev/null \
         && iptables -I FORWARD 1 -o "${BRIDGE}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
        ok "inserted egress ACCEPT rules for ${BRIDGE} at the top of FORWARD"
        note "these rules are NOT persistent across reboot — prefer fixing the source (ufw forward policy below / firewalld + docker restart ordering)"
      else
        bad "could not insert FORWARD rules automatically — try: systemctl restart docker"
      fi
    else
      note "fix (quick): iptables -I FORWARD 1 -i ${BRIDGE:-<bridge>} -j ACCEPT && iptables -I FORWARD 1 -o ${BRIDGE:-<bridge>} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
      note "fix (proper): ufw -> DEFAULT_FORWARD_POLICY=\"ACCEPT\" in /etc/default/ufw && ufw reload"
      note "             firewalld -> allow the docker bridges in your zone, then systemctl restart docker (docker re-applies its rules LAST)"
    fi
  fi
else
  note "iptables not found — skipping rule inspection (nftables-native? inspect manually)"
fi
echo

# --- 3. firewall managers ----------------------------------------------------
echo "3) Firewall managers"
if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "ufw is ACTIVE"
  if [ -f /etc/default/ufw ]; then
    if grep -q 'DEFAULT_FORWARD_POLICY="ACCEPT"' /etc/default/ufw; then
      ok "ufw DEFAULT_FORWARD_POLICY=ACCEPT"
    else
      bad "ufw DEFAULT_FORWARD_POLICY is not ACCEPT — forwarded container traffic is dropped"
      if [ "${FIX}" = "1" ]; then
        sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw && ufw reload \
          && ok "set DEFAULT_FORWARD_POLICY=ACCEPT and reloaded ufw" \
          || bad "could not update ufw policy automatically"
      else
        note "fix: sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY=\"ACCEPT\"/' /etc/default/ufw && ufw reload"
      fi
    fi
  fi
else
  ok "ufw inactive or absent"
fi
if have firewall-cmd && firewall-cmd --state 2>/dev/null | grep -q running; then
  bad "firewalld is running — it frequently wins the race for Docker's rules after reloads"
  note "fix: systemctl restart docker AFTER any firewalld reload (re-applies Docker's iptables rules)"
  if [ "${FIX}" = "1" ]; then
    note "--fix does not touch firewalld automatically; run: systemctl restart docker"
  fi
else
  ok "firewalld inactive or absent"
fi
echo

# --- 4. host DNS context ------------------------------------------------------
echo "4) Host DNS context"
if grep -q '^nameserver 127\.' /etc/resolv.conf 2>/dev/null; then
  note "host resolv.conf points at a loopback stub (systemd-resolved). Docker usually compensates; the pinned dns: 1.1.1.1/8.8.8.8 in docker-compose.yml removes the dependency."
else
  ok "host resolv.conf uses a real upstream"
fi
echo

# --- 5. live probe from inside the network -----------------------------------
echo "5) Live probe from a container on ${NET_NAME}"
probe() {
  # $1 = label, $2 = bun -e expression
  docker compose exec -T app bun -e "$2" >/dev/null 2>&1 && ok "$1" || bad "$1"
}
if docker compose ps --status running 2>/dev/null | grep -q app; then
  probe "DNS resolves inside the app container (api.resend.com)" \
    "const d=require('dns');d.promises.lookup('api.resend.com').then(()=>process.exit(0)).catch(()=>process.exit(1))"
  probe "TCP/TLS reaches api.resend.com from the app container" \
    "fetch('https://api.resend.com',{method:'HEAD'}).then(r=>process.exit(0)).catch(()=>process.exit(1))"
  probe "TCP/TLS reaches oauth2.googleapis.com from the app container" \
    "fetch('https://oauth2.googleapis.com',{method:'HEAD'}).then(r=>process.exit(0)).catch(()=>process.exit(1))"
  probe "TCP/TLS reaches github.com from the app container" \
    "fetch('https://github.com',{method:'HEAD'}).then(r=>process.exit(0)).catch(()=>process.exit(1))"
else
  note "app container not running — start the stack first (docker compose up -d), then re-run this script for live probes"
fi
echo

# --- 6. verdict ---------------------------------------------------------------
echo "What to do, in order:"
say "a) apply any [FAIL] fixes printed above (or re-run with --fix)"
say "b) restart the Docker daemon so it re-applies its iptables rules:"
say "     systemctl restart docker"
say "c) recreate the stack so containers pick up the new network config:"
say "     cd ${PROJECT_DIR} && docker compose down && docker compose up -d"
say "d) still broken after that? The bridge path is being blocked by something"
say "   host-specific (exotic nftables, VPN MTU, security modules). Use the"
say "   guaranteed escape hatch — runtime host networking:"
say "     docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d"
say "   (docker-compose.egress.yml ships in this repo; app+worker then use the"
say "   host network exactly like the build phase already does.)"
echo
[ "${FIX}" = "1" ] && say "(--fix mode was used: safe fixes above were applied where possible)"
exit 0
