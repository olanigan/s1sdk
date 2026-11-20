/**
 * Record human decisions on PR gate receipts and report how often the gate was
 * overridden. This is the calibration step: measure before the gate can block.
 *
 *   bun run examples/09-pr-gate-calibrate.ts record \
 *     --receipt pr-gate-receipt.json --human hold --reason "migration is fine" \
 *     --log pr-gate-overrides.jsonl
 *   bun run examples/09-pr-gate-calibrate.ts report --log pr-gate-overrides.jsonl --last 50
 *
 * `--human` equal to the gate's verdict is recorded as agreement.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { PrGateReceipt, PrGateVerdict } from './shared/pr-gate-schema.js';
import {
  buildOverride,
  appendOverride,
  calibrationReport,
  readOverrides,
  renderCalibrationReport
} from './shared/pr-gate-calibration.js';

const VERDICTS: readonly PrGateVerdict[] = ['pass', 'review', 'escalate', 'hold'];

function parseVerdict(value: string | undefined, flag: string): PrGateVerdict {
  if (!value || !VERDICTS.includes(value as PrGateVerdict)) {
    throw new Error(`${flag} must be one of ${VERDICTS.join('|')} (got "${value ?? ''}")`);
  }
  return value as PrGateVerdict;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'record') {
    const { values } = parseArgs({
      args: rest,
      options: {
        receipt: { type: 'string' },
        human: { type: 'string' },
        reason: { type: 'string' },
        log: { type: 'string', default: 'pr-gate-overrides.jsonl' }
      },
      allowPositionals: false
    });
    if (!values.receipt) throw new Error('record needs --receipt <file>');
    const receipt = JSON.parse(readFileSync(values.receipt, 'utf8')) as PrGateReceipt;
    const human = parseVerdict(values.human, '--human');
    const record = buildOverride(receipt, human, {
      ...(values.reason ? { reason: values.reason } : {})
    });
    appendOverride(values.log ?? 'pr-gate-overrides.jsonl', record);
    console.log(
      `${record.agreed ? 'agreed' : 'overrode'}: gate=${record.gateVerdict} human=${record.humanVerdict} -> ${values.log}`
    );
    return;
  }

  if (command === 'report') {
    const { values } = parseArgs({
      args: rest,
      options: {
        log: { type: 'string', default: 'pr-gate-overrides.jsonl' },
        last: { type: 'string' }
      },
      allowPositionals: false
    });
    const last = values.last === undefined ? undefined : Number(values.last);
    if (last !== undefined && (!Number.isInteger(last) || last <= 0)) {
      throw new Error(`--last must be a positive integer (got "${values.last}")`);
    }
    const report = calibrationReport(readOverrides(values.log ?? 'pr-gate-overrides.jsonl'), {
      ...(last !== undefined ? { last } : {})
    });
    console.log(renderCalibrationReport(report));
    return;
  }

  throw new Error('usage: 09-pr-gate-calibrate.ts <record|report> [options]');
}

try {
  main();
} catch (err) {
  console.error(`[pr-gate-calibrate] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
