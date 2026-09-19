// Test support: static scanner behind the "timer cannot reach the Domain"
// structural guarantee. It inspects SOURCE TEXT of Experience lifecycle
// files and reports any reference to a Domain-destructive capability, any
// import outside aul-world-app/src, and any wall-clock / AWR-TICK / expiry
// mechanism the brief forbids as an interaction clock.
//
// Comments are stripped first (they may legitimately explain what is
// forbidden); string literals are deliberately KEPT, so a forbidden
// identifier smuggled into a string (e.g. an event name) is still caught.

import path from "node:path";

export interface Violation {
  readonly kind: "FORBIDDEN_IDENTIFIER" | "FORBIDDEN_IMPORT" | "FORBIDDEN_CLOCK";
  readonly detail: string;
}

// Domain-destructive / Domain-mutating / identity / persistence capabilities.
const FORBIDDEN_IDENTIFIERS: readonly string[] = [
  "endSession",
  "requestSessionEnd",
  "clearCart",
  "addItem",
  "removeLine",
  "incrementLine",
  "decrementLine",
  "setLineModifiers",
  "setCustomerName",
  "setNotes",
  "submit",
  "retryUnknown",
  "beginCustomerSession",
  "hydrate\\w*",
  "requestAuthReset",
  "resolveOwnerUid",
  "signOut",
  "signInAnonymously",
  "purge\\w*",
  "removeSubmissionAttempt",
  "removeAuthoritativeResult",
  "clearTerminalAttempt",
  "INACTIVITY_TIMEOUT",
  "CUSTOMER_CANCELLED",
  "CUSTOMER_COMPLETED",
  "CUSTOMER_RETURNED_TO_IDLE",
  "stopInteraction",
  "neutralIdle",
];

// Wall clock, AWR TICK, and persistence-expiry mechanisms (brief section 4 / 17).
const FORBIDDEN_CLOCK_PATTERNS: ReadonlyArray<{ readonly label: string; readonly regex: RegExp }> = [
  { label: "Date.now", regex: /\bDate\s*\.\s*now\b/ },
  { label: "new Date", regex: /\bnew\s+Date\b/ },
  { label: "requestAnimationFrame", regex: /\brequestAnimationFrame\b/ },
  { label: "TICK", regex: /\bTICK\b/ },
  { label: "deltaMs", regex: /\bdeltaMs\b/ },
  { label: "persistence expiry (MaxAgeMs)", regex: /\b\w*MaxAgeMs\b/ },
  { label: "expiryOptions", regex: /\bexpiryOptions\b/ },
  { label: "writtenAt", regex: /\bwrittenAt\b/ },
  { label: "committedAt", regex: /\bcommittedAt\b/ },
];

// Removes // and /* */ comments while leaving string / template literals
// (and anything inside them, such as "http://x") untouched.
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out += source[i]! + source[i + 1]!;
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += source[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function importSpecifiers(strippedSource: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of strippedSource.matchAll(pattern)) {
      found.push(match[1]!);
    }
  }
  return found;
}

// Per-file relaxations. The Experience lifecycle files use NONE of these; the
// Composition root (which owns AWR's frame loop and the Domain boot) uses the
// narrow ones it needs, each named explicitly so nothing else is loosened.
export interface ScanOptions {
  // Forbidden identifiers this file is allowed to name (exact entries of FORBIDDEN_IDENTIFIERS).
  readonly allowIdentifiers?: readonly string[];
  // Clock-rule labels this file is allowed to use (labels of FORBIDDEN_CLOCK_PATTERNS).
  readonly allowClockLabels?: readonly string[];
  // Extra imports allowed beyond "relative and inside src": receives the absolute resolved path.
  readonly isImportAllowed?: (absoluteResolvedPath: string) => boolean;
}

// `srcRoot` is the absolute path of aul-world-app/src. By default only relative
// imports that resolve inside it are allowed: no bare packages, no node:
// built-ins, no path into kiosk/, aul-world-runtime/, or anywhere else.
export function scanSource(absoluteFilePath: string, source: string, srcRoot: string, options: ScanOptions = {}): Violation[] {
  const violations: Violation[] = [];
  const stripped = stripComments(source);

  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (options.allowIdentifiers?.includes(identifier)) continue;
    if (new RegExp(`\\b${identifier}\\b`).test(stripped)) {
      violations.push({ kind: "FORBIDDEN_IDENTIFIER", detail: identifier.replace("\\w*", "*") });
    }
  }

  for (const { label, regex } of FORBIDDEN_CLOCK_PATTERNS) {
    if (options.allowClockLabels?.includes(label)) continue;
    if (regex.test(stripped)) {
      violations.push({ kind: "FORBIDDEN_CLOCK", detail: label });
    }
  }

  const resolvedRoot = path.resolve(srcRoot) + path.sep;
  for (const specifier of importSpecifiers(stripped)) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const resolved = isRelative ? path.resolve(path.dirname(absoluteFilePath), specifier) : null;
    const insideSrc = resolved !== null && (resolved + path.sep).startsWith(resolvedRoot);
    const extraAllowed = resolved !== null && options.isImportAllowed?.(resolved) === true;
    if (!insideSrc && !extraAllowed) {
      violations.push({ kind: "FORBIDDEN_IMPORT", detail: specifier });
    }
  }

  return violations;
}
