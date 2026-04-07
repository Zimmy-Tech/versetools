import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DataService } from '../../../services/data.service';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.scss',
})
export class AdminDashboardComponent {
  private data = inject(DataService);

  shipCount = computed(() => this.data.db()?.ships?.length ?? 0);
  itemCount = computed(() => this.data.db()?.items?.length ?? 0);
}
