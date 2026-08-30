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
  UpdateTarget,
} from '#lib/ws/protocol.js';

export class PanelsStore {
  /** All tools reported by the server */
  toolsList = $state<{ name: string; description: string; isBuiltin: boolean; origin?: string }[]>(
    []
  );

  /** Names of currently active/enabled tools */
  activeToolNames = $state<string[]>([]);

  /** Registered slash commands from extensions */
  extensionCommands = $state<{ name: string; description?: string; source: string }[]>([]);

  /** Skills returned by the server */
  resourcesSkills = $state<SkillSummary[]>([]);

  /** Prompt templates returned by the server */
  resourcesPrompts = $state<PromptSummary[]>([]);

  /** True once resources_list has been received (distinguishes "loading" from "empty") */
  resourcesLoaded = $state(false);

  /** Loaded extensions from the server */
  extensionsList = $state<ExtensionSummary[]>([]);

  extensionErrors = $state<{ path: string; error: string }[]>([]);

  /** True once extensions_list has been received */
  extensionsLoaded = $state(false);

  packagesList = $state<ConfiguredPackageInfo[]>([]);

  packageUpdates = $state<PackageUpdateInfo[]>([]);

  packagesLoaded = $state(false);

  packageBusy = $state(false);

  packageProgress = $state<PackageProgress | null>(null);

  sessionStats = $state<SessionStats | null>(null);

  exportFeedback = $state<string | null>(null);

  /** Update tab state */
  updateStatus = $state<UpdateStatus | null>(null);

  updateLoading = $state(false);

  updateRunning = $state(false);

  updateTarget = $state<UpdateTarget | null>(null);

  updateLog = $state('');

  updateFeedback = $state<{
    success: boolean;
    message: string;
    restartRequired?: boolean;
    reloadRequired?: boolean;
  } | null>(null);

  /** Install skill form state */
  skillInstallUrl = $state('');

  skillInstalling = $state(false);

  skillInstallFeedback = $state<{ success: boolean; message: string } | null>(null);

  /** Raw session tree data for the visual tree modal. */
  treeData = $state<TreeNode[]>([]);

  treeLoading = $state(false);

  /** Fork-able user message entries returned by the server */
  forkPoints = $state<{ entryId: string; text: string }[]>([]);

  /** True while waiting for the server to return fork_points */
  forkLoading = $state(false);

  // ── Message Handlers ───────────────────────────────────────────────────────

  handleToolsList(msg: Record<string, unknown>): void {
    this.toolsList =
      (msg.tools as
        | {
            name: string;
            description: string;
            isBuiltin: boolean;
            origin?: string;
          }[]
        | undefined) ?? [];

    this.activeToolNames = (msg.activeToolNames as string[] | undefined) ?? [];
  }

  handleResourcesList(msg: Record<string, unknown>): void {
    this.resourcesSkills = (msg.skills as SkillSummary[] | undefined) ?? [];
    this.resourcesPrompts = (msg.prompts as PromptSummary[] | undefined) ?? [];
    this.resourcesLoaded = true;
  }

  handleExtensionsList(msg: Record<string, unknown>): void {
    this.extensionsList = (msg.extensions as ExtensionSummary[] | undefined) ?? [];
    this.extensionErrors = (msg.errors as { path: string; error: string }[] | undefined) ?? [];
    this.extensionsLoaded = true;
  }

  handlePackagesList(msg: Record<string, unknown>): void {
    this.packagesList = (msg.packages as ConfiguredPackageInfo[] | undefined) ?? [];
    this.packageUpdates = (msg.updates as PackageUpdateInfo[] | undefined) ?? [];
    this.packagesLoaded = true;
  }

  handlePackageProgress(msg: Record<string, unknown>): void {
    const progress = msg.progress as PackageProgress;
    this.packageProgress = progress;
    this.packageBusy = progress.phase !== 'complete' && progress.phase !== 'error';
  }

  handlePackageResult(): void {
    this.packageBusy = false;
    this.packageProgress = null;
  }

  handleCommandsList(msg: Record<string, unknown>): void {
    this.extensionCommands =
      (msg.commands as { name: string; description?: string; source: string }[] | undefined) ?? [];
  }

  handleSkillInstallResult(msg: Record<string, unknown>): void {
    this.skillInstalling = false;
    if (msg.success) {
      this.skillInstallFeedback = { success: true, message: `Installed "${msg.name as string}"` };
      this.skillInstallUrl = '';
      this.resourcesLoaded = false;
    } else {
      this.skillInstallFeedback = {
        success: false,
        message: (msg.error as string) ?? 'Installation failed.',
      };
    }
  }

  handleSessionStats(msg: Record<string, unknown>): void {
    this.sessionStats = msg.stats as SessionStats;
  }

  handleExportResult(msg: Record<string, unknown>): void {
    this.exportFeedback = msg.error
      ? `Export failed: ${msg.error as string}`
      : `Exported to ${msg.path as string}`;
  }

  handleUpdateStatus(msg: Record<string, unknown>): void {
    const status = { ...(msg as unknown as UpdateStatus & { type?: string }) };
    delete status.type;
    this.updateStatus = status;
    this.updateLoading = false;
    this.updateRunning = status.busy;
  }

  handleUpdateProgress(msg: Record<string, unknown>): void {
    const progress = msg as {
      type: 'update_progress';
      target: UpdateTarget;
      command?: string;
      message: string;
    };
    this.updateRunning = true;
    this.updateTarget = progress.target;
    this.updateFeedback = null;
    this.updateLog = this.updateLog ? `${this.updateLog}\n\n${progress.message}` : progress.message;
  }

  handleUpdateResult(msg: Record<string, unknown>): void {
    const result = msg as {
      type: 'update_result';
      target: UpdateTarget;
      success: boolean;
      message: string;
      output?: string;
      restartRequired?: boolean;
      reloadRequired?: boolean;
    };
    this.updateRunning = false;
    this.updateTarget = null;
    this.updateFeedback = {
      success: result.success,
      message: result.message,
      restartRequired: result.restartRequired,
      reloadRequired: result.reloadRequired,
    };
    if (result.output) this.updateLog = result.output;
  }

  handleForkPoints(msg: Record<string, unknown>): void {
    this.forkPoints =
      (msg.entries as { entryId: string; text: string }[] | undefined) ??
      (msg.forkPoints as { entryId: string; text: string }[] | undefined) ??
      [];
    this.forkLoading = false;
  }

  handleSessionTree(msg: Record<string, unknown>): void {
    this.treeData = (msg.tree as TreeNode[] | undefined) ?? [];
    this.treeLoading = false;
  }

  /**
   * Reset transient state (busy, loading, progress, feedback) for reconnect parity.
   */
  reset(): void {
    this.packageBusy = false;
    this.packageProgress = null;
    this.exportFeedback = null;
    this.updateLoading = false;
    this.updateRunning = false;
    this.updateTarget = null;
    this.updateFeedback = null;
    this.skillInstalling = false;
    this.skillInstallFeedback = null;
    this.forkLoading = false;
    this.treeLoading = false;
  }
}
