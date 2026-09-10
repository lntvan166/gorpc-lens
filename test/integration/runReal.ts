// One-off verification against the real reference workspace.
// Not part of `npm run test:integration`; run with `npm run verify:real`.
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const reference = process.env.GORPC_reference ?? '<monorepo>';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'ref', 'index');
  const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [reference, '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
