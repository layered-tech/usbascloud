<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateUsbCloudSettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'server_name' => ['required', 'string', 'max:64', 'regex:/\A[a-zA-Z0-9._ -]+\z/'],
            'pull_interval' => ['required', 'integer', 'min:5', 'max:86400'],
            'auto_pull' => ['required', 'boolean'],
            'theme' => ['required', Rule::in(['phosphor', 'paper'])],
        ];
    }
}
