<?php

namespace App\Http\Controllers;

use App\Http\Requests\SaveUsbCloudDeviceRequest;
use App\Services\ClientInstallations;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

class ClientInstallationController extends Controller
{
    public function store(SaveUsbCloudDeviceRequest $request, ClientInstallations $installations): JsonResponse
    {
        return response()->json($installations->create($request->safe()->only(['name', 'host', 'port', 'user'])), 201)->header('Cache-Control', 'no-store');
    }

    public function configuration(Request $request, ClientInstallations $installations): JsonResponse
    {
        return response()->json($installations->configuration($request->bearerToken() ?? ''))->header('Cache-Control', 'no-store');
    }

    public function enroll(Request $request, ClientInstallations $installations): JsonResponse
    {
        $token = $request->bearerToken() ?? '';
        $installations->configuration($token);
        $data = $request->validate(['host_key' => ['required', 'string', 'max:200']]);

        return response()->json($installations->enroll($token, $data['host_key']), 201)->header('Cache-Control', 'no-store');
    }

    public function asset(string $file): BinaryFileResponse
    {
        abort_unless(in_array($file, ['install.sh', 'install_client.py', 'usbcloud_client.py'], true), 404);

        return response()->file(base_path('client/'.$file), ['Content-Type' => 'text/plain', 'Cache-Control' => 'no-store']);
    }
}
