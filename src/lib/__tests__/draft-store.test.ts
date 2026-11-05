import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_STORE_KEY,
  DRAFT_TTL_MS,
  MAX_DRAFTS,
  MAX_DRAFT_CHARS,
  clearDraft,
  loadDraft,
  saveDraft,
} from '../draft-store';

describe('draft-store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a draft per session', () => {
    saveDraft('s1', 'hello');
    saveDraft('s2', 'other');
    expect(loadDraft('s1')).toBe('hello');
    expect(loadDraft('s2')).toBe('other');
    expect(loadDraft('s3')).toBeNull();
  });

  it('forgets blank drafts and removes the key when empty', () => {
    saveDraft('s1', 'hello');
    saveDraft('s1', '   ');
    expect(loadDraft('s1')).toBeNull();
    expect(localStorage.getItem(DRAFT_STORE_KEY)).toBeNull();
    saveDraft('s2', 'x');
    clearDraft('s2');
    expect(loadDraft('s2')).toBeNull();
  });

  it('expires drafts older than the TTL', () => {
    saveDraft('s1', 'old', 1_000);
    expect(loadDraft('s1', 1_000 + DRAFT_TTL_MS - 1)).toBe('old');
    expect(loadDraft('s1', 1_000 + DRAFT_TTL_MS + 1)).toBeNull();
  });

  it('keeps only the most recent drafts and caps their size', () => {
    for (let i = 0; i < MAX_DRAFTS + 5; i++) saveDraft(`s${i}`, `d${i}`, 10_000 + i);
    const now = 10_000 + MAX_DRAFTS + 5;
    expect(loadDraft('s0', now)).toBeNull();
    expect(loadDraft(`s${MAX_DRAFTS + 4}`, now)).toBe(`d${MAX_DRAFTS + 4}`);
    saveDraft('big', 'x'.repeat(MAX_DRAFT_CHARS + 10), now);
    expect(loadDraft('big', now)?.length).toBe(MAX_DRAFT_CHARS);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem(DRAFT_STORE_KEY, '{not json');
    expect(loadDraft('s1')).toBeNull();
    saveDraft('s1', 'fresh');
    expect(loadDraft('s1')).toBe('fresh');
  });
});
