// Route guard: redirects to /admin/login if no admin token is present.

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AdminService } from './admin.service';

export const adminGuard: CanActivateFn = () => {
  const admin = inject(AdminService);
  const router = inject(Router);
  if (admin.isAuthenticated()) return true;
  router.navigate(['/admin/login']);
  return false;
};
