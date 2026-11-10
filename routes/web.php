<?php

use App\Http\Controllers\ClientConsoleController;
use App\Http\Controllers\ClientInstallationController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\Teams\TeamInvitationController;
use App\Http\Controllers\UsbCloudController;
use App\Http\Middleware\EnsureTeamMembership;
use Illuminate\Support\Facades\Route;

Route::get('/', [UsbCloudController::class, 'index'])->name('home');
Route::post('/usbcloud/installations', [ClientInstallationController::class, 'store'])->middleware('throttle:20,1')->name('usbcloud.installations.store');
Route::post('/usbcloud/operate', [UsbCloudController::class, 'operate'])->name('usbcloud.operate');
Route::get('/usbcloud/discover', [UsbCloudController::class, 'discover'])->name('usbcloud.discover');
Route::post('/usbcloud/devices', [UsbCloudController::class, 'addDevice'])->name('usbcloud.devices.add');
Route::put('/usbcloud/devices/{device}', [UsbCloudController::class, 'updateDevice'])->name('usbcloud.devices.update');
Route::post('/usbcloud/devices/{device}/test', [UsbCloudController::class, 'testDevice'])->name('usbcloud.devices.test');
Route::delete('/usbcloud/devices/{device}', [UsbCloudController::class, 'removeDevice'])->name('usbcloud.devices.remove');
Route::post('/usbcloud/transfers', [UsbCloudController::class, 'transfer'])->name('usbcloud.transfer');
Route::put('/usbcloud/settings', [UsbCloudController::class, 'settings'])->name('usbcloud.settings');
Route::get('/usbcloud/download', [UsbCloudController::class, 'download'])->name('usbcloud.download');
Route::get('/usbcloud/files/{file}', [UsbCloudController::class, 'file'])->where('file', '[a-f0-9]{64}')->name('usbcloud.file');

Route::get('/client-console', [ClientConsoleController::class, 'index'])->name('client.console');
Route::post('/client-console/refresh', [ClientConsoleController::class, 'refresh'])->name('client.console.refresh');
Route::post('/client-console/retrieve', [ClientConsoleController::class, 'retrieve'])->name('client.console.retrieve');
Route::get('/client-console/files/{run}/{file}', [ClientConsoleController::class, 'file'])->name('client.console.file');

Route::prefix('{current_team}')
    ->middleware(['auth', 'verified', EnsureTeamMembership::class])
    ->group(function () {
        Route::get('dashboard', DashboardController::class)->name('dashboard');
    });

Route::middleware(['auth'])->group(function () {
    Route::post('invitations/{invitation}/accept', [TeamInvitationController::class, 'accept'])->name('invitations.accept');
    Route::delete('invitations/{invitation}', [TeamInvitationController::class, 'decline'])->name('invitations.decline');
});

require __DIR__.'/settings.php';
