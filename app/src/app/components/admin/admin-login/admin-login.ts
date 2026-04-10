import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './admin-login.html',
  styleUrl: './admin-login.scss',
})
export class AdminLoginComponent {
  private admin = inject(AdminService);
  private router = inject(Router);

  username = signal('');
  password = signal('');
  totpCode = signal('');
  error = signal<string | null>(null);
  busy = signal(false);

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.admin.login(this.username(), this.password(), this.totpCode() || undefined);
      this.router.navigate(['/admin']);
    } catch (err: any) {
      const status = err?.status;
      const body = err?.error || {};
      if (status === 429) {
        this.error.set(`Too many attempts. Try again in ${body.retryAfterSec || 60} seconds.`);
      } else if (status === 401 && body.totpRequired) {
        this.error.set('Valid credentials, but 2FA code is required.');
      } else if (status === 401) {
        this.error.set('Invalid username, password, or 2FA code');
      } else {
        this.error.set(body.error || err?.message || 'Login failed');
      }
    } finally {
      this.busy.set(false);
    }
  }
}
