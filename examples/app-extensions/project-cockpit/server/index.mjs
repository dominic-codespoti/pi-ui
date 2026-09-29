export default {
  reads: {
    'project-summary': async (_input, ctx) => {
      const [packageJson, git] = await Promise.all([
        ctx.workspace.readJson('package.json').catch(() => null),
        ctx.cli.run('git', ['status', '--short'], {
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
        }),
      ]);

      return {
        packageJson,
        gitStatus: git.stdout,
        gitExitCode: git.exitCode,
      };
    },
  },
  actions: {
    'run-check': async (_input, ctx) =>
      ctx.cli.run('bun', ['run', 'check'], {
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      }),
  },
};
