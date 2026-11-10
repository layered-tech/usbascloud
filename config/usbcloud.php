<?php

return [
    'directory' => storage_path('app/private/usbcloud'),
    'server_name' => env('USBCLOUD_SERVER_NAME', gethostname() ?: 'usbcloud'),
    'device_id' => env('USBCLOUD_DEVICE_ID', 'BLINK-PI'),
    'device_name' => env('USBCLOUD_DEVICE_NAME', 'Blink USB storage'),
    'devices' => [],
    'include_default_device' => env('USBCLOUD_INCLUDE_DEFAULT_DEVICE', true),
    'archive_directory' => env('USBCLOUD_ARCHIVE_DIRECTORY'),
    'heartbeat_url' => env('USBCLOUD_HEARTBEAT_URL'),
];
