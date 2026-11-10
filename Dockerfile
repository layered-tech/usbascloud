# syntax=docker/dockerfile:1
FROM php:8.5-fpm-bookworm AS php-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx supervisor gosu openssh-client ffmpeg curl ca-certificates \
    libicu-dev libzip-dev \
    && docker-php-ext-install -j"$(nproc)" bcmath intl pcntl zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM php-base AS build
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY composer.json composer.lock package.json package-lock.json .npmrc ./
RUN composer install --no-dev --no-scripts --prefer-dist --no-interaction --no-progress \
    && npm ci
COPY . .
RUN mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs bootstrap/cache \
    && composer dump-autoload --no-dev --optimize --no-interaction \
    && npm run build && rm -rf node_modules

FROM php-base AS runtime
ENV APP_ENV=production APP_DEBUG=false APP_URL=http://localhost:8080 \
    LOG_CHANNEL=stderr DB_CONNECTION=sqlite DB_DATABASE=/database/usbcloud.sqlite \
    CACHE_STORE=file SESSION_DRIVER=file QUEUE_CONNECTION=database \
    USBCLOUD_INCLUDE_DEFAULT_DEVICE=false USBCLOUD_ARCHIVE_DIRECTORY=/archive \
    USBCLOUD_CLIENT_TRANSFER_PROTOCOL=stream PUID=99 PGID=100
COPY --from=build /app /app
RUN rm -rf node_modules storage \
    && ln -s /data /app/storage \
    && rm -f /etc/nginx/sites-enabled/default \
    && sed -i '/fastcgi_param[[:space:]]*HTTP_HOST[[:space:]]/d' /etc/nginx/fastcgi_params \
    && printf 'clear_env = no\n' > /usr/local/etc/php-fpm.d/zz-usbcloud.conf
COPY docker/nginx.conf /etc/nginx/conf.d/usbcloud.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/usbcloud.conf
COPY docker/php.ini /usr/local/etc/php/conf.d/usbcloud.ini
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/usbcloud-entrypoint
EXPOSE 8080
VOLUME ["/data", "/database", "/archive"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/up || exit 1
ENTRYPOINT ["usbcloud-entrypoint"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
