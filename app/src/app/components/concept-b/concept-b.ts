import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-concept-b',
  standalone: true,
  templateUrl: './concept-b.html',
  styleUrl: './concept-b.scss',
})
export class ConceptBComponent {
  activeSystem = signal('weapons');
}
