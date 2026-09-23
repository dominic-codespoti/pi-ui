import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { rolldown } from 'rolldown';

const files = fileURLToPath(new URL('./files', import.meta.url).href);

export default function adapter(options = {}) {
  const { out = 'build', precompress = true, envPrefix = '', serveAssets = true } = options;

  return {
    name: 'svelte-adapter-bun',
    async adapt(builder) {
      const adapterDirectory = builder.getBuildDirectory('adapter-bun');
      const base = builder.config.paths?.base ?? '';
      const appDir = builder.config.appDir ?? '_app';

      builder.rimraf(out);
      builder.rimraf(adapterDirectory);
      builder.mkdirp(adapterDirectory);
      builder.log.minor('Copying assets');
      builder.writeClient(`${out}/client${base}`);
      builder.writePrerendered(`${out}/prerendered${base}`);

      if (precompress) {
        builder.log.minor('Compressing assets');
        await Promise.all([
          builder.compress(`${out}/client`),
          builder.compress(`${out}/prerendered`)
        ]);
      }

      builder.log.minor('Building server');
      builder.writeServer(adapterDirectory);
      await builder.generateServerInstance(`${adapterDirectory}/instance.js`);
      writeFileSync(
        `${adapterDirectory}/manifest.js`,
        [
          `export const appDir = ${JSON.stringify(appDir)};`,
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
          `export const base = ${JSON.stringify(base)};`
        ].join('\n\n')
      );

      const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));
      const entries = {
        index: `${adapterDirectory}/index.js`,
        instance: `${adapterDirectory}/instance.js`,
        manifest: `${adapterDirectory}/manifest.js`
      };
      if (builder.hasServerInstrumentationFile?.()) {
        entries['instrumentation.server'] = `${adapterDirectory}/instrumentation.server.js`;
      }

      await rolldown({
        input: entries,
        external: [
          ...Object.keys(packageJson.dependencies || {}).map(
            (name) => new RegExp(`^${name}(\\/.*)?$`)
          ),
          /^node:/
        ]
      }).then((bundle) =>
        bundle.write({
          dir: `${out}/server`,
          format: 'esm',
          sourcemap: true,
          chunkFileNames: 'chunks/[name]-[hash].js'
        })
      );

      builder.copy(files, out, {
        replace: {
          ENV: './env.js',
          HANDLER: './handler.js',
          MANIFEST: './server/manifest.js',
          SERVER: './server/instance.js',
          ENV_PREFIX: JSON.stringify(envPrefix),
          BUILD_OPTIONS: JSON.stringify({ serveAssets })
        }
      });

      if (builder.hasServerInstrumentationFile?.()) {
        builder.instrument?.({
          entrypoint: `${out}/index.js`,
          instrumentation: `${out}/server/instrumentation.server.js`,
          module: { exports: ['path', 'host', 'port', 'server'] }
        });
      }
    },
    supports: {
      read: () => true,
      instrumentation: () => true
    }
  };
}

