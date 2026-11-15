/**
 * PR gate state reducer.
 *
 * A System-1 model classifies the state you hand it, so the gate's accuracy is
 * bounded by this reducer, not by the model. This module turns a unified diff
 * plus PR metadata into a compact, bounded payload: paths, hunk statistics,
 * test presence, lockfile churn, protected-path hits and *rules-only* secret
 * evidence. Raw diff lines never leave this module.
 */

export interface PrMetadata {
  readonly title: string;
  readonly body?: string;
  readonly author?: string;
  readonly labels: readonly string[];
  readonly base: string;
  readonly head: string;
}

export type PrFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface PrFileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: PrFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface SecretHit {
  readonly file: string;
  readonly rule: string;
  /** 1-based line number in the new file. */
  readonly line: number;
}

export interface PrSignals {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly testFiles: readonly string[];
  readonly lockfiles: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly migrations: readonly string[];
  readonly secretHits: readonly SecretHit[];
  readonly dependencyAdditions: readonly string[];
  readonly binaryFiles: readonly string[];
}

export interface PrState {
  readonly meta: PrMetadata;
  readonly files: readonly PrFileChange[];
  readonly commits: readonly string[];
  readonly signals: PrSignals;
  /** True when the per-file list was capped before being sent to the model. */
  readonly filesTruncated: boolean;
}

/** Max files included in the model payload; totals still count everything. */
export const MAX_MODEL_FILES = 60;

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|tests?|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_.*\.py$/i,
  /_test\.(go|py|rs)$/i,
  /Test\.(java|kt|cs)$/
];

const LOCKFILE_PATTERNS: readonly RegExp[] = [
  /^bun\.lockb?$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^Cargo\.lock$/,
  /^poetry\.lock$/,
  /^go\.sum$/,
  /^composer\.lock$/
];

const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /^(Dockerfile|docker-compose\.ya?ml)$/i,
  /^(infra|deploy|k8s|helm|terraform)\//i,
  /^wrangler\.[^/]+\.(jsonc?|toml)$/i,
  /^\.env(\.|$)/,
  /^(src\/providers|src\/http\.ts)/,
  /^(package\.json|tsconfig\.json)$/
];

const MIGRATION_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)migrations?\//i,
  /(^|\/)db\/migrate\//i
];

/**
 * Ordered secret rules. Matches are reported by rule id and location only; the
 * matched text is intentionally never stored so receipts cannot leak a secret
 * into a CI log.
 */
const SECRET_RULES: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    id: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*(?:['"][^'"\s]{12,}['"]|[A-Za-z0-9_\-]{16,})/i
  }
];

const DEPENDENCY_LINE = /^\s*"(@?[^"]+)"\s*:\s*"[~^]?\d/;

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

export function isTestPath(path: string): boolean {
  return matchesAny(path, TEST_PATH_PATTERNS);
}

export function isLockfile(path: string): boolean {
  return matchesAny(path, LOCKFILE_PATTERNS);
}

export function isProtectedPath(path: string): boolean {
  return matchesAny(path, PROTECTED_PATH_PATTERNS);
}

export function isMigrationPath(path: string): boolean {
  return matchesAny(path, MIGRATION_PATH_PATTERNS);
}

interface MutableFile {
  path: string;
  oldPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  addedLines: string[];
}

function stripDiffPrefix(raw: string): string {
  return raw.replace(/^[ab]\//, '');
}

/**
 * Parses a unified diff into per-file change records and scans added lines for
 * secret rules. The parser is deliberately tolerant: unknown lines are ignored,
 * binary files are recorded, and malformed hunks do not abort the gate.
 */
export function parseUnifiedDiff(diffText: string): MutableFile[] {
  const files: MutableFile[] = [];
  let current: MutableFile | undefined;
  let newLine = 0;

  const flush = (): void => {
    if (current && (current.path || current.oldPath)) {
      if (!current.path) current.path = current.oldPath ?? '(unknown)';
      files.push(current);
    }
    current = undefined;
  };

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = {
        path: match ? match[2]! : '(unknown)',
        oldPath: match ? match[1]! : undefined,
        status: 'modified',
        additions: 0,
        deletions: 0,
        addedLines: []
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current.status = current.status === 'added' ? 'added' : current.status;
      continue;
    }
    if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.oldPath = stripDiffPrefix(value);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.path = stripDiffPrefix(value);
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)(?:,\d+)?/.exec(line);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1;
      current.addedLines.push(line.slice(1));
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      newLine += 1;
    }
  }

  flush();
  return files;
}

function scanSecrets(file: MutableFile): SecretHit[] {
  const hits: SecretHit[] = [];
  let lineNo = 0;
  for (const added of file.addedLines) {
    lineNo += 1;
    for (const rule of SECRET_RULES) {
      if (rule.re.test(added)) {
        hits.push({ file: file.path, rule: rule.id, line: lineNo });
      }
    }
  }
  return hits;
}

