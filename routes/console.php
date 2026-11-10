<?php

use App\Models\TeamInvitation;
use Illuminate\Support\Facades\Schedule;

if (! app()->runningUnitTests()) {
    Schedule::command('usbcloud:sync')->everyFiveSeconds()->withoutOverlapping(10)->runInBackground();
}

Schedule::call(function () {
    TeamInvitation::query()
        ->whereNotNull('expires_at')
        ->where('expires_at', '<', now())
        ->delete();
})->daily()->description('Delete expired team invitations');
