<?php

return [
    'directory' => storage_path('app/private/usbcloud'),
    'server_name' => env('USBCLOUD_SERVER_NAME', gethostname() ?: 'usbcloud'),
    'device_id' => env('USBCLOUD_DEVICE_ID', 'BLINK-PI'),
    'device_name' => env('USBCLOUD_DEVICE_NAME', 'Blink USB storage'),
    'devices' => [],
];
