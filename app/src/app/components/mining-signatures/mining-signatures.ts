import { Component, signal, computed } from '@angular/core';

interface MineralSignature {
  name: string;
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  signals: number[];  // columns 1-6 (number of rocks at location)
}

@Component({
  selector: 'app-mining-signatures',
  standalone: true,
  templateUrl: './mining-signatures.html',
  styleUrl: './mining-signatures.scss',
})
export class MiningSignaturesComponent {

  // Community-sourced signal data (server-side values, not in DCB)
  readonly minerals: MineralSignature[] = [
    { name: 'Ice',            rarity: 'Common',    signals: [4300, 8600, 12900, 17200, 21500, 25800] },
    { name: 'Aluminum',       rarity: 'Common',    signals: [4285, 8570, 12855, 17140, 21425, 25710] },
    { name: 'Iron',           rarity: 'Common',    signals: [4270, 8540, 12810, 17080, 21350, 25620] },
    { name: 'Silicon',        rarity: 'Common',    signals: [4255, 8510, 12765, 17020, 21275, 25530] },
    { name: 'Copper',         rarity: 'Common',    signals: [4240, 8480, 12720, 16960, 21200, 25440] },
    { name: 'Corundum',       rarity: 'Common',    signals: [4225, 8450, 12675, 16900, 21125, 25350] },
    { name: 'Quartz',         rarity: 'Common',    signals: [4210, 8420, 12630, 16840, 21050, 25260] },
    { name: 'Tin',            rarity: 'Common',    signals: [4195, 8390, 12585, 16780, 20975, 25170] },
    { name: 'Hephaestanite',  rarity: 'Common',    signals: [4180, 8360, 12540, 16720, 20900, 25080] },
    { name: 'Torite',         rarity: 'Uncommon',  signals: [3900, 7800, 11700, 15600, 19500, 23400] },
    { name: 'Agricium',       rarity: 'Uncommon',  signals: [3885, 7770, 11655, 15540, 19425, 23310] },
    { name: 'Tungsten',       rarity: 'Uncommon',  signals: [3870, 7740, 11610, 15480, 19350, 23220] },
    { name: 'Titanium',       rarity: 'Uncommon',  signals: [3855, 7710, 11565, 15420, 19275, 23130] },
    { name: 'Aslarite',       rarity: 'Uncommon',  signals: [3840, 7680, 11520, 15360, 19200, 23040] },
    { name: 'Laranite',       rarity: 'Uncommon',  signals: [3825, 7650, 11475, 15300, 19125, 22950] },
    { name: 'Bexalite',       rarity: 'Rare',      signals: [3600, 7200, 10800, 14400, 18000, 21600] },
    { name: 'Gold',           rarity: 'Rare',      signals: [3585, 7170, 10755, 14340, 17925, 21510] },
    { name: 'Borase',         rarity: 'Rare',      signals: [3570, 7140, 10710, 14280, 17850, 21420] },
    { name: 'Taranite',       rarity: 'Rare',      signals: [3555, 7110, 10665, 14220, 17775, 21330] },
    { name: 'Beryl',          rarity: 'Rare',      signals: [3540, 7080, 10620, 14160, 17700, 21240] },
    { name: 'Lindinium',      rarity: 'Epic',      signals: [3400, 6800, 10200, 13600, 17000, 20400] },
    { name: 'Riccite',        rarity: 'Epic',      signals: [3385, 6770, 10155, 13540, 16925, 20310] },
    { name: 'Ouratite',       rarity: 'Epic',      signals: [3370, 6740, 10110, 13480, 16850, 20220] },
    { name: 'Savrilium',      rarity: 'Legendary', signals: [3200, 6400, 9600, 12800, 16000, 19200] },
    { name: 'Stileron',       rarity: 'Legendary', signals: [3185, 6370, 9555, 12740, 15925, 19110] },
    { name: 'Quantainium',    rarity: 'Legendary', signals: [3170, 6340, 9510, 12680, 15850, 19020] },
  ];

  rarityFilter = signal<string>('');

  filtered = computed(() => {
    const r = this.rarityFilter();
    if (!r) return this.minerals;
    return this.minerals.filter(m => m.rarity === r);
  });

  rarityClass(rarity: string): string {
    return 'rarity-' + rarity.toLowerCase();
  }

  fmt(val: number): string {
    return val.toLocaleString();
  }
}
