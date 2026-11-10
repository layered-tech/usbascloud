<?php

use App\Http\Controllers\ClientInstallationController;
use App\Http\Controllers\DeviceHeartbeatController;
use Illuminate\Support\Facades\Route;

Route::post('/v1/devices/{device}/heartbeat', DeviceHeartbeatController::class)
    ->middleware('throttle:120,1')->name('devices.heartbeat');

Route::prefix('v1/client-installation')->middleware('throttle:30,1')->group(function (): void {
    Route::get('/assets/{file}', [ClientInstallationController::class, 'asset'])->name('client.installation.asset');
    Route::post('/configuration', [ClientInstallationController::class, 'configuration'])->name('client.installation.configuration');
    Route::post('/enroll', [ClientInstallationController::class, 'enroll'])->name('client.installation.enroll');
});
