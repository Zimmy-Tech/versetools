import { Component, computed } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DpsPanelComponent } from '../dps-panel/dps-panel';
import { HardpointSlotComponent } from '../hardpoint-slot/hardpoint-slot';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { LoadoutViewComponent } from '../loadout-view/loadout-view';

@Component({
  selector: 'app-row-layout',
  standalone: true,
  imports: [DpsPanelComponent, HardpointSlotComponent, PowerBarsComponent, UpperCasePipe],
  templateUrl: './row-layout.html',
  styleUrl: './row-layout.scss',
})
export class RowLayoutComponent extends LoadoutViewComponent {

  pilotBurstDPS = computed(() => {
    const loadout = this.data.loadout();
    let total = 0;
    for (const item of Object.values(loadout)) {
      if (item && (item.type === 'WeaponGun' || item.type === 'WeaponTachyon') && item.dps) {
        total += item.dps;
      }
    }
    return total;
  });

  totalShieldHP = computed(() => {
    const loadout = this.data.loadout();
    let total = 0;
    for (const item of Object.values(loadout)) {
      if (item?.type === 'Shield' && item.hp) {
        total += item.hp;
      }
    }
    return total;
  });
}
