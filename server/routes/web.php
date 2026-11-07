<?php

use App\Http\Controllers\DashboardController;
use App\Http\Controllers\PiPocController;
use App\Http\Controllers\Teams\TeamInvitationController;
use App\Http\Controllers\UsbCloudController;
use App\Http\Middleware\EnsureTeamMembership;
use Illuminate\Support\Facades\Route;

Route::get('/', [UsbCloudController::class, 'index'])->name('home');
Route::post('/usbcloud/operate', [UsbCloudController::class, 'operate'])->name('usbcloud.operate');
Route::put('/usbcloud/settings', [UsbCloudController::class, 'settings'])->name('usbcloud.settings');
Route::get('/usbcloud/download', [UsbCloudController::class, 'download'])->name('usbcloud.download');
Route::get('/usbcloud/files/{file}', [UsbCloudController::class, 'file'])->where('file', '[a-f0-9]{64}')->name('usbcloud.file');

Route::get('/poc/pi', [PiPocController::class, 'index'])->name('poc.pi');
Route::post('/poc/pi/refresh', [PiPocController::class, 'refresh'])->name('poc.pi.refresh');
Route::post('/poc/pi/retrieve', [PiPocController::class, 'retrieve'])->name('poc.pi.retrieve');
Route::get('/poc/pi/files/{run}/{file}', [PiPocController::class, 'file'])->name('poc.pi.file');

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
