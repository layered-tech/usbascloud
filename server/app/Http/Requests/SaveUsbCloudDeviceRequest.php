<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class SaveUsbCloudDeviceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'name' => ['present', $this->routeIs('usbcloud.devices.update') ? 'required' : 'nullable', 'string', 'max:100'],
            'host' => ['required', 'string', 'max:253', 'regex:/\A[a-zA-Z0-9][a-zA-Z0-9.:-]*\z/'],
            'port' => ['required', 'integer', 'between:1,65535'],
            'user' => ['required', 'string', 'max:32', 'regex:/\A[a-z_][a-z0-9_-]*\z/i'],
            'site' => ['sometimes', 'nullable', 'string', 'max:100'],
            'auto_sync' => ['sometimes', 'boolean'], 'interval' => ['sometimes', 'integer', 'between:5,86400'],
            'bandwidth' => ['sometimes', 'numeric', 'between:0,1000'],
            'snapshot_timeout' => ['sometimes', 'integer', 'between:60,3600'],
            'retry_count' => ['sometimes', 'integer', 'between:0,10'],
            'retry_delay' => ['sometimes', 'integer', 'between:5,300'],
        ];
    }
}
