import { beforeEach, describe, expect, it } from 'vitest';
import { PanelsStore } from '../panels-store.svelte.js';
import type {
  ConfiguredPackageInfo,
  ExtensionSummary,
  PackageProgress,
  PackageUpdateInfo,
  PromptSummary,
  SessionStats,
  SkillSummary,
  TreeNode,
  UpdateStatus,
} from '#lib/ws/protocol.js';

describe('PanelsStore', () => {
  let store: PanelsStore;

  beforeEach(() => {
    store = new PanelsStore();
  });

  it('initializes with expected default values', () => {
    expect(store.toolsList).toEqual([]);
    expect(store.activeToolNames).toEqual([]);
    expect(store.extensionCommands).toEqual([]);
    expect(store.resourcesSkills).toEqual([]);
    expect(store.resourcesPrompts).toEqual([]);
    expect(store.resourcesLoaded).toBe(false);
    expect(store.extensionsList).toEqual([]);
    expect(store.extensionErrors).toEqual([]);
    expect(store.extensionsLoaded).toBe(false);
    expect(store.packagesList).toEqual([]);
    expect(store.packageUpdates).toEqual([]);
    expect(store.packagesLoaded).toBe(false);
    expect(store.packageBusy).toBe(false);
    expect(store.packageProgress).toBeNull();
    expect(store.sessionStats).toBeNull();
    expect(store.exportFeedback).toBeNull();
    expect(store.updateStatus).toBeNull();
    expect(store.updateLoading).toBe(false);
    expect(store.updateRunning).toBe(false);
    expect(store.updateTarget).toBeNull();
    expect(store.updateLog).toBe('');
    expect(store.updateFeedback).toBeNull();
    expect(store.skillInstallUrl).toBe('');
    expect(store.skillInstalling).toBe(false);
    expect(store.skillInstallFeedback).toBeNull();
    expect(store.treeData).toEqual([]);
    expect(store.treeLoading).toBe(false);
    expect(store.forkPoints).toEqual([]);
    expect(store.forkLoading).toBe(false);
  });

  it('handleToolsList assigns tools and activeToolNames with ?? [] fallback', () => {
    store.handleToolsList({
      tools: [
        { name: 'bash', description: 'Run bash command', isBuiltin: true },
        { name: 'read', description: 'Read file', isBuiltin: true, origin: 'pi' },
      ],
      activeToolNames: ['bash'],
    });

    expect(store.toolsList).toEqual([
      { name: 'bash', description: 'Run bash command', isBuiltin: true },
      { name: 'read', description: 'Read file', isBuiltin: true, origin: 'pi' },
    ]);
    expect(store.activeToolNames).toEqual(['bash']);

    store.handleToolsList({});
    expect(store.toolsList).toEqual([]);
    expect(store.activeToolNames).toEqual([]);
  });

  it('handleResourcesList assigns skills and prompts, sets resourcesLoaded = true', () => {
    const skills: SkillSummary[] = [
      {
        name: 'git',
        description: 'Git helper',
        scope: 'user',
        isBuiltin: false,
        source: '/skills/git.md',
      },
    ];
    const prompts: PromptSummary[] = [
      {
        name: 'review',
        description: 'Code review',
        scope: 'project',
        isBuiltin: false,
        source: '/prompts/review.md',
      },
    ];

    store.handleResourcesList({ skills, prompts });

    expect(store.resourcesSkills).toEqual(skills);
    expect(store.resourcesPrompts).toEqual(prompts);
    expect(store.resourcesLoaded).toBe(true);

    store.handleResourcesList({});
    expect(store.resourcesSkills).toEqual([]);
    expect(store.resourcesPrompts).toEqual([]);
    expect(store.resourcesLoaded).toBe(true);
  });

  it('handleExtensionsList assigns extensions and errors, sets extensionsLoaded = true', () => {
    const extensions: ExtensionSummary[] = [
      {
        source: 'my-ext',
        path: '/ext/1',
        scope: 'user',
        origin: 'top-level',
        tools: [{ name: 'ext_tool', description: 'Tool from extension' }],
        commands: [{ name: 'ext_cmd', description: 'Command from extension' }],
      },
    ];
    const errors = [{ path: '/ext/bad', error: 'Failed to load' }];

    store.handleExtensionsList({ extensions, errors });

    expect(store.extensionsList).toEqual(extensions);
    expect(store.extensionErrors).toEqual(errors);
    expect(store.extensionsLoaded).toBe(true);

    store.handleExtensionsList({});
    expect(store.extensionsList).toEqual([]);
    expect(store.extensionErrors).toEqual([]);
    expect(store.extensionsLoaded).toBe(true);
  });

  it('handlePackagesList assigns packages and updates, sets packagesLoaded = true', () => {
    const packages: ConfiguredPackageInfo[] = [
      { source: 'npm:@org/pkg', scope: 'user', filtered: false },
    ];
    const updates: PackageUpdateInfo[] = [
      {
        source: 'npm:@org/pkg',
        displayName: '@org/pkg',
        type: 'npm',
        scope: 'user',
      },
    ];

    store.handlePackagesList({ packages, updates });

    expect(store.packagesList).toEqual(packages);
    expect(store.packageUpdates).toEqual(updates);
    expect(store.packagesLoaded).toBe(true);

    store.handlePackagesList({});
    expect(store.packagesList).toEqual([]);
    expect(store.packageUpdates).toEqual([]);
    expect(store.packagesLoaded).toBe(true);
  });

  it('handlePackageProgress and handlePackageResult track package_busy transitions', () => {
    const progressActive: PackageProgress = {
      phase: 'progress',
      action: 'install',
      source: 'npm:@org/pkg',
      message: 'Downloading package...',
    };
    store.handlePackageProgress({ progress: progressActive });
    expect(store.packageProgress).toEqual(progressActive);
    expect(store.packageBusy).toBe(true);

    const progressComplete: PackageProgress = {
      phase: 'complete',
      action: 'install',
      source: 'npm:@org/pkg',
      message: 'Package installed successfully.',
    };
    store.handlePackageProgress({ progress: progressComplete });
    expect(store.packageProgress).toEqual(progressComplete);
    expect(store.packageBusy).toBe(false);

    const progressError: PackageProgress = {
      phase: 'error',
      action: 'install',
      source: 'npm:@org/pkg',
      message: 'Package download failed.',
    };
    store.handlePackageProgress({ progress: progressError });
    expect(store.packageProgress).toEqual(progressError);
    expect(store.packageBusy).toBe(false);

    store.handlePackageProgress({
      progress: {
        phase: 'progress',
        action: 'install',
        source: 'npm:@org/pkg',
        message: 'Building...',
      },
    });
    expect(store.packageBusy).toBe(true);

    store.handlePackageResult();
    expect(store.packageBusy).toBe(false);
    expect(store.packageProgress).toBeNull();
  });

  it('handleCommandsList assigns extensionCommands', () => {
    const commands = [{ name: 'testcmd', description: 'Runs a test', source: 'my-ext' }];
    store.handleCommandsList({ commands });
    expect(store.extensionCommands).toEqual(commands);

    store.handleCommandsList({});
    expect(store.extensionCommands).toEqual([]);
  });

  it('handleSkillInstallResult handles success and failure paths', () => {
    store.skillInstalling = true;
    store.skillInstallUrl = 'https://example.com/skill.md';
    store.resourcesLoaded = true;

    // Success path
    store.handleSkillInstallResult({ success: true, name: 'my-skill' });
    expect(store.skillInstalling).toBe(false);
    expect(store.skillInstallFeedback).toEqual({
      success: true,
      message: 'Installed "my-skill"',
    });
    expect(store.skillInstallUrl).toBe('');
    expect(store.resourcesLoaded).toBe(false);

    // Failure path
    store.skillInstalling = true;
    store.handleSkillInstallResult({ success: false, error: 'Network error' });
    expect(store.skillInstalling).toBe(false);
    expect(store.skillInstallFeedback).toEqual({
      success: false,
      message: 'Network error',
    });

    // Failure fallback message
    store.handleSkillInstallResult({ success: false });
    expect(store.skillInstallFeedback).toEqual({
      success: false,
      message: 'Installation failed.',
    });
  });

  it('handleSessionStats assigns sessionStats', () => {
    const stats: SessionStats = {
      sessionId: 'sess-123',
      userMessages: 5,
      assistantMessages: 7,
      toolCalls: 4,
      toolResults: 4,
      totalMessages: 12,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.005,
    };
    store.handleSessionStats({ stats });
    expect(store.sessionStats).toEqual(stats);
  });

  it('handleExportResult formats feedback string correctly', () => {
    store.handleExportResult({ path: '/tmp/session.html' });
    expect(store.exportFeedback).toBe('Exported to /tmp/session.html');

    store.handleExportResult({ error: 'Permission denied' });
    expect(store.exportFeedback).toBe('Export failed: Permission denied');
  });

  it('handleUpdateStatus, handleUpdateProgress, and handleUpdateResult lifecycle', () => {
    const status: UpdateStatus = {
      ui: { name: 'pi-ui', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
      sdk: { name: 'pi-sdk', current: '0.9.0', latest: '0.9.0', updateAvailable: false },
      appRoot: '/home/dom/projects/pi-ui-2',
      mode: 'source',
      canUpdateUi: true,
      canUpdateSdk: false,
      busy: false,
      notes: ['Release notes here'],
    };

    store.updateLoading = true;
    store.handleUpdateStatus({ type: 'update_status', ...status });
    expect(store.updateStatus).toEqual(status);
    expect(store.updateLoading).toBe(false);
    expect(store.updateRunning).toBe(false);

    // Progress
    store.handleUpdateProgress({
      type: 'update_progress',
      target: 'ui',
      message: 'Pulling git repo...',
    });
    expect(store.updateRunning).toBe(true);
    expect(store.updateTarget).toBe('ui');
    expect(store.updateFeedback).toBeNull();
    expect(store.updateLog).toBe('Pulling git repo...');

    // Progress append log
    store.handleUpdateProgress({
      type: 'update_progress',
      target: 'ui',
      message: 'Building assets...',
    });
    expect(store.updateLog).toBe('Pulling git repo...\n\nBuilding assets...');

    // Result
    store.handleUpdateResult({
      type: 'update_result',
      target: 'ui',
      success: true,
      message: 'Update complete.',
      output: 'Build finished in 2.1s',
      restartRequired: true,
      reloadRequired: true,
    });
    expect(store.updateRunning).toBe(false);
    expect(store.updateTarget).toBeNull();
    expect(store.updateFeedback).toEqual({
      success: true,
      message: 'Update complete.',
      restartRequired: true,
      reloadRequired: true,
    });
    expect(store.updateLog).toBe('Build finished in 2.1s');
  });

  it('handleForkPoints handles entries/forkPoints payloads and clears forkLoading', () => {
    store.forkLoading = true;
    const entries = [{ entryId: 'e1', text: 'hello' }];

    store.handleForkPoints({ entries });
    expect(store.forkPoints).toEqual(entries);
    expect(store.forkLoading).toBe(false);

    store.forkLoading = true;
    store.handleForkPoints({ forkPoints: entries });
    expect(store.forkPoints).toEqual(entries);
    expect(store.forkLoading).toBe(false);

    store.handleForkPoints({});
    expect(store.forkPoints).toEqual([]);
  });

  it('handleSessionTree assigns treeData and clears treeLoading', () => {
    store.treeLoading = true;
    const tree: TreeNode[] = [{ entryId: '1', type: 'user', label: 'Root node', children: [] }];

    store.handleSessionTree({ tree });
    expect(store.treeData).toEqual(tree);
    expect(store.treeLoading).toBe(false);

    store.handleSessionTree({});
    expect(store.treeData).toEqual([]);
  });

  it('reset clears transient flags and feedback', () => {
    store.packageBusy = true;
    store.packageProgress = {
      phase: 'progress',
      action: 'install',
      source: 'npm:@org/pkg',
      message: 'test',
    };
    store.exportFeedback = 'Exported to /test';
    store.updateLoading = true;
    store.updateRunning = true;
    store.updateTarget = 'ui';
    store.updateFeedback = { success: true, message: 'Done' };
    store.skillInstalling = true;
    store.skillInstallFeedback = { success: true, message: 'Done' };
    store.forkLoading = true;
    store.treeLoading = true;

    store.reset();

    expect(store.packageBusy).toBe(false);
    expect(store.packageProgress).toBeNull();
    expect(store.exportFeedback).toBeNull();
    expect(store.updateLoading).toBe(false);
    expect(store.updateRunning).toBe(false);
    expect(store.updateTarget).toBeNull();
    expect(store.updateFeedback).toBeNull();
    expect(store.skillInstalling).toBe(false);
    expect(store.skillInstallFeedback).toBeNull();
    expect(store.forkLoading).toBe(false);
    expect(store.treeLoading).toBe(false);
  });
});
