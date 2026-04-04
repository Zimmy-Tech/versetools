import { Component, signal } from '@angular/core';

type Section = 'about' | 'power' | 'weapons' | 'shields' | 'signatures' | 'armor' | 'cooling' | 'flight' | 'mining' | 'radar' | 'cargo' | 'crafting' | 'contracts';

@Component({
  selector: 'app-formulas-view',
  standalone: true,
  templateUrl: './formulas-view.html',
  styleUrl: './formulas-view.scss',
})
export class FormulasViewComponent {
  activeSection = signal<Section>('about');

  readonly sections: { id: Section; label: string }[] = [
    { id: 'about', label: 'About' },
    { id: 'power', label: 'Power System' },
    { id: 'weapons', label: 'Weapons & DPS' },
    { id: 'shields', label: 'Shields' },
    { id: 'signatures', label: 'Signatures' },
    { id: 'armor', label: 'Armor' },
    { id: 'cooling', label: 'Cooling' },
    { id: 'flight', label: 'Flight & Thrusters' },
    { id: 'mining', label: 'Mining' },
    { id: 'radar', label: 'Radar' },
    { id: 'cargo', label: 'Cargo' },
    { id: 'crafting', label: 'Crafting' },
    { id: 'contracts', label: 'Contracts' },
  ];
}
