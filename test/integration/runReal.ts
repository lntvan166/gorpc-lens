// Verify gorpc-lens against a real Go monorepo, not the synthetic fixture.
//
// Configure with a JSON file (see verify.example.json) and run:
//   GORPC_VERIFY_CONFIG=./verify.local.json npm run verify:real
//
// Nothing about any particular repository is committed here; the config file
// holding those details is gitignored.
import * as fs from 'fs';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const configPath = process.env.GORPC_VERIFY_CONFIG ?? 'verify.local.json';
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `no config at ${resolved}. Copy verify.example.json to verify.local.json and edit it, ` +
        `or set GORPC_VERIFY_CONFIG to another path.`,
    );
  }

  const config = JSON.parse(fs.readFileSync(resolved, 'utf8')) as { workspace?: string };
  if (!config.workspace || !fs.existsSync(config.workspace)) {
    throw new Error(`config "workspace" is missing or does not exist: ${config.workspace}`);
  }

  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode('stable'),
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'real', 'index'),
    launchArgs: [config.workspace, '--disable-workspace-trust'],
    extensionTestsEnv: { GORPC_VERIFY_CONFIG: resolved },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
