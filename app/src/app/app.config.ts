import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection, isDevMode } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless change detection — Angular 21 stable. Without Zone.js,
    // CD only fires for components reading the specific signals that
    // changed, instead of running a full-app pass on every event. The
    // crafting modal slider was visibly laggy because every (input)
    // event triggered a full loadout-view + DPS panel + hardpoint-slot
    // CD pass at 60+ Hz. Codebase is already signal-heavy so the
    // migration risk is low — async work uses signal-set patterns,
    // not direct property mutation that relied on Zone-driven CD.
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerImmediately',
    }),
  ]
};
