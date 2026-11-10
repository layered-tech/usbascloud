#!/bin/sh
set -eu
umask 027
case "$PUID:$PGID" in *[!0-9:]*|:*|*:) echo 'PUID and PGID must be numeric.' >&2; exit 1;; esac
if [ "$PUID" = 0 ] || [ "$PGID" = 0 ]; then
    echo 'Use non-root PUID and PGID values.' >&2
    exit 1
fi
groupmod -o -g "$PGID" www-data
usermod -o -u "$PUID" -g "$PGID" -d /data/app/private/usbcloud www-data
mkdir -p /database /data/framework/cache/data /data/framework/sessions /data/framework/views /data/logs /data/app/private/usbcloud/ssh /archive
# Change only application directories; never recursively scan the clip archive.
chown -R www-data:www-data /data/framework /data/logs /app/bootstrap/cache
chown www-data:www-data /data /database /data/app /data/app/private /data/app/private/usbcloud /data/app/private/usbcloud/ssh /archive
chmod 700 /data/app/private/usbcloud/ssh
if [ -s /data/app-key ]; then
    saved_key=$(cat /data/app-key)
    if [ -n "${APP_KEY:-}" ] && [ "$APP_KEY" != "$saved_key" ]; then
        echo 'APP_KEY differs from the persisted app key. Restore the original key.' >&2
        exit 1
    fi
    APP_KEY=$saved_key
else
    APP_KEY=${APP_KEY:-$(php -r 'echo "base64:".base64_encode(random_bytes(32));')}
    printf '%s' "$APP_KEY" > /data/app-key
    chmod 600 /data/app-key
fi
export APP_KEY
chown www-data:www-data /data/app-key
if [ ! -e "$DB_DATABASE" ]; then
    gosu www-data touch "$DB_DATABASE"
fi
chown www-data:www-data "$DB_DATABASE"
key=/data/app/private/usbcloud/ssh/id_ed25519
if [ ! -e "$key" ]; then
    gosu www-data ssh-keygen -q -t ed25519 -N '' -C usbcloud-backend -f "$key"
fi
# Host keys are stored alongside the persistent device identity.
export HOME=/data/app/private/usbcloud
mkdir -p "$HOME/.ssh"
chown www-data:www-data "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
gosu www-data php artisan config:clear --no-interaction
gosu www-data php artisan migrate --force --no-interaction
gosu www-data php artisan config:cache --no-interaction
exec "$@"
