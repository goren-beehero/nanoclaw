import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');

describe('BeeHero Python/AWS tooling in the agent image', () => {
  it('pins the image Python version to agents-team Python 3.11', () => {
    expect(dockerfile).toMatch(/^ARG PYTHON_VERSION=3\.11$/m);
    expect(dockerfile).toMatch(/python\$\{PYTHON_VERSION\}/);
    expect(dockerfile).toMatch(/python\$\{PYTHON_VERSION\}-venv/);
  });

  it('puts the BeeHero Python venv on PATH', () => {
    expect(dockerfile).toMatch(/^ENV BEEHERO_PYTHON_VENV=\/opt\/beehero-python$/m);
    expect(dockerfile).toMatch(/ENV PATH="\$\{BEEHERO_PYTHON_VENV\}\/bin:\$\{PATH\}"/);
  });

  it('installs the AWS and agents-team Python packages', () => {
    for (const pkg of ['awscli', 'boto3', 'awswrangler', 'plotly', 'astral==3.2']) {
      expect(dockerfile).toContain(pkg);
    }
  });
});
