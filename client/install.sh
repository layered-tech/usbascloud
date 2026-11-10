#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root'; exit 1; }
cd -- "$(dirname -- "$0")"
apt-get update
apt-get install -y lvm2 exfatprogs fdisk avahi-daemon
install -o root -g root -m 0755 usbcloud_client.py /usr/local/sbin/usbcloud-client
cat > /etc/systemd/system/usbcloud-client.service <<'EOF'
[Unit]
Description=USBCloud client USB storage
After=local-fs.target systemd-modules-load.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/usbcloud-client start
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/usbcloud-client-expire.service <<'EOF'
[Unit]
Description=Expire abandoned Pi storage snapshots
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/usbcloud-client snapshot-expire
EOF
cat > /etc/systemd/system/usbcloud-client-expire.timer <<'EOF'
[Unit]
Description=Check Pi snapshot leases
[Timer]
OnBootSec=60
OnUnitActiveSec=30
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
# Keep existing forced SSH keys working during upgrades.
ln -sfn /usr/local/sbin/usbcloud-client /usr/local/sbin/blink-poc
systemctl disable blink-poc.service 2>/dev/null || true
systemctl disable --now blink-poc-expire.timer 2>/dev/null || true
systemctl enable usbcloud-client.service
systemctl enable --now usbcloud-client-expire.timer
echo 'Installed. Storage has not yet been initialized or attached.'

install -d -m 0755 /etc/avahi/services
cat > /etc/avahi/services/usbcloud.service <<'EOF'
<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">USBCloud on %h</name>
  <service><type>_usbcloud._tcp</type><port>22</port><txt-record>version=0.4.0</txt-record><txt-record>auth=ssh-key</txt-record></service>
</service-group>
EOF
systemctl enable --now avahi-daemon

if [ -n "${USBCLOUD_PUBLIC_KEY_FILE:-}" ]; then
    test -f "$USBCLOUD_PUBLIC_KEY_FILE"
    install -d -o pi -g pi -m 0700 /home/pi/.ssh
    { printf 'restrict,command="/usr/local/sbin/usbcloud-client ssh-serve" '; cat "$USBCLOUD_PUBLIC_KEY_FILE"; } >> /home/pi/.ssh/authorized_keys
    chown pi:pi /home/pi/.ssh/authorized_keys
    chmod 0600 /home/pi/.ssh/authorized_keys
fi
