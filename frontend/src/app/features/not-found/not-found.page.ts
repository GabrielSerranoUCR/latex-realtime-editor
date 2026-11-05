import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** "Lost in the cellar": unknown routes, and scrolls you cannot see (the server answers 404 for both). */
@Component({
  selector: 'qq-not-found-page',
  imports: [RouterLink],
  template: `
    <main class="wood-bg lost">
      <div class="hanging-sign">
        <div class="chains"><i></i><i></i></div>
        <div class="board">
          <h1 class="big">404</h1>
          <h2>Lost in the cellar</h2>
          <p>This scroll or table does not exist, or you have no seat at it.</p>
        </div>
      </div>
      <a class="btn" routerLink="/">Back to the quest board</a>
    </main>
  `,
  styles: `
    :host { display: block; }
    .lost { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 36px; padding: 24px; }
    .big { font: 900 96px var(--font-display); margin: 0; color: var(--candle-400); }
    h2 { font: 700 34px var(--font-heading); margin: 0; }
    a.btn { text-decoration: none; }
  `,
})
export class NotFoundPage {}
