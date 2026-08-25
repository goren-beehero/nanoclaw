import { OPERATIONS } from './core.js';

export function auditLine(operation: string, outcome: string, durationMs: number): string {
  return JSON.stringify({
    event: 'salesforce_operation',
    operation: OPERATIONS.includes(operation as (typeof OPERATIONS)[number]) ? operation : 'unknown',
    outcome,
    durationMs,
  });
}
