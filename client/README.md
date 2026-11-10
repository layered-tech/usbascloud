# USBCloud Client

This guide starts with a freshly imaged Raspberry Pi Zero 2 W and ends with a
registered device sending health reports to a running USBCloud backend. The Pi
provides USB storage to the USB host; the backend archives clips and displays
health. The backend runs separately, for example in Docker on unRAID.

## 1. Reimage the SD card

Reimaging erases the entire selected card, including Raspberry Pi OS, Wi-Fi
settings, SSH keys, USBCloud registration and recordings stored on the Pi.
Previously archived clips on the NAS are separate and are not erased.

1. Shut down the Pi (`sudo poweroff`), disconnect power and the USB data cable,
   and put its microSD card into a card reader.
2. Open [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
3. Choose **Raspberry Pi Zero 2 W**, **Raspberry Pi OS Lite (64-bit)**, and the
   microSD card. Check the selected storage device before writing. A 64 GB or
   larger card is recommended for the current storage allocation.
4. In Imager's OS customisation settings, configure:
    - A unique hostname, such as `usbcloud-pi`.
    - Username **`pi`** and an administrator password. The current installer uses
      this account for the backend's restricted SSH key.
    - Your **primary Wi-Fi**, its password, wireless country and timezone. The
      Zero 2 W needs a 2.4 GHz network. Do not use an isolated guest network.
    - SSH enabled, with your administrator SSH public key or password login for
      initial setup. The NAS backend gets a separate, restricted key later.
5. Write and verify the image, eject the card, and put it into the Pi.
6. Power the Pi through **PWR IN**, leaving its **USB data port disconnected**
   from the USB host until storage is configured. Allow first boot to finish.

These steps follow Raspberry Pi's [headless installation guide](https://www.raspberrypi.com/documentation/computers/getting-started.html).
They do not require changing your computer's Wi-Fi connection or settings.

## 2. Connect and verify the network

Find the Pi's new IP address in your router's device list. Reserve that address
in DHCP so the backend can continue reaching it. This guide uses `PI_IP` as a
placeholder: replace it with that address in commands and in the dashboard.

From your administrator terminal:

```sh
ssh pi@PI_IP
```

A reimage creates new SSH host keys. If the old hostname/IP has a saved key,
verify the new fingerprint on the Pi's local console before removing the old
entry on the connecting machine:

```sh
# Run on the Pi's local console to display its fingerprint.
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Accept the verified key when connecting; do not disable host-key checking.

The remaining Pi commands run in its SSH session. Set the backend URL to the
same client-reachable address configured as `APP_URL` in the NAS container:

```sh
BACKEND_URL=http://NAS_IP:8088
curl --fail --connect-timeout 5 "$BACKEND_URL/up"
```

Expect HTTP success. The Pi must reach the backend's API port, and the backend
must reach the Pi's SSH port (22). Resolve network isolation before continuing.
A successful connection from your computer alone does not verify this.

## 3. Enable the USB device controller

On the freshly installed Pi, edit `/boot/firmware/config.txt`:

```sh
sudo nano /boot/firmware/config.txt
```

Add the following at the end, under an `[all]` section. Avoid conflicting active
`dwc2` overlays:

```ini
[all]
dtoverlay=dwc2,dr_mode=peripheral
```

Load the controller at boot, then reboot:

```sh
printf 'dwc2\n' | sudo tee /etc/modules-load.d/usbcloud-client.conf
sudo reboot
```

Reconnect over Wi-Fi and check that a USB device controller is present:

```sh
ls /sys/class/udc
```

Expect a controller name. Do not configure `g_ether` or another USB gadget;
USBCloud loads the mass-storage gadget itself. See Raspberry Pi's
[USB OTG configuration guide](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP-1-Using%20OTG%20mode%20on%20Raspberry%20Pi%20SBCs).

## 4. Install the client and authorize the NAS

On the Pi:

```sh
sudo apt-get update
sudo apt-get install -y git python3 curl
git clone https://github.com/layered-tech/usbascloud.git ~/usbcloud
cd ~/usbcloud/client
```

In the NAS dashboard, open **Add device**, expand **Server public key for client
setup**, and copy the public key. Do not finish adding the device yet.

On the Pi, create a file and paste that one public-key line into it:

```sh
nano ~/usbcloud-backend.pub
```

Install the client with that key:

```sh
sudo env USBCLOUD_PUBLIC_KEY_FILE="$HOME/usbcloud-backend.pub" bash install.sh
```

The installer installs dependencies and services and adds the NAS key to
`/home/pi/.ssh/authorized_keys` with a forced USBCloud command. Keep your separate
administrator key/login: the backend key does not permit an interactive shell
or storage initialization. Never copy the backend's private key to the Pi.

Allow the client command to run through noninteractive sudo:

```sh
printf 'pi ALL=(root) NOPASSWD: /usr/local/sbin/usbcloud-client *\n' | sudo tee /etc/sudoers.d/usbcloud-client
sudo chmod 0440 /etc/sudoers.d/usbcloud-client
sudo visudo -cf /etc/sudoers.d/usbcloud-client
```

Do not continue if validation reports an error. The SSH forced-command handler
also checks the allowed operations and rejects shell commands and `init`.

## 5. Initialize and attach USB storage

The client currently allocates a **20 GiB pool file**, exposes an **8 GiB exFAT
USB disk**, and reserves space for read-only snapshots. It needs at least
**24 GiB free** before initialization. This is a fixed allocation in client 0.4.0.

On the Pi, with the USB data cable still disconnected:

```sh
df -h /var/lib
sudo usbcloud-client init
sudo systemctl start usbcloud-client.service
sudo -n usbcloud-client status
```

`init` runs once on fresh storage and refuses to overwrite an existing pool.
The status should include `gadget_loaded: true` and `version: 0.4.0`. The client
service starts automatically on subsequent boots. Until a USB host is connected,
the USB controller may report a state other than `configured`.

Connect a data-capable cable from the Pi's **USB data port** to the USB host.
Keep PWR IN connected to its power supply. If the host is a Blink Sync Module,
use its app to recognize/format the new drive as required, then make a test
recording. Never mount or modify the live exported filesystem from Linux.

## 6. Enroll the Pi's host key on the NAS

The backend's SSH identity and its trusted device host keys are different:
step 4 authorizes the backend on the Pi; this step verifies the Pi to the backend.

In the **unRAID host terminal**, substitute `PI_IP` below. `USBCloud` is the
container name from the supplied template; adjust it if you renamed it.

```sh
docker exec -it --user www-data USBCloud \
  ssh -i /data/app/private/usbcloud/ssh/id_ed25519 \
  -o IdentitiesOnly=yes -o HostKeyAlias=PI_IP \
  -o UserKnownHostsFile=/data/app/private/usbcloud/.ssh/known_hosts \
  -o StrictHostKeyChecking=ask pi@PI_IP \
  'sudo -n usbcloud-client status'
```

Compare the displayed fingerprint with the Pi's fingerprint from step 2, then
accept it. Expect client status JSON. An interactive shell is intentionally
unavailable through this key. For a reimaged device, remove only its obsolete
entry from this persistent known-hosts file after verifying the new fingerprint.

Current container startup sets the `www-data` home to
`/data/app/private/usbcloud`, so the dashboard uses the same trusted-host file.
You can check that your installed image has this startup fix:

```sh
docker exec --user www-data USBCloud ssh -G pi@PI_IP | grep '^userknownhostsfile '
```

The path must resolve under `/data`. If an older image still reports
`/var/www/.ssh`, update to an image containing the home-directory fix. For an
already running older container, this bridge uses the persistent directory:

```sh
docker exec USBCloud sh -c 'test -e /var/www/.ssh || ln -s /data/app/private/usbcloud/.ssh /var/www/.ssh'
```

The bridge is temporary container state; use the updated image for persistence
across replacements. Do not disable strict host-key checking.

## 7. Register through the dashboard

In the NAS dashboard, complete **Add device** with:

- Name: your preferred display name.
- Address: the same `PI_IP` used for host-key enrollment.
- SSH port: `22`.
- Username: `pi`.

Adding the device verifies SSH, issues a unique heartbeat token, sends its
configuration over the restricted connection, and starts the Pi's
`usbcloud-heartbeat` service. No manual API-token creation or copying is needed.
The backend URL is taken from `APP_URL`, or `USBCLOUD_HEARTBEAT_URL` when set.
Registration requires a successful authenticated heartbeat to that address.
HTTPS endpoints require a valid trusted certificate and must not redirect.

Verify the device is online and **Device health → Status source** shows
**API heartbeat**. Temperature, load, memory and system-disk metrics should
appear where the hardware supports them. Reports arrive every 30 seconds; no
report for 90 seconds marks the device offline while retaining last-known data.

On the Pi:

```sh
sudo systemctl status usbcloud-client.service usbcloud-heartbeat.service --no-pager
sudo journalctl -u usbcloud-heartbeat.service -n 30 --no-pager
```

Once a recording exists, select **Pull now** and confirm it appears in the NAS
archive and can be played or downloaded. Device settings are in `/data`, the
backend database is in `/database`, and retrieved media is in `/archive` inside
the container, mapped to your selected unRAID directories.

## Updates and troubleshooting

- **Cannot reach `/up`:** check primary Wi-Fi, DHCP address, NAS URL/port and
  routing. Guest/IoT isolation can block client-to-NAS traffic.
- **Host key verification failed:** enroll the verified key for the exact address
  used in Add device. A full reimage changes the key.
- **Permission denied (publickey):** check the current NAS public key is installed
  in `pi`'s `authorized_keys` and the directory/file permissions are 0700/0600.
- **Sudo requires a password:** check the sudoers file from step 4.
- **No USB controller:** check the overlay, module configuration and reboot.
- **Existing storage detected:** do not rerun `init` or delete pool files to fix
  an existing installation. This guide's clean path starts with a reimaged card.
- **Heartbeat setup failed:** verify Pi-to-backend reachability, the configured
  backend URL, client version and certificate trust. A failed add is not a
  completed registration.

For a client update, pull the selected release on the Pi and rerun the installer;
do not run `init` again. Storage, recordings and registration remain on the Pi.
To rotate/reprovision a registered device's token, run in the backend container:

```sh
php artisan usbcloud:pair-heartbeat DEVICE_ID
```

Fresh installations keep client state in `/var/lib/usbcloud-client` and snapshot
exports at `/srv/usbcloud-client/snapshot`. Legacy on-disk paths are retained
when upgrading existing installations. Removing a device in the dashboard revokes
its token and keeps already archived media; reimaging the Pi erases its local
state and requires the setup/enrollment steps again.
