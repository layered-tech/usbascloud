#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root'; exit 1; }
cd -- "$(dirname -- "$0")"
apt-get update
apt-get install -y lvm2 exfatprogs fdisk
install -o root -g root -m 0755 blink_poc.py /usr/local/sbin/blink-poc
cat > /etc/systemd/system/blink-poc.service <<'EOF'
[Unit]
Description=Blink proof-of-concept USB disk
After=local-fs.target systemd-modules-load.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/blink-poc start
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/blink-poc-expire.service <<'EOF'
[Unit]
Description=Expire abandoned Pi storage snapshots
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/blink-poc snapshot-expire
EOF
cat > /etc/systemd/system/blink-poc-expire.timer <<'EOF'
[Unit]
Description=Check Pi snapshot leases
[Timer]
OnBootSec=60
OnUnitActiveSec=30
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now blink-poc-expire.timer
echo 'Installed. Storage has not yet been initialized or attached.'
