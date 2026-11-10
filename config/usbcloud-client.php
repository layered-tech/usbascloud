<?php

return [
    'host' => env('USBCLOUD_CLIENT_HOST', '192.168.87.62'),
    'user' => env('USBCLOUD_CLIENT_USER', 'pi'),
    'host_key_alias' => env('USBCLOUD_CLIENT_HOST_KEY_ALIAS', 'blink-pi.local'),
    'identity' => env('USBCLOUD_CLIENT_IDENTITY', is_file(storage_path('app/private/usbcloud/ssh/id_ed25519')) ? storage_path('app/private/usbcloud/ssh/id_ed25519') : base_path('work/pi-usb-setup/personal.pub')),
    'transfer_protocol' => env('USBCLOUD_CLIENT_TRANSFER_PROTOCOL', is_file(storage_path('app/private/usbcloud/ssh/id_ed25519')) ? 'stream' : 'sftp'),
    'directory' => storage_path(is_dir(storage_path('app/private/pi-poc')) ? 'app/private/pi-poc' : 'app/private/usbcloud-client'),
];
