import { describe, it, expect } from 'vitest';
import ChatHeader from '../chat-header.svelte';
import StatusBanners from '../status-banners.svelte';

describe('ChatHeader and StatusBanners components', () => {
  it('imports without errors and components are defined', () => {
    expect(ChatHeader).toBeDefined();
    expect(StatusBanners).toBeDefined();
  });
});
