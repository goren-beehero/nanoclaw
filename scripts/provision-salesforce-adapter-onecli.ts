import fs from 'node:fs';
import path from 'node:path';

import { OneCLI } from '@onecli-sh/sdk';

const runtimeDir = '/opt/nanoclaw/integrations/salesforce-readonly-adapter/runtime';
const agentIdentifier = 'bobi-salesforce-readonly-adapter';

if (process.getuid?.() !== 0) throw new Error('Provisioning must run as root');
const apiKey = process.env.ONECLI_API_KEY;
const url = process.env.ONECLI_URL;
if (!apiKey || !url) throw new Error('Privileged OneCLI configuration is required');

const onecli = new OneCLI({ apiKey, url });
await onecli.ensureAgent({ name: 'Bobi Salesforce readonly adapter', identifier: agentIdentifier });
const config = await onecli.getContainerConfig({ agent: agentIdentifier });
const httpsProxy = config.env.HTTPS_PROXY;
if (!httpsProxy || /[\r\n\0]/.test(httpsProxy)) throw new Error('Scoped OneCLI HTTPS proxy configuration is invalid');
if (!config.caCertificate || /\0/.test(config.caCertificate)) throw new Error('Scoped OneCLI CA is invalid');

fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
fs.chmodSync(runtimeDir, 0o700);
atomicWrite(path.join(runtimeDir, 'ca.pem'), `${config.caCertificate.trim()}\n`, 0o644);
atomicWrite(
  path.join(runtimeDir, 'onecli.env'),
  `HTTPS_PROXY=${httpsProxy}\nONECLI_CA_PATH=${path.join(runtimeDir, 'ca.pem')}\n`,
  0o600,
);

process.stdout.write('adapter_onecli_runtime=READY\n');

function atomicWrite(target: string, content: string, mode: number): void {
  const temporary = `${target}.new`;
  fs.writeFileSync(temporary, content, { mode, flag: 'w' });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
}
