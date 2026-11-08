<?php

return [
    'host' => env('PI_POC_HOST', '192.168.87.62'),
    'user' => env('PI_POC_USER', 'pi'),
    'host_key_alias' => env('PI_POC_HOST_KEY_ALIAS', 'blink-pi.local'),
    'identity' => env('PI_POC_IDENTITY', is_file(storage_path('app/private/usbcloud/ssh/id_ed25519')) ? storage_path('app/private/usbcloud/ssh/id_ed25519') : dirname(base_path()).'/work/pi-usb-setup/personal.pub'),
    'transfer_protocol' => env('PI_POC_TRANSFER_PROTOCOL', is_file(storage_path('app/private/usbcloud/ssh/id_ed25519')) ? 'stream' : 'sftp'),
    'directory' => storage_path('app/private/pi-poc'),
];
