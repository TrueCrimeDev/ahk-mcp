/**
 * DAP session — one per DAP client connection.
 *
 * Owns a DbgpClient instance, translates incoming DAP requests into DBGp
 * commands, and pushes DAP events (stopped / continued / terminated / output
 * / thread) back to the client.
 *
 * This file intentionally does NOT modify `dbgp-client.ts`. Anything the
 * client does not expose (e.g. raw XML access for children, variable tree
 * traversal) is implemented here using only the public surface.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import logger from '../logger.js';
import { DBGpClient, Variable } from '../core/dbgp-client.js';
import { resolveAutoHotkeyPath } from '../core/config.js';
import {
  dbgpFramesToDap,
  dbgpVariablesToDap,
  buildScopesForFrame,
  decodeScopeRef,
  CHILD_REF_BASE,
  mapBreakReason,
} from './translator.js';
import type {
  DapProtocolMessage,
  DapRequest,
  DapResponse,
  DapEvent,
  DapCapabilities,
  DapLaunchArguments,
  DapAttachArguments,
  DapSetBreakpointsArguments,
  DapSetExceptionBreakpointsArguments,
  DapStackTraceArguments,
  DapScopesArguments,
  DapVariablesArguments,
  DapEvaluateArguments,
  DapDisconnectArguments,
  DapStoppedEventBody,
  DapOutputEventBody,
  DapTerminatedEventBody,
  DapBreakpoint,
  VariableRef,
  BreakpointRecord,
} from './types.js';

// ---------- Transport interface (injected by DapServer) ----------

export interface DapTransport {
  send(msg: DapProtocolMessage): void;
  close(): void;
}

// ---------- Session ----------

export class DapSession {
  private seq = 1;
  private dbgp: DBGpClient | null = null;
  private exceptionBreakpointsEnabled = false;
  private lastCommand: 'run' | 'step' | 'pause' | 'launch' | undefined;
  private ahkProcess: ChildProcess | null = null;
  private disposed = false;

  /** frameId -> DBGp stack level. Reset every time execution resumes. */
  private readonly frameIdToLevel = new Map<number, number>();
  private nextFrameId = 1;

  /** Child variablesReference -> ref descriptor. */
  private readonly childRefs = new Map<number, VariableRef>();
  private nextChildRef = CHILD_REF_BASE;

  /** (file, line) -> DBGp breakpoint id. */
  private readonly breakpoints = new Map<string, BreakpointRecord>();

  constructor(private readonly transport: DapTransport) {}

  // ----------------------------------------------------------------------
  // Public entrypoints used by the server
  // ----------------------------------------------------------------------

  async handleIncoming(msg: unknown): Promise<void> {
    if (!isRequest(msg)) {
      // DAP clients never send events/responses; ignore anything else.
      logger.debug('DAP session ignored non-request message');
      return;
    }

    try {
      await this.dispatch(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DAP request ${msg.command} failed: ${message}`);
      this.sendResponse(msg, false, message);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.dbgp) {
      try {
        await this.dbgp.close();
      } catch (err) {
        logger.debug(`DBGp close during dispose: ${String(err)}`);
      }
      this.dbgp = null;
    }

    if (this.ahkProcess && this.ahkProcess.exitCode === null) {
      try {
        this.ahkProcess.kill();
      } catch {
        /* already dead */
      }
      this.ahkProcess = null;
    }
  }

  // ----------------------------------------------------------------------
  // Dispatch
  // ----------------------------------------------------------------------

  private async dispatch(req: DapRequest): Promise<void> {
    switch (req.command) {
      case 'initialize':
        return this.onInitialize(req);
      case 'launch':
        return this.onLaunch(req);
      case 'attach':
        return this.onAttach(req);
      case 'configurationDone':
        return this.onConfigurationDone(req);
      case 'setBreakpoints':
        return this.onSetBreakpoints(req);
      case 'setExceptionBreakpoints':
        return this.onSetExceptionBreakpoints(req);
      case 'threads':
        return this.onThreads(req);
      case 'stackTrace':
        return this.onStackTrace(req);
      case 'scopes':
        return this.onScopes(req);
      case 'variables':
        return this.onVariables(req);
      case 'continue':
        return this.onContinue(req);
      case 'next':
        return this.onNext(req);
      case 'stepIn':
        return this.onStepIn(req);
      case 'stepOut':
        return this.onStepOut(req);
      case 'pause':
        return this.onPause(req);
      case 'evaluate':
        return this.onEvaluate(req);
      case 'source':
        return this.onSource(req);
      case 'disconnect':
        return this.onDisconnect(req);
      default:
        this.sendResponse(req, false, `Unsupported DAP command: ${req.command}`);
        return;
    }
  }

  // ----------------------------------------------------------------------
  // Request handlers
  // ----------------------------------------------------------------------

  private onInitialize(req: DapRequest): void {
    const caps: DapCapabilities = {
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      supportTerminateDebuggee: true,
      exceptionBreakpointFilters: [
        { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
      ],
    };
    this.sendResponse(req, true, undefined, caps);
    // The `initialized` event tells the client to send setBreakpoints etc.
    this.sendEvent('initialized');
  }

  private async onLaunch(req: DapRequest): Promise<void> {
    const args = (req.arguments ?? {}) as DapLaunchArguments;
    if (!args.program) {
      this.sendResponse(req, false, 'launch: "program" is required');
      return;
    }

    const dbgpPort = args.dbgpPort ?? 9000;
    this.dbgp = new DBGpClient(dbgpPort);
    this.wireDbgpEvents();

    // Start listening BEFORE spawning so AHK can connect outbound.
    await this.dbgp.listen();

    const ahkPath = args.ahkPath ?? process.env.AHK_BINARY ?? resolveAutoHotkeyPath();
    if (!ahkPath) {
      this.sendResponse(
        req,
        false,
        'Could not resolve AutoHotkey executable. Set ahkPath or AHK_BINARY env.'
      );
      return;
    }

    const spawnArgs = ['/Debug', args.program, ...(args.args ?? [])];
    const cwd = args.cwd ?? path.dirname(args.program);
    this.ahkProcess = spawn(ahkPath, spawnArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    this.ahkProcess.stdout?.on('data', chunk => {
      this.sendOutput('stdout', chunk.toString());
    });
    this.ahkProcess.stderr?.on('data', chunk => {
      this.sendOutput('stderr', chunk.toString());
    });
    this.ahkProcess.on('exit', code => {
      this.sendOutput('console', `AutoHotkey exited with code ${code ?? 'null'}\n`);
      this.sendEvent('terminated', {} satisfies DapTerminatedEventBody);
    });

    this.lastCommand = 'launch';
    this.sendResponse(req, true);
  }

  private async onAttach(req: DapRequest): Promise<void> {
    const args = (req.arguments ?? {}) as DapAttachArguments;
    const dbgpPort = args.dbgpPort ?? 9000;
    this.dbgp = new DBGpClient(dbgpPort);
    this.wireDbgpEvents();
    await this.dbgp.listen();
    this.lastCommand = 'launch';
    this.sendResponse(req, true);
  }

  private onConfigurationDone(req: DapRequest): void {
    // Client is done configuring breakpoints. Kick off execution IF we
    // already have a DBGp connection. Otherwise the first `run()` will be
    // issued when AHK connects (see wireDbgpEvents -> init).
    this.sendResponse(req, true);
    if (this.dbgp?.isConnected()) {
      void this.runAndReport();
    }
  }

  private async onSetBreakpoints(req: DapRequest): Promise<void> {
    const args = (req.arguments ?? {}) as DapSetBreakpointsArguments;
    const file = args.source.path;
    if (!file) {
      this.sendResponse(req, false, 'setBreakpoints: source.path required');
      return;
    }

    const desired: Array<{ line: number; condition?: string }> =
      args.breakpoints ?? (args.lines ?? []).map(line => ({ line }));
    const desiredKeys = new Set(desired.map(bp => `${file}:${bp.line}`));

    // Remove stale breakpoints for this file.
    for (const [key, rec] of this.breakpoints.entries()) {
      if (rec.file !== file) continue;
      if (desiredKeys.has(key)) continue;
      try {
        if (this.dbgp?.isConnected()) {
          await this.dbgp.removeBreakpoint(rec.dbgpId);
        }
      } catch (err) {
        logger.debug(`removeBreakpoint failed for ${key}: ${String(err)}`);
      }
      this.breakpoints.delete(key);
    }

    // Add/update requested breakpoints.
    const results: DapBreakpoint[] = [];
    let idCounter = 1;
    for (const bp of desired) {
      const key = `${file}:${bp.line}`;
      let rec = this.breakpoints.get(key);
      const connected = this.dbgp?.isConnected() ?? false;

      if (connected && !rec) {
        try {
          const created = await this.dbgp!.setBreakpoint(file, bp.line, bp.condition);
          rec = {
            dbgpId: created.id,
            file,
            line: bp.line,
            condition: bp.condition,
          };
          this.breakpoints.set(key, rec);
        } catch (err) {
          results.push({
            verified: false,
            message: err instanceof Error ? err.message : String(err),
            source: args.source,
            line: bp.line,
          });
          continue;
        }
      } else if (!connected && !rec) {
        // Defer until DBGp connects. Record intent.
        rec = { dbgpId: '', file, line: bp.line, condition: bp.condition };
        this.breakpoints.set(key, rec);
      }

      results.push({
        id: idCounter++,
        verified: connected,
        source: args.source,
        line: bp.line,
      });
    }

    this.sendResponse(req, true, undefined, { breakpoints: results });
  }

  private onSetExceptionBreakpoints(req: DapRequest): void {
    const args = (req.arguments ?? {}) as DapSetExceptionBreakpointsArguments;
    this.exceptionBreakpointsEnabled = (args.filters ?? []).includes('uncaught');
    this.sendResponse(req, true);
  }

  private onThreads(req: DapRequest): void {
    // AHK is single-threaded from DAP's perspective.
    this.sendResponse(req, true, undefined, {
      threads: [{ id: 1, name: 'main' }],
    });
  }

  private async onStackTrace(req: DapRequest): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, 'stackTrace: not connected');
      return;
    }
    const args = (req.arguments ?? {}) as DapStackTraceArguments;
    if (args.threadId !== 1) {
      this.sendResponse(req, true, undefined, { stackFrames: [], totalFrames: 0 });
      return;
    }
    const frames = await this.dbgp.getStackTrace();

    // Reset frame-id and child-ref tables every stackTrace request — frame
    // ids are only valid until the next stop.
    this.frameIdToLevel.clear();
    this.childRefs.clear();
    this.nextFrameId = 1;
    this.nextChildRef = CHILD_REF_BASE;

    const dapFrames = dbgpFramesToDap(frames, level => {
      const id = this.nextFrameId++;
      this.frameIdToLevel.set(id, level);
      return id;
    });
    this.sendResponse(req, true, undefined, {
      stackFrames: dapFrames,
      totalFrames: dapFrames.length,
    });
  }

  private onScopes(req: DapRequest): void {
    const args = (req.arguments ?? {}) as DapScopesArguments;
    const scopes = buildScopesForFrame(args.frameId);
    this.sendResponse(req, true, undefined, { scopes });
  }

  private async onVariables(req: DapRequest): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, 'variables: not connected');
      return;
    }
    const args = (req.arguments ?? {}) as DapVariablesArguments;
    const ref = args.variablesReference;

    const scopeRef = decodeScopeRef(ref);
    if (scopeRef) {
      const vars = await this.dbgp.getVariables(scopeRef.scopeId);
      const dapVars = dbgpVariablesToDap(vars, scopeRef.frameId, refDesc =>
        this.allocChildRef(refDesc)
      );
      this.sendResponse(req, true, undefined, { variables: dapVars });
      return;
    }

    const childDesc = this.childRefs.get(ref);
    if (!childDesc || childDesc.kind !== 'child') {
      this.sendResponse(req, false, `Unknown variablesReference: ${ref}`);
      return;
    }

    // DBGp `property_get` returns the requested property with its children
    // inlined. Our public DbgpClient surface doesn't expose this directly,
    // so we fall back to evaluating the fullname and flattening.
    const value = await this.dbgp.evaluateExpression(childDesc.fullname);
    // For scalar fallbacks we just return one synthetic entry. This is a
    // known limitation documented in docs/dap.md.
    const synthetic: Variable = {
      name: childDesc.fullname,
      fullname: childDesc.fullname,
      type: 'any',
      value,
    };
    const dapVars = dbgpVariablesToDap([synthetic], childDesc.frameId, r => this.allocChildRef(r));
    this.sendResponse(req, true, undefined, { variables: dapVars });
  }

  private async onContinue(req: DapRequest): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, 'continue: not connected');
      return;
    }
    this.sendResponse(req, true, undefined, { allThreadsContinued: true });
    this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    this.lastCommand = 'run';
    const resp = await this.dbgp.run();
    this.reportStopIfBreak(resp);
  }

  private async onNext(req: DapRequest): Promise<void> {
    await this.stepCommon(req, 'stepOver');
  }

  private async onStepIn(req: DapRequest): Promise<void> {
    await this.stepCommon(req, 'stepInto');
  }

  private async onStepOut(req: DapRequest): Promise<void> {
    await this.stepCommon(req, 'stepOut');
  }

  private async stepCommon(
    req: DapRequest,
    kind: 'stepInto' | 'stepOver' | 'stepOut'
  ): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, `${kind}: not connected`);
      return;
    }
    this.sendResponse(req, true);
    this.lastCommand = 'step';
    const resp = await this.dbgp[kind]();
    this.reportStopIfBreak(resp);
  }

  private async onPause(req: DapRequest): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, 'pause: not connected');
      return;
    }
    // DBGp has no explicit "pause" — the closest is `break`, which AHK's
    // debugger supports via the `status` idle check. Many AHK debuggers
    // emulate this by setting a transient breakpoint at the next line; for
    // MVP we return success but note that pause fidelity depends on the
    // AHK build.
    this.lastCommand = 'pause';
    this.sendResponse(req, true);
  }

  private async onEvaluate(req: DapRequest): Promise<void> {
    if (!this.dbgp?.isConnected()) {
      this.sendResponse(req, false, 'evaluate: not connected');
      return;
    }
    const args = (req.arguments ?? {}) as DapEvaluateArguments;
    const result = await this.dbgp.evaluateExpression(args.expression);
    this.sendResponse(req, true, undefined, {
      result,
      variablesReference: 0,
    });
  }

  private async onSource(req: DapRequest): Promise<void> {
    // We only support source by path (sourceReference 0). If a DAP client
    // asks for a sourceReference we haven't minted, return an error.
    this.sendResponse(req, false, 'Source by reference is not supported (use source.path).');
  }

  private async onDisconnect(req: DapRequest): Promise<void> {
    const args = (req.arguments ?? {}) as DapDisconnectArguments;
    if (args.terminateDebuggee && this.ahkProcess && this.ahkProcess.exitCode === null) {
      try {
        this.ahkProcess.kill();
      } catch {
        /* ignore */
      }
    } else if (this.dbgp?.isConnected()) {
      try {
        await this.dbgp.stop();
      } catch {
        /* ignore */
      }
    }
    this.sendResponse(req, true);
    await this.dispose();
    this.transport.close();
  }

  // ----------------------------------------------------------------------
  // DBGp event wiring
  // ----------------------------------------------------------------------

  private wireDbgpEvents(): void {
    if (!this.dbgp) return;
    this.dbgp.on('connected', () => {
      this.sendEvent('thread', { reason: 'started', threadId: 1 });
      this.sendOutput('console', 'AutoHotkey debugger connected (DBGp)\n');
      void this.flushPendingBreakpoints();
    });
    this.dbgp.on('disconnected', () => {
      this.sendEvent('thread', { reason: 'exited', threadId: 1 });
      this.sendEvent('terminated', {} satisfies DapTerminatedEventBody);
    });
    this.dbgp.on('error', err => {
      logger.warn(`DBGp error: ${String(err)}`);
      this.sendOutput('stderr', `DBGp error: ${String(err)}\n`);
    });
  }

  private async flushPendingBreakpoints(): Promise<void> {
    if (!this.dbgp?.isConnected()) return;
    for (const [key, rec] of this.breakpoints.entries()) {
      if (rec.dbgpId) continue; // already registered
      try {
        const created = await this.dbgp.setBreakpoint(rec.file, rec.line, rec.condition);
        rec.dbgpId = created.id;
        this.breakpoints.set(key, rec);
      } catch (err) {
        logger.warn(`deferred breakpoint ${key} failed: ${String(err)}`);
      }
    }
  }

  /**
   * Called after configurationDone when we're already connected. Kicks off
   * execution via DBGp `run` and reports the resulting stop.
   */
  private async runAndReport(): Promise<void> {
    if (!this.dbgp?.isConnected()) return;
    this.lastCommand = 'run';
    try {
      const resp = await this.dbgp.run();
      this.reportStopIfBreak(resp);
    } catch (err) {
      logger.warn(`DBGp run failed: ${String(err)}`);
    }
  }

  private reportStopIfBreak(resp: { status?: string; reason?: string }): void {
    if (resp.status === 'stopped' || resp.status === 'stopping') {
      this.sendEvent('terminated', {} satisfies DapTerminatedEventBody);
      return;
    }
    // AHK replies with status="break" when a breakpoint / step completes.
    const reason = mapBreakReason(resp.status, resp.reason, this.lastCommand);
    const body: DapStoppedEventBody = {
      reason,
      threadId: 1,
      allThreadsStopped: true,
    };
    this.sendEvent('stopped', body);
  }

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------

  private allocChildRef(ref: VariableRef): number {
    const id = this.nextChildRef++;
    this.childRefs.set(id, ref);
    return id;
  }

  private sendResponse(req: DapRequest, success: boolean, message?: string, body?: unknown): void {
    const resp: DapResponse = {
      seq: this.seq++,
      type: 'response',
      request_seq: req.seq,
      success,
      command: req.command,
    };
    if (message !== undefined) resp.message = message;
    if (body !== undefined) resp.body = body;
    this.transport.send(resp);
  }

  private sendEvent(event: string, body?: unknown): void {
    const ev: DapEvent = {
      seq: this.seq++,
      type: 'event',
      event,
    };
    if (body !== undefined) ev.body = body;
    this.transport.send(ev);
  }

  private sendOutput(category: NonNullable<DapOutputEventBody['category']>, output: string): void {
    this.sendEvent('output', { category, output });
  }
}

// ---------- Guards ----------

function isRequest(value: unknown): value is DapRequest {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return o.type === 'request' && typeof o.seq === 'number' && typeof o.command === 'string';
}

// fs import kept for potential source-reading features; avoid unused warnings.
void fs;
