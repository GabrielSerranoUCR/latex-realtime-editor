import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ScrollsService, canWrite, timeAgo } from './scrolls.service';

describe('ScrollsService', () => {
  let api: ScrollsService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ScrollsService);
    http = TestBed.inject(HttpTestingController);
  });

  it('talks to the documented endpoints', async () => {
    const calls: Array<[() => Promise<unknown>, string, string, unknown?]> = [
      [() => api.list(), 'GET', '/api/scrolls'],
      [() => api.create('T'), 'POST', '/api/scrolls', { title: 'T' }],
      [() => api.rename('s1', 'N'), 'PATCH', '/api/scrolls/s1', { title: 'N' }],
      [() => api.remove('s1'), 'DELETE', '/api/scrolls/s1'],
      [() => api.members('s1'), 'GET', '/api/scrolls/s1/members'],
      [() => api.invite('s1', 'a@b.test', 'reader'), 'POST', '/api/scrolls/s1/invitations', { email: 'a@b.test', role: 'reader' }],
      [() => api.pendingInvites('s1'), 'GET', '/api/scrolls/s1/invitations'],
      [() => api.revokeInvite('s1', 'i1'), 'DELETE', '/api/scrolls/s1/invitations/i1'],
      [() => api.myInvites(), 'GET', '/api/invitations'],
      [() => api.getInvite('i1'), 'GET', '/api/invitations/i1'],
      [() => api.acceptInvite('i1'), 'POST', '/api/invitations/i1/accept', {}],
      [() => api.declineInvite('i1'), 'DELETE', '/api/invitations/i1'],
      [() => api.setRole('s1', 'u9', 'scribe'), 'PUT', '/api/scrolls/s1/members/u9', { role: 'scribe' }],
      [() => api.removeMember('s1', 'u9'), 'DELETE', '/api/scrolls/s1/members/u9'],
    ];
    for (const [call, method, url, body] of calls) {
      const pending = call(); // one request at a time
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      if (body !== undefined) expect(req.request.body).toEqual(body);
      req.flush(null);
      await pending;
    }
    http.verify();
  });
});

describe('canWrite', () => {
  it('owners and scribes write; readers and unknown roles do not', () => {
    expect([canWrite('owner'), canWrite('scribe'), canWrite('reader'), canWrite(null), canWrite(undefined)]).toEqual([true, true, false, false, false]);
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);
  it('uses friendly relative phrases', () => {
    expect(ago(5)).toBe('just now');
    expect(ago(60)).toBe('1 minute ago');
    expect(ago(3 * 60)).toBe('3 minutes ago');
    expect(ago(3600)).toBe('1 hour ago');
    expect(ago(5 * 3600)).toBe('5 hours ago');
    expect(ago(86400)).toBe('1 day ago');
    expect(ago(3 * 86400)).toBe('3 days ago');
    expect(ago(14 * 86400)).toBe('2 weeks ago');
    expect(ago(400 * 86400)).toBe('1 year ago');
  });
  it('never shows negative time for clock skew', () => expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe('just now'));
});
