<?php

use App\Http\Controllers\DeviceHeartbeatController;
use Illuminate\Support\Facades\Route;

Route::post('/v1/devices/{device}/heartbeat', DeviceHeartbeatController::class)
    ->middleware('throttle:120,1')->name('devices.heartbeat');
