import { Component, signal, computed, viewChild, ElementRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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

// Google Apps Script web app URL for submission data
const SHEET_URL = 'https://script.google.com/macros/s/AKfycby-Sbza3UNLXsCehPrlLtviYt8b4cdA5er78Z636kttGRxEuN2lYiczi0i8615psMv5/exec';

@Component({
  selector: 'app-submit-view',
  standalone: true,
  templateUrl: './submit-view.html',
  styleUrl: './submit-view.scss',
})
export class SubmitViewComponent {
  constructor(public data: DataService, private http: HttpClient) {}

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
  showTestingGuide = signal(true);

  // Feedback form
  feedbackType = signal('');
  feedbackText = signal('');
  feedbackName = signal('');
  feedbackEmail = signal('');
  feedbackSubmitting = signal(false);
  feedbackSubmitted = signal(false);

  shipOptions = computed(() =>
    [...this.data.ships()].sort((a, b) => a.name.localeCompare(b.name))
  );

  // Ship picker dropdown
  shipPickerOpen = signal(false);
  shipSearchQuery = signal('');
  shipSearchInput = viewChild<ElementRef<HTMLInputElement>>('shipSearchInput');

  filteredShipOptions = computed(() => {
    const q = this.shipSearchQuery().toLowerCase().trim();
    const ships = this.shipOptions();
    if (!q) return ships;
    return ships.filter(s => s.name.toLowerCase().includes(q));
  });

  openShipPicker(): void {
    this.shipPickerOpen.set(true);
    this.shipSearchQuery.set('');
    setTimeout(() => this.shipSearchInput()?.nativeElement.focus());
  }

  closeShipPicker(): void {
    setTimeout(() => this.shipPickerOpen.set(false), 150);
  }

  pickShip(className: string): void {
    this.updateField('shipClassName', className);
    this.shipPickerOpen.set(false);
  }

  private readonly STALE_DAYS = 90;

  shipsNeedingData = computed(() => {
    const now = Date.now();
    const cutoff = this.STALE_DAYS * 24 * 60 * 60 * 1000;
    return this.data.ships()
      .filter(s => {
        if (!s.accelTestedDate) return true;
        const tested = new Date(s.accelTestedDate).getTime();
        return (now - tested) > cutoff;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  selectShipForSubmit(className: string): void {
    this.updateField('shipClassName', className);
    // Scroll to form
    document.querySelector('.submit-panel')?.scrollIntoView({ behavior: 'smooth' });
  }

  selectedShipName = computed(() => {
    const cls = this.form().shipClassName;
    return this.data.ships().find(s => s.className === cls)?.name ?? '';
  });

  updateField(field: keyof AccelForm, value: string): void {
    this.form.update(f => ({ ...f, [field]: value }));
  }

  /** Sanitize accel input: strip non-numeric, clamp to 25.0, format X.X */
  sanitizeAccel(field: keyof AccelForm, value: string): void {
    // Strip everything except digits and decimal point
    let clean = value.replace(/[^0-9.]/g, '');
    // Only allow one decimal point
    const parts = clean.split('.');
    if (parts.length > 2) clean = parts[0] + '.' + parts.slice(1).join('');
    // Limit to one decimal place
    if (parts.length === 2 && parts[1].length > 1) clean = parts[0] + '.' + parts[1][0];
    // Clamp to 25.0
    const num = parseFloat(clean);
    if (!isNaN(num) && num > 30.0) clean = '30.0';
    this.form.update(f => ({ ...f, [field]: clean }));
  }

  canSubmit = computed(() => {
    const f = this.form();
    return f.submitterName.trim() !== '' && f.shipClassName !== '' && f.fwd !== '';
  });

  submitting = signal(false);
  submitError = signal('');

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

    if (!SHEET_URL) {
      // Fallback to localStorage if Google Sheet not configured
      const existing = JSON.parse(localStorage.getItem('versetools_submissions') ?? '[]');
      existing.push(entry);
      localStorage.setItem('versetools_submissions', JSON.stringify(existing));
      this.submitted.set(true);
      this.resetAfterSubmit();
    } else {
      this.submitting.set(true);
      this.submitError.set('');
      // POST to Google Apps Script — use no-cors fetch since Apps Script
      // returns a redirect that browsers handle transparently
      fetch(SHEET_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      }).then(() => {
        this.submitted.set(true);
        this.submitting.set(false);
        this.resetAfterSubmit();
      }).catch(() => {
        this.submitError.set('Submission failed — please try again');
        this.submitting.set(false);
      });
    }
  }

  private resetAfterSubmit(): void {
    setTimeout(() => {
      this.submitted.set(false);
      this.submitError.set('');
      this.form.update(f => ({
        submitterName: f.submitterName,
        shipClassName: '',
        fwd: '', fwdBoost: '',
        retro: '', retroBoost: '',
        strafe: '', strafeBoost: '',
        up: '', upBoost: '',
        down: '', downBoost: '',
        notes: '',
      }));
    }, 1500);
  }

  submitFeedback(): void {
    const entry = {
      type: 'feedback',
      feedbackType: this.feedbackType(),
      feedbackText: this.feedbackText().trim(),
      feedbackName: this.feedbackName().trim(),
      feedbackEmail: this.feedbackEmail().trim(),
      date: new Date().toISOString().slice(0, 10),
    };

    this.feedbackSubmitting.set(true);
    fetch(SHEET_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).then(() => {
      this.feedbackSubmitted.set(true);
      this.feedbackSubmitting.set(false);
    }).catch(() => {
      this.feedbackSubmitting.set(false);
    });

    setTimeout(() => {
      this.feedbackSubmitted.set(false);
      this.feedbackType.set('');
      this.feedbackText.set('');
      this.feedbackName.set('');
      this.feedbackEmail.set('');
    }, 2000);
  }
}