function collectDependencies(file: MutableFile): string[] {
  if (!/(^|\/)package\.json$/.test(file.path)) return [];
  const names = new Set<string>();
  for (const added of file.addedLines) {
    const match = DEPENDENCY_LINE.exec(added);
    if (match && match[1]) names.add(match[1]);
  }
  return [...names];
}

export interface ReduceOptions {
  readonly commits?: readonly string[];
  readonly binaryFiles?: readonly string[];
}

/**
 * Reduces a unified diff and PR metadata into the bounded state used by both
 * the model call and the deterministic policy pre-filter.
 */
export function reducePrState(
  diffText: string,
  meta: PrMetadata,
  options: ReduceOptions = {}
): PrState {
  const parsed = parseUnifiedDiff(diffText);

  const files: PrFileChange[] = [];
  const testFiles: string[] = [];
  const lockfiles: string[] = [];
  const protectedPaths: string[] = [];
  const migrations: string[] = [];
  const secretHits: SecretHit[] = [];
  const dependencyAdditions: string[] = [];

  let additions = 0;
  let deletions = 0;

  for (const file of parsed) {
    const change: PrFileChange = {
      path: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions
    };
    files.push(change);
    additions += file.additions;
    deletions += file.deletions;

    if (isTestPath(file.path)) testFiles.push(file.path);
    if (isLockfile(file.path)) lockfiles.push(file.path);
    if (isProtectedPath(file.path)) protectedPaths.push(file.path);
    if (isMigrationPath(file.path)) migrations.push(file.path);
    secretHits.push(...scanSecrets(file));
    dependencyAdditions.push(...collectDependencies(file));
  }

  const sortUnique = (values: string[]): string[] => [...new Set(values)].sort();

  return {
    meta,
    files,
    commits: options.commits ?? [],
    filesTruncated: files.length > MAX_MODEL_FILES,
    signals: {
      filesChanged: files.length,
      additions,
      deletions,
      testFiles: sortUnique(testFiles),
      lockfiles: sortUnique(lockfiles),
      protectedPaths: sortUnique(protectedPaths),
      migrations: sortUnique(migrations),
      secretHits,
      dependencyAdditions: sortUnique(dependencyAdditions),
      binaryFiles: sortUnique([...(options.binaryFiles ?? [])])
    }
  };
}

/** Compact, bounded payload sent to the model. Never contains diff bodies. */
export function toModelState(state: PrState): Record<string, unknown> {
  const { meta, signals, files } = state;
  return {
    title: meta.title,
    body: meta.body ?? '',
    author: meta.author ?? '',
    labels: meta.labels,
    base: meta.base,
    head: meta.head,
    commits: state.commits.slice(0, 20),
    diff: {
      filesChanged: signals.filesChanged,
      additions: signals.additions,
      deletions: signals.deletions,
      files: files.slice(0, MAX_MODEL_FILES).map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions
      })),
      filesTruncated: state.filesTruncated
    },
    signals: {
      testFiles: signals.testFiles.slice(0, 20),
      lockfiles: signals.lockfiles,
      protectedPaths: signals.protectedPaths.slice(0, 20),
      migrations: signals.migrations.slice(0, 20),
      secretRuleHits: signals.secretHits.map((hit) => ({ file: hit.file, rule: hit.rule })),
      dependencyAdditions: signals.dependencyAdditions.slice(0, 20),
      binaryFiles: signals.binaryFiles.slice(0, 20)
    }
  };
}

export type PolicyId = 'secrets' | 'migration_review' | 'protected_infra';

export interface PolicySignal {
  readonly id: PolicyId;
  readonly title: string;
  /** Deterministic pre-filter result. The model only adds nuance, never authority. */
  readonly deterministic: boolean;
  readonly evidence: readonly string[];
  readonly instructions: string;
}

/**
 * Feature 6: deterministic pre-filter before any model question is asked.
 * A path/regex hit is enough to surface the policy; the model's `noul` answer is
 * combined with that evidence during interpretation, never used alone.
 */
export function prefilterPolicies(state: PrState): PolicySignal[] {
  const { signals } = state;
  return [
    {
      id: 'secrets',
      title: 'Possible secret material in the diff',
      deterministic: signals.secretHits.length > 0,
      evidence: signals.secretHits.map((hit) => `${hit.file}:${hit.line} (${hit.rule})`),
      instructions:
        'Determine whether the added lines introduce credentials, API keys, private keys, or other secret material that must not be committed'
    },
    {
      id: 'migration_review',
      title: 'Database migration touched',
      deterministic: signals.migrations.length > 0,
      evidence: signals.migrations,
      instructions:
        'Determine whether this change requires a database migration review, backfill plan, or rollback strategy'
    },
    {
      id: 'protected_infra',
      title: 'Protected or release-critical path touched',
      deterministic: signals.protectedPaths.length > 0,
      evidence: signals.protectedPaths,
      instructions:
        'Determine whether this change alters protected infrastructure, CI, provider transports, or packaging in a way that needs a maintainer review'
    }
  ];
}
