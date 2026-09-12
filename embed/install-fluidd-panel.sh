#!/usr/bin/env bash
# Install the ODrive Web UI and the Fluidd floating panel on a Klipper host
# (Raspberry Pi running Moonraker + Fluidd).
#
# What it does:
#   1. Installs MoonLighTingPY/odrive3.6_web_gui (release binary when the arch
#      matches, otherwise builds from source) as a systemd service on port 3000.
#   2. Finds the Fluidd web root and injects the floating-panel snippet into
#      its index.html, so a toggleable ODrive panel appears inside Fluidd.
#
# Usage:  sudo bash install-fluidd-panel.sh
# Re-run after a Fluidd update to re-patch index.html. Idempotent.
set -e

GUI_REPO="MoonLighTingPY/odrive3.6_web_gui"
GUI_DIR="$HOME/odrive-gui"
GUI_PORT=3000
SERVICE=odrive-gui
MARKER="odrive-panel.js"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)

echo "==> 1/4 ODrive Web UI"

if [ ! -d "$REAL_HOME/odrive-gui" ]; then
    mkdir -p "$GUI_DIR"
    # Try a prebuilt release binary first; fall back to building from source.
    ASSET_URL=$(curl -fsSL "https://api.github.com/repos/$GUI_REPO/releases/latest" \
        | grep -o '"browser_download_url": *"[^"]*odrive-gui[^"]*"' \
        | head -1 | cut -d'"' -f4 || true)
    ARCH=$(uname -m)
    if [ -n "$ASSET_URL" ] && [ "$ARCH" = "x86_64" ]; then
        echo "    downloading prebuilt binary"
        curl -fsSL "$ASSET_URL" -o "$GUI_DIR/odrive-gui"
        chmod +x "$GUI_DIR/odrive-gui"
        echo "server" > "$GUI_DIR/.install-mode"
    else
        echo "    no prebuilt binary for $ARCH, building from source (needs node18+/python3.10+)"
        apt-get update -qq && apt-get install -y -qq curl git build-essential
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y -qq nodejs
        git clone "https://github.com/$GUI_REPO.git" "$GUI_DIR/src"
        cd "$GUI_DIR/src"
        sudo -u "$REAL_USER" ./install.sh
        echo "source" > "$GUI_DIR/.install-mode"
    fi
fi
chown -R "$REAL_USER:" "$REAL_HOME/odrive-gui"

echo "==> 2/4 systemd service (port $GUI_PORT)"

MODE=$(cat "$GUI_DIR/.install-mode" 2>/dev/null || echo server)
if [ "$MODE" = "source" ]; then
    EXEC="/bin/bash -c 'cd $GUI_DIR/src/frontend && npm run dev'"
else
    EXEC="$GUI_DIR/odrive-gui"
fi
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=ODrive Web GUI (embedded panel backend)
After=network-online.target

[Service]
User=$REAL_USER
WorkingDirectory=$GUI_DIR
Environment=NO_BROWSER=1
ExecStart=$EXEC
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"

echo "==> 3/4 locate Fluidd web root"

FLUIDD_DIR=""
for d in "$REAL_HOME/fluidd" "$REAL_HOME/printer_data/fluidd" /usr/share/fluidd /var/www/fluidd; do
    if [ -f "$d/index.html" ] && grep -qi fluidd "$d/index.html" 2>/dev/null; then
        FLUIDD_DIR="$d"; break
    fi
done
if [ -z "$FLUIDD_DIR" ]; then
    FLUIDD_DIR=$(grep -rsl "index.html" /etc/moonraker* 2>/dev/null | head -1)
    echo "could not auto-locate the Fluidd web root; edit FLUIDD_DIR in this script."
    echo "(common paths: ~/fluidd, /usr/share/fluidd, /var/www/fluidd)"
    exit 1
fi
echo "    found: $FLUIDD_DIR"

echo "==> 4/4 inject floating panel into Fluidd"

cp "$(dirname "$0")/odrive-panel.js" "$FLUIDD_DIR/odrive-panel.js" 2>/dev/null \
    || curl -fsSL "https://raw.githubusercontent.com/yunyuancai/klipper-odrive-can/master/embed/odrive-panel.js" \
         -o "$FLUIDD_DIR/odrive-panel.js"
chown "$REAL_USER:" "$FLUIDD_DIR/odrive-panel.js"

if ! grep -q "$MARKER" "$FLUIDD_DIR/index.html"; then
    sed -i "s#</body>#<script src=\"./$MARKER\"></script></body>#" "$FLUIDD_DIR/index.html"
    echo "    patched index.html"
else
    echo "    index.html already patched"
fi

echo
echo "Done. Open Fluidd, use the blue 'OD' button in the bottom-right corner."
echo "The standalone panel also lives at http://$(hostname -I | awk '{print $1}'):$GUI_PORT"
echo "Re-run this script after a Fluidd update (it only re-patches index.html)."
