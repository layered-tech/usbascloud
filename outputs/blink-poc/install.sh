#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root'; exit 1; }
cd -- "$(dirname -- "$0")"
apt-get update
apt-get install -y lvm2 exfatprogs fdisk avahi-daemon
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

install -d -m 0755 /etc/avahi/services
cat > /etc/avahi/services/usbcloud.service <<'EOF'
<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">USBCloud on %h</name>
  <service><type>_usbcloud._tcp</type><port>22</port><txt-record>version=0.3.1</txt-record><txt-record>auth=ssh-key</txt-record></service>
</service-group>
EOF
systemctl enable --now avahi-daemon

if [ -n "${USBCLOUD_PUBLIC_KEY_FILE:-}" ]; then
    test -f "$USBCLOUD_PUBLIC_KEY_FILE"
    install -d -o pi -g pi -m 0700 /home/pi/.ssh
    { printf 'restrict,command="/usr/local/sbin/blink-poc ssh-serve" '; cat "$USBCLOUD_PUBLIC_KEY_FILE"; } >> /home/pi/.ssh/authorized_keys
    chown pi:pi /home/pi/.ssh/authorized_keys
    chmod 0600 /home/pi/.ssh/authorized_keys
fi
