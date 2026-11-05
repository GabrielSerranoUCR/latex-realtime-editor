import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CompileService } from './compile.service';

describe('CompileService', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { svc: TestBed.inject(CompileService), http: TestBed.inject(HttpTestingController) };
  }
  const reply = { ok: true, pdfUrl: '/p', log: '', diagnostics: [], durationMs: 1, builtAt: 1 };

  it('asks for the selected source to be compiled', async () => {
    const { svc, http } = setup();
    const p = svc.compile('room1', 'slides.tex');
    const req = http.expectOne('/api/rooms/room1/compile');
    expect(req.request.body).toEqual({ main: 'slides.tex' });
    req.flush(reply);
    await p;
  });

  it('sends nothing special when no source is selected', async () => {
    const { svc, http } = setup();
    const p = svc.compile('room1', null);
    const req = http.expectOne('/api/rooms/room1/compile');
    expect(req.request.body).toEqual({});
    req.flush(reply);
    await p;
  });
});
