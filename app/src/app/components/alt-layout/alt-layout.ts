import { Component, signal, computed } from '@angular/core';
import { EveStyleComponent } from '../eve-style/eve-style';

@Component({
  selector: 'app-alt-layout',
  standalone: true,
  templateUrl: './alt-layout.html',
  styleUrl: './alt-layout.scss',
})
export class AltLayoutComponent extends EveStyleComponent {

  /** Picker drawer state */
  drawerOpen = signal(false);

  /** Override selectSlot to also open drawer */
  override selectSlot(slotId: string): void {
    super.selectSlot(slotId);
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
    this.selectedSlotId.set(null);
  }

  /** Equip and close drawer */
  equipAndClose(item: any): void {
    this.equipToSlot(item);
    this.drawerOpen.set(false);
  }

  /** Power usage percentage */
  powerPct = computed(() => {
    const out = this.totalPowerOutput();
    if (!out) return 0;
    return Math.min(100, (this.totalPowerDraw() / out) * 100);
  });

  /** Shield regen time */
  shieldRegenTime = computed(() => {
    const regen = this.totalShieldRegen();
    const hp = this.totalShieldHp();
    if (!regen || !hp) return 0;
    return hp / regen;
  });

  /** Category icon lookup */
  catIcon(cat: string): string {
    const map: Record<string, string> = {
      weapons: '\u2694', shields: '\u25C8', power: '\u26A1',
      cooling: '\u2744', quantum: '\u25C9', missiles: '\u25C6',
      avionics: '\u25CE',
    };
    return map[cat] ?? '\u25CB';
  }

  /** Category display label */
  catLabel(cat: string): string {
    const map: Record<string, string> = {
      weapons: 'WPN', shields: 'SHD', power: 'PWR',
      cooling: 'CLR', quantum: 'QDR', missiles: 'MSL',
      avionics: 'AVN',
    };
    return map[cat] ?? cat.slice(0, 3).toUpperCase();
  }
}
