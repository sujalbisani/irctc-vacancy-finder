#!/usr/bin/env bash
# One-time setup for the IRCTC Vacancy Finder on a fresh Ubuntu VM
# (tested against Ubuntu 22.04/24.04, e.g. Oracle Cloud "Always Free" tier).
#
# IRCTC's anti-bot layer blocks headless Chromium specifically (confirmed by
# testing) but allows a normal, visible browser window. On a VM with no
# physical display, Xvfb provides a virtual one so Playwright can still run
# a real (non-headless) browser.
#
# Usage: run from the repo root on the VM, e.g.:
#   git clone <your-repo-url> irctc-vacancy-tool && cd irctc-vacancy-tool
#   bash server/deploy/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_USER="${SUDO_USER:-$USER}"

echo "==> Installing Node.js 20.x"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing Xvfb and Chromium's runtime dependencies"
sudo apt-get update
sudo apt-get install -y xvfb

echo "==> Installing server dependencies"
cd "$REPO_DIR/server"
npm install

echo "==> Installing Playwright's Chromium build and OS dependencies"
npx playwright install --with-deps chromium

echo "==> Building the client"
cd "$REPO_DIR/client"
npm install
npm run build

echo "==> Installing systemd service"
sudo tee /etc/systemd/system/irctc-vacancy.service > /dev/null <<EOF
[Unit]
Description=IRCTC Vacancy Finder
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}/server
Environment=PORT=4000
ExecStart=/usr/bin/xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" /usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now irctc-vacancy.service

echo "==> Done. Service status:"
sudo systemctl status irctc-vacancy.service --no-pager || true
echo
echo "App is listening on port 4000 on this machine."
echo "Open the firewall/security-list port 4000 (or put a reverse proxy like Caddy/Nginx with TLS in front of it on 443) to reach it from your phone."
echo "Logs: sudo journalctl -u irctc-vacancy.service -f"
