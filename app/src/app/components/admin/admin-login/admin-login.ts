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
  error = signal<string | null>(null);
  busy = signal(false);

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.admin.login(this.username(), this.password());
      this.router.navigate(['/admin']);
    } catch (err: any) {
      const status = err?.status;
      const msg = err?.error?.error || err?.message || 'Login failed';
      this.error.set(status === 401 ? 'Invalid username or password' : msg);
    } finally {
      this.busy.set(false);
    }
  }
}
