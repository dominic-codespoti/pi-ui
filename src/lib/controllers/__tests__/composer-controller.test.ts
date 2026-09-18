import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '#lib/ws/protocol.js';
import {
  ComposerController,
  buildPromptContent,
  canSubmitFollowUp,
  classifyComposerMessage,
  type ComposerContext,
} from '../composer-controller.js';

const context = (overrides: Partial<ComposerContext> = {}): ComposerContext => ({
  websocketOpen: true,
  loading: false,
  pendingNewSession: false,
  streaming: false,
  sessionId: 'session-1',
  ...overrides,
});

const file = (name: string, type: string, content = 'file') => new File([content], name, { type });

describe('ComposerController', () => {
  it('ingests mixed images and text files with the wire/display image split', async () => {
    const controller = new ComposerController({
      prepareImage: async () => ({ data: 'abc123', mimeType: 'image/webp' }),
      fileToText: async () => 'const answer = 42;',
    });

    const result = await controller.processAttachmentFiles([
      file('photo.png', 'image/png'),
      file('answer.ts', 'text/typescript', 'ignored by injected reader'),
    ]);

    expect(result.rejected).toEqual([]);
    expect(controller.current.attachedImages).toEqual([
      {
        data: 'abc123',
        mimeType: 'image/webp',
        name: 'photo.png',
        src: 'data:image/webp;base64,abc123',
      },
    ]);
    expect(controller.current.attachedFiles).toEqual([
      { name: 'answer.ts', content: 'const answer = 42;', size: 26 },
    ]);
  });

  it('returns spreadsheets and binary files for page-owned ingestion', async () => {
    const controller = new ComposerController({
      prepareImage: async () => ({ data: 'image', mimeType: 'image/png' }),
      fileToText: async () => 'text',
    });
    const spreadsheet = file(
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    const binary = file('archive.zip', 'application/zip');

    const result = await controller.processAttachmentFiles([
      spreadsheet,
      binary,
      file('notes.md', 'text/markdown'),
    ]);

    expect(result.unsupported).toEqual([spreadsheet, binary]);
    expect(result.rejected).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(controller.current.attachedFiles).toEqual([
      { name: 'notes.md', content: 'text', size: 4 },
    ]);
  });

  it('reports preparation/read failures and encoded image limits without mutating state', async () => {
    const controller = new ComposerController({
      maxImagePayload: 3,
      prepareImage: async (input) => {
        if (input.name === 'broken.png') return null;
        if (input.name === 'huge.png') return { data: '1234', mimeType: 'image/png' };
        return { data: 'ok', mimeType: 'image/png' };
      },
      fileToText: async () => {
        throw new Error('reader failed');
      },
    });

    const result = await controller.processAttachmentFiles([
      file('broken.png', 'image/png'),
      file('huge.png', 'image/png'),
      file('broken.md', 'text/markdown'),
    ]);

    expect(controller.current.attachedImages).toEqual([]);
    expect(controller.current.attachedFiles).toEqual([]);
    expect(result.rejected.map(({ name }) => name)).toEqual([
      'broken.png',
      'huge.png',
      'broken.md',
    ]);
    expect(result.notices.map(({ level }) => level)).toEqual(['warning', 'warning', 'warning']);
  });

  it('removes individual image and file attachments independently and clears both collections', async () => {
    const controller = new ComposerController({
      prepareImage: async () => ({ data: 'image', mimeType: 'image/png' }),
      fileToText: async () => 'text',
    });
    await controller.processAttachmentFiles([
      file('a.png', 'image/png'),
      file('a.md', 'text/markdown'),
    ]);

    expect(controller.removeAttachment(-1)).toBe(false);
    expect(controller.removeAttachment(1)).toBe(false);
    expect(controller.removeFileAttachment(-1)).toBe(false);
    expect(controller.removeFileAttachment(1)).toBe(false);
    expect(controller.removeAttachment(0)).toBe(true);
    expect(controller.current.attachedImages).toHaveLength(0);
    expect(controller.current.attachedFiles).toHaveLength(1);
    expect(controller.removeFileAttachment(0)).toBe(true);
    expect(controller.current.attachedImages).toHaveLength(0);
    expect(controller.current.attachedFiles).toHaveLength(0);
    await controller.processAttachmentFiles([
      file('b.png', 'image/png'),
      file('b.md', 'text/markdown'),
    ]);
    controller.clearAttachments();
    expect(controller.current.attachedImages).toEqual([]);
    expect(controller.current.attachedFiles).toEqual([]);
  });

  it('guards disconnected, loading, and empty submissions', () => {
    const controller = new ComposerController({ send: vi.fn(() => true) });
    const send = controller.submit();
    expect(send).toMatchObject({ accepted: false, reason: 'disconnected' });
    controller.updateContext(context({ loading: true }));
    expect(controller.submit()).toMatchObject({ accepted: false, reason: 'loading' });
    controller.updateContext(context({ loading: false }));

    expect(controller.submit()).toMatchObject({ accepted: false, reason: 'empty' });
  });

  it('builds a normal prompt with wrapped file text, images, and session correlation', async () => {
    const sent: ClientMessage[] = [];
    const controller = new ComposerController({
      send: (message) => {
        sent.push(message);
        return true;
      },
      prepareImage: async () => ({ data: 'raw', mimeType: 'image/jpeg' }),
      fileToText: async () => 'contents',
      createId: () => 'message-1',
      now: () => 123,
    });
    controller.updateContext(context());
    controller.setInput('please inspect');
    await controller.processAttachmentFiles([
      file('readme.md', 'text/markdown'),
      file('shot.jpg', 'image/jpeg'),
    ]);

    const result = controller.submit();
    expect(sent).toEqual([
      {
        type: 'prompt',
        sessionId: 'session-1',
        message: 'Content of readme.md:\ncontents\n\n---\n\nplease inspect',
        images: [{ data: 'raw', mimeType: 'image/jpeg' }],
      },
    ]);
    expect(result).toMatchObject({ accepted: true, kind: 'prompt' });
    expect(result).toHaveProperty('userMessage', {
      id: 'message-1',
      role: 'user',
      content: 'Content of readme.md:\ncontents\n\n---\n\nplease inspect',
      images: ['data:image/jpeg;base64,raw'],
      streaming: false,
      createdAt: 123,
    });
    expect(controller.current).toEqual({ input: '', attachedImages: [], attachedFiles: [] });
  });

  it('steers while streaming and submits follow-up while idle', () => {
    const sent: ClientMessage[] = [];
    const controller = new ComposerController({
      send: (message) => {
        sent.push(message);
      },
    });
    controller.updateContext(context({ streaming: true }));
    controller.setInput('keep going');
    expect(controller.submit()).toMatchObject({ accepted: true, kind: 'steer' });

    controller.updateContext(context({ streaming: false }));
    controller.setInput('continue when ready');
    expect(controller.canSubmitFollowUp()).toBe(true);
    expect(controller.submit(true)).toMatchObject({ accepted: true, kind: 'follow_up' });
    expect(sent).toEqual([
      { type: 'steer', sessionId: 'session-1', message: 'keep going' },
      { type: 'follow_up', sessionId: 'session-1', message: 'continue when ready' },
    ]);
  });

  it('classifies shell/slash text and preserves streaming command restrictions', () => {
    expect(classifyComposerMessage('! git status')).toEqual({
      kind: 'shell',
      command: 'git status',
      text: '! git status',
    });
    expect(classifyComposerMessage('/reload now', [], true)).toMatchObject({
      kind: 'slash',
      command: 'reload',
      args: 'now',
      route: 'reload',
      blockedWhileStreaming: true,
    });
    expect(classifyComposerMessage('/deploy prod', ['deploy'])).toMatchObject({
      kind: 'slash',
      command: 'deploy',
      args: 'prod',
      route: 'extension',
    });
    expect(classifyComposerMessage('/unknown text')).toMatchObject({
      kind: 'slash',
      route: 'unknown',
    });
    expect(classifyComposerMessage('   !   ')).toEqual({ kind: 'prompt', text: '!' });
  });

  it('sends lone ! as a normal prompt while ! command remains shell', () => {
    const sent: ClientMessage[] = [];
    const controller = new ComposerController({
      send: (message) => {
        sent.push(message);
      },
    });
    controller.updateContext(context());
    controller.setInput('  !  ');

    expect(controller.submit()).toMatchObject({ accepted: true, kind: 'prompt' });
    expect(sent).toEqual([{ type: 'prompt', sessionId: 'session-1', message: '!' }]);
  });

  it('retains attachments after a streaming steer for the next normal prompt', async () => {
    const sent: ClientMessage[] = [];
    const controller = new ComposerController({
      send: (message) => {
        sent.push(message);
      },
      prepareImage: async () => ({ data: 'raw', mimeType: 'image/png' }),
      fileToText: async () => 'contents',
    });
    controller.updateContext(context({ streaming: true }));
    await controller.processAttachmentFiles([
      file('notes.md', 'text/markdown'),
      file('shot.png', 'image/png'),
    ]);
    controller.setInput('keep going');

    expect(controller.submit()).toMatchObject({ accepted: true, kind: 'steer' });
    expect(controller.current.input).toBe('');
    expect(controller.current.attachedFiles).toHaveLength(1);
    expect(controller.current.attachedImages).toHaveLength(1);

    controller.updateContext(context({ streaming: false }));
    controller.setInput('continue when ready');
    expect(controller.submit()).toMatchObject({ accepted: true, kind: 'prompt' });
    expect(sent).toEqual([
      { type: 'steer', sessionId: 'session-1', message: 'keep going' },
      {
        type: 'prompt',
        sessionId: 'session-1',
        message: 'Content of notes.md:\ncontents\n\n---\n\ncontinue when ready',
        images: [{ data: 'raw', mimeType: 'image/png' }],
      },
    ]);
    expect(controller.current).toEqual({ input: '', attachedImages: [], attachedFiles: [] });
  });

  it('routes shell commands and stamps command messages with sessionId', () => {
    const sent: ClientMessage[] = [];
    const controller = new ComposerController({
      send: (message) => {
        sent.push(message);
      },
    });
    controller.updateContext(context());
    controller.setInput('! pwd');
    expect(controller.submit()).toMatchObject({ accepted: true, kind: 'command' });
    expect(sent).toEqual([
      { type: 'run_builtin', sessionId: 'session-1', command: 'shell', args: 'pwd' },
    ]);
  });

  it('retains the draft when transport rejects a send', () => {
    const controller = new ComposerController({ send: () => false });
    controller.updateContext(context());
    controller.setInput('do not lose this');
    const result = controller.submit();
    expect(result).toMatchObject({ accepted: false, reason: 'send_rejected' });
    expect(controller.current.input).toBe('do not lose this');
  });

  it('retains draft and attachments when no send callback is configured', async () => {
    const controller = new ComposerController({
      prepareImage: async () => ({ data: 'image', mimeType: 'image/png' }),
      fileToText: async () => 'text',
    });
    controller.updateContext(context());
    controller.setInput('do not lose these');
    await controller.processAttachmentFiles([
      file('notes.md', 'text/markdown'),
      file('shot.png', 'image/png'),
    ]);

    const result = controller.submit();

    expect(result).toMatchObject({ accepted: false, reason: 'send_rejected' });
    expect(controller.current.input).toBe('do not lose these');
    expect(controller.current.attachedFiles).toHaveLength(1);
    expect(controller.current.attachedImages).toHaveLength(1);
  });

  it('captures and restores a draft around an explicit pending new-session failure', () => {
    const controller = new ComposerController();
    controller.updateContext(context());
    controller.setInput('draft for the next session');
    controller.updateContext(context({ pendingNewSession: true }));
    expect(controller.current.input).toBe('');
    controller.updateContext(context({ sessionError: 'new session failed' }));
    expect(controller.current.input).toBe('draft for the next session');
  });

  it('exposes pure prompt and follow-up eligibility helpers', () => {
    const image = {
      data: 'x',
      mimeType: 'image/png',
      name: 'x.png',
      src: 'data:image/png;base64,x',
    };
    const prompt = buildPromptContent('hello', [image], [], 's-1');
    expect(prompt).toEqual({
      type: 'prompt',
      sessionId: 's-1',
      message: 'hello',
      images: [{ data: 'x', mimeType: 'image/png' }],
    });
    expect(
      canSubmitFollowUp(context(), { input: 'hello', attachedImages: [], attachedFiles: [] })
    ).toBe(true);
  });
});
