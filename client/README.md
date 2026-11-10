# USBCloud Client

Install a Raspberry Pi Zero 2 W from **Add device** with one command. The installer
sets up USB device mode, system packages, restricted SSH access, sudo permissions,
USB storage, host-key trust on the backend, and automatic health reporting.

## 1. Prepare the Pi

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to write
**Raspberry Pi OS Lite (64-bit)** to a **64 GB or larger** microSD card. Imaging
erases the card, including recordings and any previous USBCloud installation;
clips already archived on your NAS are separate.

In Imager, choose a hostname, a non-root username and password (or administrator
SSH key), configure your 2.4 GHz Wi-Fi and country, and enable SSH. The username
can be `pi` or another account you choose. Keep that administrator login for
maintenance; USBCloud uses its own restricted SSH key.

Boot the Pi using **PWR IN**, with the **USB data cable disconnected**. Find its
address in your router and reserve it in DHCP. The Pi must reach your USBCloud
backend, and the backend must reach the Pi on SSH port **22**.

## 2. Run the installer

1. In USBCloud, open **Add device**.
2. Enter the Pi's hostname or IP, its username from Imager, and an optional name.
   Leave **Client is already installed** unchecked.
3. Select **Generate installation command**, then **Copy installation command**.
4. Open a terminal on the Pi, either locally or with `ssh YOUR_USER@PI_IP`, and
   paste the command. Enter the Pi user's sudo password if prompted.
5. Accept the installer's reboot prompt. After the Pi boots, connect a data-capable
   cable from its **USB data port** to the USB host.

No repository clone, manual boot-file edits, public-key copying, sudoers edits,
`init` command, or unRAID host-key enrollment is needed. The setup command uses
the backend's own copy of the client, so deploy the updated backend first.

The command is private, expires after 24 hours, and is bound to the first Pi host
key that uses it. You can rerun the same command to recover from an interrupted
installation. It preserves existing storage and recordings and refuses to format
an incomplete or unexpected existing filesystem. The installer backs up the
original boot configuration as `config.txt.usbcloud-backup` and offers a reboot
when boot changes are needed. It supports Raspberry Pi Zero 2 W with Raspberry Pi
OS, apt, and systemd.

Fresh storage uses a **20 GiB pool file**, exposing an **8 GiB exFAT USB disk** and
reserving the remaining pool space for snapshots. At least **24 GiB free** is
required before setup. Existing and legacy client storage paths are retained.

The device appears in the fleet during installation. Once health setup succeeds,
**Device health → Status source** shows **API heartbeat**. USB storage becomes
available after the reboot. For a Blink Sync Module, use the Blink app to
recognize/format the disk if requested, make a recording, then select **Pull now**
in USBCloud to verify that it is archived and playable.

## Network and trust

Set the backend's `APP_URL` to an address reachable from the Pi (or set
`USBCLOUD_HEARTBEAT_URL` to a client-reachable base URL). The installer downloads
from that address. HTTPS needs a trusted certificate; redirects are not followed.
Use HTTPS or a trusted local network for setup. The dashboard itself assumes a
trusted network, so protect access at your reverse proxy when needed.

The installer receives the backend's public key and registers the Pi's own
Ed25519 host key using the setup token. The backend pins that key in persistent
storage and continues to require strict SSH host-key checking. Its private SSH
key never leaves the backend. The Pi authorizes it only for USBCloud operations,
not an interactive shell or storage initialization.

Your administrator SSH connection is separate: accept only a Pi host key you
trust. Reimaging changes that key, so an old saved administrator SSH entry may
need to be replaced. The installer handles trust for **backend-to-Pi** connections;
it cannot change your computer's SSH trust before you first connect.

## Updates and troubleshooting

For an already installed client, update your repository checkout on the Pi and run:

```sh
sudo bash client/install.sh --update
```

This updates the client and services while preserving recordings and registration.
Do not run `usbcloud-client init` again. If you reimage a registered Pi, remove the
old device from the dashboard and generate a new installation command. Archived
media remains on the backend.

- **Setup command expired:** generate another command. If the Pi already appeared
  in the fleet during a partial installation, remove that entry first.
- **Backend unreachable:** check the URL, Wi-Fi, DNS, port, certificate, and network
  isolation. A `.test` development hostname usually is not reachable from the Pi.
- **User not found:** enter the username chosen in Imager and generate a new command.
- **Not enough space:** use a larger card or let the OS finish expanding its root
  filesystem before retrying.
- **Existing storage incomplete:** the installer stops without formatting it. Inspect
  the existing pool before attempting recovery; do not delete it if it contains clips.
- **Online but USB storage unavailable:** finish the reboot and check the data cable.
- **Online but pulls fail:** verify the backend can reach the address entered in
  Add device on port 22; heartbeats alone only prove Pi-to-backend connectivity.

For diagnostics on the Pi:

```sh
sudo systemctl status usbcloud-client.service usbcloud-heartbeat.service --no-pager
sudo journalctl -u usbcloud-client.service -u usbcloud-heartbeat.service -n 50 --no-pager
```

Health reports arrive every 30 seconds; after 90 seconds without a report the
backend marks the device offline. Fresh client state lives in
`/var/lib/usbcloud-client` and snapshots in `/srv/usbcloud-client/snapshot`.
In the backend container, settings and pinned host keys persist in `/data`, the
database in `/database`, and archives in `/archive`.
