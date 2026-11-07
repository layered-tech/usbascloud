<?php

return [
    'host' => env('PI_POC_HOST', '192.168.87.62'),
    'user' => env('PI_POC_USER', 'pi'),
    'host_key_alias' => env('PI_POC_HOST_KEY_ALIAS', 'blink-pi.local'),
    'identity' => env('PI_POC_IDENTITY', dirname(base_path()).'/work/pi-usb-setup/personal.pub'),
    'directory' => storage_path('app/private/pi-poc'),
];
