import { Component } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DpsPanelComponent } from '../dps-panel/dps-panel';
import { HardpointSlotComponent } from '../hardpoint-slot/hardpoint-slot';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { LoadoutViewComponent } from '../loadout-view/loadout-view';

@Component({
  selector: 'app-column-layout',
  standalone: true,
  imports: [DpsPanelComponent, HardpointSlotComponent, PowerBarsComponent, UpperCasePipe],
  templateUrl: './column-layout.html',
  styleUrl: './column-layout.scss',
})
export class ColumnLayoutComponent extends LoadoutViewComponent {}
