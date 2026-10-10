/**
 * Bounded cause transport shared by reports and the replacement worker.
 * This module has no Pi runtime imports. External boundaries validate cause
 * data before restoreCause; internal callers pass classified/native errors.
 */
import { errnoCode, errorMessage, HashlineError } from "../core/errors.ts";
import {
  MAX_CAUSE_BYTES,
  MAX_CAUSE_DEPTH,
  MAX_CAUSE_NODES,
  MAX_ERROR_TEXT_BYTES,
} from "./budgets.ts";
import { DiagnosticBuffer } from "./diagnostic-buffer.ts";
import type { Cause } from "./report-schema.ts";

class RestoredCause extends Error {
  readonly data: Cause;
  constructor(data: Cause) {
    super(data.message);
    this.data = data;
  }
}

/** Preserve validated cause data across a worker boundary without flattening it into prose. */
export function restoreCause(data: Cause | undefined): Error | undefined {
  return data === undefined ? undefined : new RestoredCause(data);
}

/** One free-text value within its budget, keeping the opening and the final cause. */
export function boundedText(text: string): string {
  const buffer = new DiagnosticBuffer(MAX_ERROR_TEXT_BYTES);
  buffer.append(text);
  return buffer.toString();
}

/** Bound the complete graph; `omitted` counts unexpanded references rather than unseen descendants. */
export function causeOf(error: unknown): Cause | undefined {
  const seen = new Set<unknown>();
  const omissionReserveBytes = 64;
  let remainingBytes = MAX_CAUSE_BYTES - omissionReserveBytes;
  let visited = 0;
  let omitted = 0;
  const visit = (value: unknown, depth: number): Cause | undefined => {
    if (value === undefined) return undefined;
    if (depth > MAX_CAUSE_DEPTH || visited >= MAX_CAUSE_NODES) {
      omitted++;
      return undefined;
    }
    visited++;
    if (seen.has(value)) {
      omitted++;
      return undefined;
    }
    seen.add(value);
    const serialized = value instanceof RestoredCause ? value.data : undefined;
    const errno = serialized?.code ?? errnoCode(value);
    const ownMessage = serialized?.message ?? errorMessage(value);
    const node: Cause = {
      ...(serialized?.error
        ? { error: serialized.error }
        : value instanceof HashlineError
          ? { error: value.errorCode }
          : {}),
      ...(errno === undefined ? {} : { code: errno }),
      message: boundedText(ownMessage),
      ...(serialized?.omitted ? { omitted: serialized.omitted } : {}),
    };
    const chargeBytes = () => {
      const own = JSON.stringify(node, null, 2);
      // Charge nesting indentation and child containers before descending.
      return Buffer.byteLength(own) + own.split("\n").length * (depth * 4 + 4) + 32;
    };
    let nodeBytes = chargeBytes();
    let messageBudgetBytes = MAX_ERROR_TEXT_BYTES;
    // JSON escaping can exceed the raw text limit; retain the root's opening and final cause.
    while (depth === 1 && nodeBytes > remainingBytes && messageBudgetBytes > 1) {
      messageBudgetBytes = Math.floor(messageBudgetBytes / 2);
      const buffer = new DiagnosticBuffer(messageBudgetBytes);
      buffer.append(ownMessage);
      node.message = buffer.toString();
      nodeBytes = chargeBytes();
    }
    if (nodeBytes > remainingBytes) {
      omitted++;
      return undefined;
    }
    remainingBytes -= nodeBytes;
    if (value instanceof Error) {
      const child = visit(serialized ? restoreCause(serialized.cause) : value.cause, depth + 1);
      if (child) node.cause = child;
    }
    const branches =
      serialized?.errors?.map(restoreCause) ??
      (value instanceof AggregateError ? value.errors : undefined);
    if (branches) {
      const children: Cause[] = [];
      for (let index = 0; index < branches.length; index++) {
        if (visited >= MAX_CAUSE_NODES || remainingBytes <= omissionReserveBytes) {
          omitted += branches.length - index;
          break;
        }
        const child = visit(branches[index], depth + 1);
        if (child) children.push(child);
      }
      if (children.length) node.errors = children;
    }
    return node;
  };
  const root = visit(error, 1);
  if (root && omitted) root.omitted = (root.omitted ?? 0) + omitted;
  return root;
}

/** Reject oversized cause data before TypeBox's recursive traversal of an external JSON value. */
export function boundedCauseData(value: unknown): boolean {
  if (value === undefined) return true;
  const pending = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending[pending.length - 1];
    pending.length--;
    if (++nodes > MAX_CAUSE_NODES || current.depth > MAX_CAUSE_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null || Array.isArray(current.value))
      return false;
    const child: unknown = Reflect.get(current.value, "cause");
    if (child !== undefined) pending.push({ value: child, depth: current.depth + 1 });
    const children: unknown = Reflect.get(current.value, "errors");
    if (children !== undefined) {
      if (!Array.isArray(children) || nodes + pending.length + children.length > MAX_CAUSE_NODES)
        return false;
      for (const value of children) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(value, null, 2)) <= MAX_CAUSE_BYTES;
}
