# USBCloud

USBCloud manages Raspberry Pi USB-storage clients, archives recordings, and
reports device health. The Laravel backend lives at the repository root so it can
be deployed directly by Laravel hosting tools or built as a container.

## Repository layout

- `app/`, `routes/`, `config/`, `database/`: Laravel backend and API.
- `resources/`, `public/`: React dashboard, styles, and web assets.
- `tests/`: backend feature and unit tests.
- `client/`: Raspberry Pi USBCloud Client, installer, and Python tests.
- `docker/` and `Dockerfile`: container runtime and build configuration.
- `unraid/` and `ca_profile.xml`: Community Apps template and repository metadata.
- `design/`: dashboard design reference and design-system assets.
- `outputs/`: historical test artifacts.
- `work/`: local setup and diagnostics, excluded from Git and container builds.

## Local development

Run Composer, Artisan and npm commands from this directory:

```sh
composer setup
composer dev
```

The Pi client has its own [installation and protocol notes](client/README.md).

## Container deployment

```sh
docker build -t ghcr.io/layered-tech/usbascloud:local .
docker run -d --name usbcloud --restart unless-stopped \
  -p 8088:8080 \
  -e APP_URL=http://NAS_ADDRESS:8088 \
  -e TZ=America/Chicago -e PUID=99 -e PGID=100 \
  -v /mnt/user/appdata/usbcloud/config:/data \
  -v /mnt/user/appdata/usbcloud/database:/database \
  -v /mnt/user/usbcloud:/archive \
  ghcr.io/layered-tech/usbascloud:local
```

Replace `NAS_ADDRESS` with the address reachable from your clients. The container
runs Nginx, PHP-FPM, the transfer worker and the scheduler. First boot creates the
SQLite database in `/database` and its encryption key, settings and SSH identity
in `/data`. Recordings live in `/archive`. All three directories are independently
configurable in the unRAID template and persist across upgrades. Back up all three
volumes, and stop the container before copying the SQLite database. The dashboard assumes a trusted
local network; use access controls and HTTPS at your reverse proxy for remote
access. Heartbeats use `APP_URL` unless `USBCLOUD_HEARTBEAT_URL` overrides it.

The container starts with an empty fleet. Add clients through the dashboard;
SSH key authorization and trusted device host keys must be configured first.
The backend public key appears in Settings. For host-key enrollment, use the
container console as `www-data` with `HOME=/data/app/private/usbcloud`, connect to
the client with `ssh`, and verify its host-key fingerprint before accepting it.
All client credentials and host keys then survive container updates.

## unRAID Community Apps

The template is [unraid/templates/usbcloud.xml](unraid/templates/usbcloud.xml).
It maps port 8088, app settings, database storage and a media share, and asks for the
client-reachable backend URL. It references
`ghcr.io/layered-tech/usbascloud:latest`.

The image workflow publishes AMD64 and ARM64 images when manually dispatched or
when a `v*` tag is pushed. Publishing requires the GitHub repository and package
permissions; make the resulting package public for unauthenticated installs.
The template repository must also be submitted to Community Apps and approved
before the app becomes searchable. Preparing these files does not publish it.

## Checks

```sh
php artisan test --compact
vendor/bin/phpstan analyse --no-progress
npm run types:check
npm run build
python3 -m unittest discover -s client -p 'test_*.py'
```
