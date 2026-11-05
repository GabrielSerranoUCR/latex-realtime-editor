import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { authGuard, guestGuard, safeNext } from './auth.guard';
import { AuthService, apiMessage } from './auth.service';

const ada = { id: '1', email: 'ada@guild.test', displayName: 'Ada', color: '#C9A04A', emailVerified: true, affiliation: '' };

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('refresh() stores the user, or clears it on 401, and marks itself ready either way', async () => {
    const p = auth.refresh();
    http.expectOne('/api/me').flush(ada);
    expect((await p)?.displayName).toBe('Ada');
    expect(auth.signedIn()).toBe(true);

    const q = auth.refresh();
    http.expectOne('/api/me').flush({ error: 'please sign in' }, { status: 401, statusText: 'Unauthorized' });
    expect(await q).toBeNull();
    expect(auth.signedIn()).toBe(false);
    expect(auth.ready()).toBe(true);
  });

  it('login/signup post the credentials and sign the user in', async () => {
    const l = auth.login('ada@guild.test', 'pw');
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ email: 'ada@guild.test', password: 'pw' });
    req.flush(ada);
    await l;
    expect(auth.user()?.email).toBe('ada@guild.test');

    const s = auth.signup('b@guild.test', 'Bea', 'long enough pw');
    const sreq = http.expectOne('/api/auth/signup');
    expect(sreq.request.body).toEqual({ email: 'b@guild.test', displayName: 'Bea', password: 'long enough pw' });
    sreq.flush({ ...ada, displayName: 'Bea' });
    await s;
    expect(auth.user()?.displayName).toBe('Bea');
  });

  it('a failed login leaves the user signed out and surfaces the server message', async () => {
    const l = auth.login('x@y.test', 'nope');
    http.expectOne('/api/auth/login').flush({ error: 'That email and password do not match.' }, { status: 400, statusText: 'Bad Request' });
    const err = await l.catch((e) => e);
    expect(apiMessage(err)).toBe('That email and password do not match.');
    expect(auth.signedIn()).toBe(false);
  });

  it('logout clears the user even if the request fails', async () => {
    auth.user.set(ada);
    const out = auth.logout().catch(() => undefined);
    http.expectOne('/api/auth/logout').flush(null, { status: 500, statusText: 'Server Error' });
    await out;
    expect(auth.signedIn()).toBe(false);
  });

  it('guards: anonymous users go to /login?next=…, signed-in users skip login/signup', async () => {
    const router = TestBed.inject(Router);
    const run = (guard: typeof authGuard, url: string) => TestBed.runInInjectionContext(() => guard({} as never, { url } as never));

    const anon = run(authGuard, '/scroll/abc');
    http.expectOne('/api/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(router.serializeUrl((await anon) as never)).toBe('/login?next=%2Fscroll%2Fabc');

    auth.user.set(ada);
    expect(await run(authGuard, '/')).toBe(true);
    expect(router.serializeUrl((await TestBed.runInInjectionContext(() => guestGuard({} as never, {} as never))) as never)).toBe('/');
  });
});

describe('AuthService account calls', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  it('talks to the recovery endpoints', async () => {
    const calls: Array<[() => Promise<unknown>, string, string, unknown?]> = [
      [() => auth.forgotPassword('a@b.test'), 'POST', '/api/auth/forgot', { email: 'a@b.test' }],
      [() => auth.resetPassword('tok', 'new password!'), 'POST', '/api/auth/reset', { token: 'tok', password: 'new password!' }],
      [() => auth.verifyEmail('tok'), 'POST', '/api/auth/verify', { token: 'tok' }],
      [() => auth.resendVerification(), 'POST', '/api/auth/resend-verification', {}],
      [() => auth.changePassword('old', 'new'), 'POST', '/api/me/password', { currentPassword: 'old', newPassword: 'new' }],
      [() => auth.sessions(), 'GET', '/api/me/sessions'],
      [() => auth.revokeSession('abc'), 'DELETE', '/api/me/sessions/abc'],
    ];
    for (const [call, method, url, body] of calls) {
      const pending = call();
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      if (body !== undefined) expect(req.request.body).toEqual(body);
      req.flush(null);
      await pending;
    }
    http.verify();
  });

  it('updateProfile stores the returned user; deleteAccount signs out', async () => {
    const p = auth.updateProfile({ displayName: 'Dame Ada' });
    const req = http.expectOne('/api/me');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ displayName: 'Dame Ada' });
    req.flush({ ...ada, displayName: 'Dame Ada' });
    await p;
    expect(auth.user()?.displayName).toBe('Dame Ada');

    const d = auth.deleteAccount('pw');
    const del = http.expectOne('/api/me');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toEqual({ password: 'pw' });
    del.flush(null);
    await d;
    expect(auth.signedIn()).toBe(false);
  });
});

describe('apiMessage', () => {
  it('prefers the server message, explains network failures, and falls back', () => {
    expect(apiMessage({ status: 409, error: { error: 'A tavern account already uses that email.' } })).toBe('A tavern account already uses that email.');
    expect(apiMessage({ status: 0 })).toMatch(/unreachable/);
    expect(apiMessage({ status: 500, error: {} })).toMatch(/try again/);
  });
});

describe('safeNext (open-redirect protection)', () => {
  it.each([
    ['/scroll/abc', '/scroll/abc'],
    ['/', '/'],
    [null, '/'],
    [undefined, '/'],
    ['https://evil.example', '/'],
    ['//evil.example/x', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
  ])('%j -> %j', (input, expected) => expect(safeNext(input as string | null)).toBe(expected));
});
