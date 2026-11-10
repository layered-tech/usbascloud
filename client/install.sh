#!/bin/bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then
    echo 'Run this installer with sudo.' >&2
    exit 1
fi
if [ "$#" = 2 ]; then
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    # Download without redirects or disabled certificate verification.
    python3 - "$1" "$work" <<'PY'
import pathlib
import sys
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

base = sys.argv[1].rstrip('/')
url = urllib.parse.urlsplit(base)
if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
    raise SystemExit('Invalid backend URL')
for name in ('install_client.py', 'usbcloud_client.py'):
    with urllib.request.build_opener(NoRedirect()).open(base + '/api/v1/client-installation/assets/' + name, timeout=60) as response:
        pathlib.Path(sys.argv[2], name).write_bytes(response.read())
PY
    python3 "$work/install_client.py" --backend "$1" --token "$2"
elif [ "$#" = 1 ] && [ "$1" = '--update' ]; then
    python3 "$(dirname "$0")/install_client.py" --update
else
    echo 'Use the command from Add device, or run: sudo bash client/install.sh --update' >&2
    exit 1
fi
