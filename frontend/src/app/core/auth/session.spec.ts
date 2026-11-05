import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { sessionInterceptor } from './session.interceptor';

const ada = { id: '1', email: 'ada@guild.test', displayName: 'Ada', color: '#C9A04A', emailVerified: true, affiliation: '' };

describe('a session that ends', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([sessionInterceptor])), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  const fail = (url: string, status: number) => {
    client.get(url).subscribe({ error: () => undefined });
    http.expectOne(url).flush({ error: 'no' }, { status, statusText: 'x' });
  };

  it('is noticed when the API turns a signed-in person away', () => {
    auth.user.set(ada);
    fail('/api/scrolls', 401);
    expect(auth.endedFor()).toBe('ada@guild.test');
    expect(auth.user()).toEqual(ada); // the page behind keeps who they were
  });

  it('is not mistaken for other trouble: a 404, a wrong password, or nobody having been signed in', () => {
    auth.user.set(ada);
    fail('/api/scrolls/x', 404);
    fail('/api/auth/login', 401);
    expect(auth.endedFor()).toBeNull();
    auth.user.set(null);
    fail('/api/scrolls', 401);
    expect(auth.endedFor()).toBeNull();
  });

  it('checkSession: a refusal ends it, a network failure proves nothing, a yes refreshes', async () => {
    auth.user.set(ada);
    let p = auth.checkSession();
    http.expectOne('/api/me').flush({}, { status: 401, statusText: 'x' });
    expect(await p).toBe(false);
    expect(auth.endedFor()).toBe('ada@guild.test');

    auth.endedFor.set(null);
    p = auth.checkSession();
    http.expectOne('/api/me').error(new ProgressEvent('error'));
    expect(await p).toBe(true);
    expect(auth.endedFor()).toBeNull();

    p = auth.checkSession();
    http.expectOne('/api/me').flush({ ...ada, displayName: 'Ada L.' });
    expect(await p).toBe(true);
    expect(auth.user()?.displayName).toBe('Ada L.');
  });

  it('signing in again clears it', async () => {
    auth.user.set(ada);
    auth.markSessionEnded();
    const p = auth.signInAgain('ada@guild.test', 'a long enough password');
    http.expectOne('/api/auth/login').flush(ada);
    await p;
    expect(auth.endedFor()).toBeNull();
    expect(auth.user()).toEqual(ada);
  });

  it('signing in somewhere else (another tab, an emailed link) is noticed too', async () => {
    auth.user.set(ada);
    auth.markSessionEnded();
    let p = auth.recoverSession();
    http.expectOne('/api/me').flush({}, { status: 401, statusText: 'x' });
    expect(await p).toBe(false);
    expect(auth.endedFor()).not.toBeNull();
    p = auth.recoverSession();
    http.expectOne('/api/me').flush(ada);
    expect(await p).toBe(true);
    expect(auth.endedFor()).toBeNull();
  });

  it('ending it twice, or with nobody signed in, does nothing odd', () => {
    auth.markSessionEnded();
    expect(auth.endedFor()).toBeNull();
    auth.user.set(ada);
    auth.markSessionEnded();
    auth.user.set({ ...ada, email: 'other@guild.test' });
    auth.markSessionEnded();
    expect(auth.endedFor()).toBe('ada@guild.test'); // the first one stands
  });
});

describe('magic links in the browser', () => {
  it('asks for a link, and trades the token for a signed-in session', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const auth = TestBed.inject(AuthService);
    const http = TestBed.inject(HttpTestingController);

    const sent = auth.requestMagicLink('ada@guild.test');
    const req = http.expectOne('/api/auth/magic');
    expect(req.request.body).toEqual({ email: 'ada@guild.test' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await sent;

    const used = auth.useMagicLink('tok');
    const consume = http.expectOne('/api/auth/magic/consume');
    expect(consume.request.body).toEqual({ token: 'tok' });
    consume.flush(ada);
    await used;
    expect(auth.user()).toEqual(ada);
    expect(auth.ready()).toBe(true);
  });
});
