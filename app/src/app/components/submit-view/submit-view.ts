import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';

interface AccelForm {
  submitterName: string;
  shipClassName: string;
  fwd: string;
  fwdBoost: string;
  retro: string;
  retroBoost: string;
  strafe: string;
  strafeBoost: string;
  up: string;
  upBoost: string;
  down: string;
  downBoost: string;
  notes: string;
}

@Component({
  selector: 'app-submit-view',
  standalone: true,
  templateUrl: './submit-view.html',
  styleUrl: './submit-view.scss',
})
export class SubmitViewComponent {
  constructor(public data: DataService) {}

  form = signal<AccelForm>({
    submitterName: '',
    shipClassName: '',
    fwd: '', fwdBoost: '',
    retro: '', retroBoost: '',
    strafe: '', strafeBoost: '',
    up: '', upBoost: '',
    down: '', downBoost: '',
    notes: '',
  });

  submitted = signal(false);

  shipOptions = computed(() =>
    [...this.data.ships()].sort((a, b) => a.name.localeCompare(b.name))
  );

  selectedShipName = computed(() => {
    const cls = this.form().shipClassName;
    return this.data.ships().find(s => s.className === cls)?.name ?? '';
  });

  updateField(field: keyof AccelForm, value: string): void {
    this.form.update(f => ({ ...f, [field]: value }));
  }

  canSubmit = computed(() => {
    const f = this.form();
    return f.submitterName.trim() !== '' && f.shipClassName !== '' && f.fwd !== '';
  });

  submit(): void {
    const f = this.form();
    const entry = {
      submitterName: f.submitterName.trim(),
      shipClassName: f.shipClassName,
      shipName: this.selectedShipName(),
      date: new Date().toISOString().slice(0, 10),
      accelFwd: parseFloat(f.fwd) || 0,
      accelAbFwd: parseFloat(f.fwdBoost) || 0,
      accelRetro: parseFloat(f.retro) || 0,
      accelAbRetro: parseFloat(f.retroBoost) || 0,
      accelStrafe: parseFloat(f.strafe) || 0,
      accelAbStrafe: parseFloat(f.strafeBoost) || 0,
      accelUp: parseFloat(f.up) || 0,
      accelAbUp: parseFloat(f.upBoost) || 0,
      accelDown: parseFloat(f.down) || 0,
      accelAbDown: parseFloat(f.downBoost) || 0,
      notes: f.notes.trim(),
    };

    // Store locally for now
    const existing = JSON.parse(localStorage.getItem('versedb_submissions') ?? '[]');
    existing.push(entry);
    localStorage.setItem('versedb_submissions', JSON.stringify(existing));

    this.submitted.set(true);
    setTimeout(() => {
      this.submitted.set(false);
      this.form.set({
        submitterName: this.form().submitterName,
        shipClassName: '',
        fwd: '', fwdBoost: '',
        retro: '', retroBoost: '',
        strafe: '', strafeBoost: '',
        up: '', upBoost: '',
        down: '', downBoost: '',
        notes: '',
      });
    }, 2000);
  }
}
