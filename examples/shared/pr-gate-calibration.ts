/**
 * Calibration log for the PR gate: records where a human agreed or overrode a
 * verdict, and reports the override rate per verdict.
 *
 * The log is append-only JSONL. Each line is one human decision on one receipt.
 * Nothing here calls a model. The point is to measure whether the gate's
 * verdicts match what people decide, before anything is allowed to block.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { PrGateReceipt, PrGateVerdict } from './pr-gate-schema.js';

export const OVERRIDE_SCHEMA = 's1sdk.pr-gate-override/v1';

export interface OverrideRecord {
  schema: typeof OVERRIDE_SCHEMA;
  recordedAt: string;
  head: string;
  title: string;
  /** Verdict the gate gave (or escalated) on the receipt. */
  gateVerdict: PrGateVerdict;
  /** Verdict a human reached. Equal to `gateVerdict` when they agree. */
  humanVerdict: PrGateVerdict;
  agreed: boolean;
  /** Confidence of the receipt the decision was made on. */
  confidence: number;
  reason?: string;
}

export function buildOverride(
  receipt: PrGateReceipt,
  humanVerdict: PrGateVerdict,
  options: { reason?: string; now?: Date } = {}
): OverrideRecord {
  const gateVerdict = receipt.decision.verdict;
  return {
    schema: OVERRIDE_SCHEMA,
    recordedAt: (options.now ?? new Date()).toISOString(),
    head: receipt.pr.head,
    title: receipt.pr.title,
    gateVerdict,
    humanVerdict,
    agreed: humanVerdict === gateVerdict,
    confidence: receipt.decision.confidence.overall,
    ...(options.reason ? { reason: options.reason } : {})
  };
}

export function appendOverride(path: string, record: OverrideRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export interface ReadResult {
  records: OverrideRecord[];
  /** Lines that were not valid override records. Reported, never silently dropped. */
  malformed: number;
}

export function readOverrides(path: string): ReadResult {
  if (!existsSync(path)) return { records: [], malformed: 0 };
  const records: OverrideRecord[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Partial<OverrideRecord>;
      if (parsed.schema === OVERRIDE_SCHEMA && parsed.gateVerdict && parsed.humanVerdict) {
        records.push(parsed as OverrideRecord);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

export interface VerdictStats {
  count: number;
  overridden: number;
  overrideRate: number | null;
}

export interface CalibrationReport {
  total: number;
  overridden: number;
  /** null when there are no records, so an empty log is not read as "0% overridden". */
  overrideRate: number | null;
  byVerdict: Record<PrGateVerdict, VerdictStats>;
  malformed: number;
}

const VERDICTS: PrGateVerdict[] = ['pass', 'review', 'escalate', 'hold'];

/** Report over the most recent `last` records (all when omitted). */
export function calibrationReport(
  read: ReadResult,
  options: { last?: number } = {}
): CalibrationReport {
  const records =
    options.last !== undefined && options.last > 0
      ? read.records.slice(-options.last)
      : read.records;

  const byVerdict = Object.fromEntries(
    VERDICTS.map((verdict) => [verdict, { count: 0, overridden: 0, overrideRate: null }])
  ) as Record<PrGateVerdict, VerdictStats>;

  let overridden = 0;
  for (const record of records) {
    const bucket = byVerdict[record.gateVerdict];
    if (!bucket) continue;
    bucket.count += 1;
    if (!record.agreed) {
      bucket.overridden += 1;
      overridden += 1;
    }
  }
  for (const verdict of VERDICTS) {
    const bucket = byVerdict[verdict];
    bucket.overrideRate = bucket.count === 0 ? null : bucket.overridden / bucket.count;
  }

  return {
    total: records.length,
    overridden,
    overrideRate: records.length === 0 ? null : overridden / records.length,
    byVerdict,
    malformed: read.malformed
  };
}

export function renderCalibrationReport(report: CalibrationReport): string {
  const pct = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
  const lines = [
    `decisions: ${report.total}  overridden: ${report.overridden}  override rate: ${pct(report.overrideRate)}`
  ];
  for (const verdict of VERDICTS) {
    const bucket = report.byVerdict[verdict];
    lines.push(
      `  ${verdict.padEnd(9)} count=${String(bucket.count).padStart(4)}  ` +
        `overridden=${String(bucket.overridden).padStart(4)}  rate=${pct(bucket.overrideRate)}`
    );
  }
  if (report.malformed > 0) lines.push(`malformed lines skipped: ${report.malformed}`);
  return lines.join('\n');
}
