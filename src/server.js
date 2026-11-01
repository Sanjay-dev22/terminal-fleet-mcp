#!/usr/bin/env node
/**
 * Terminal-fleet control MCP server.
 *
 * Drives genuinely visible, classic Windows console windows -- spawned with
 * Start-Process (real windows the user can watch), keystrokes injected directly
 * into each target console's own input buffer via WriteConsoleInput (by pid, not
 * by window focus), screen content read back via the Win32 Console API
 * (AttachConsole + CONOUT$ + ReadConsoleOutputCharacter/Attribute) -- not
 * screenshots or a guess, the actual character buffer, same as the human's own eyes.
 *
 * Deliberately not using SendKeys/SetForegroundWindow for input: that approach
 * injects into the shared, system-wide input queue, routed by whatever window
 * currently has OS focus -- which races with anything else the user is doing on
 * screen. WriteConsoleInput writes into a specific console's own buffer by pid,
 * immune to focus entirely, which matters a lot for the actual use case below.
 *
 * Built for fleet orchestration: one controlling agent session spawning and
 * driving several other terminal/Claude Code sessions as workers, each tracked
 * by pid or an assigned label, with enough reliability/control primitives (real
 * key combos, real Ctrl+C/Ctrl+Break signals, focus-independent delivery,
 * wait-for-output) to actually run a multi-session workflow instead of just a
 * single supervised demo.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SEND_KEYS_SCRIPT = path.join(__dirname, 'send-keys.ps1');
const READ_CONSOLE_SCRIPT = path.join(__dirname, 'read-console.ps1');
const SCREENSHOT_SCRIPT = path.join(__dirname, 'screenshot.ps1');

function runPwsh(args, timeout = 20000) {
  return execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', ...args], {
    encoding: 'utf8',
    timeout
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Terminal registry -----------------------------------------------------
// Tracks every terminal spawned by this server instance so term_list can
// report them and other tools can resolve a friendly label back to a pid.
// Lives only in this process's memory -- gone on restart, same as the OS
// processes it describes would be orphaned anyway.
const terminals = new Map(); // pid (string) -> { label, shell, command, cwd, spawnedAt }

function resolvePid(idOrLabel) {
  for (const [pid, info] of terminals) {
    if (info.label && info.label === idOrLabel) return pid;
  }
  return String(idOrLabel);
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// --- Key combo parsing -------------------------------------------------
// Translates a human-readable token like "CTRL+SHIFT+P" or "ENTER" into an
// action descriptor send-keys.ps1 turns directly into a Win32 KEY_EVENT_RECORD
// (virtual-key code + control-key-state flags), or into a real console control
// signal for Ctrl+C/Ctrl+Break. This is what gives term_send the same reach as
// a real keyboard -- any named key combined with any combo of CTRL/ALT/SHIFT --
// instead of a fixed enum of a handful of arrow/tab keys.
const VK = {
  ENTER: 13, RETURN: 13, ESC: 27, ESCAPE: 27, TAB: 9, SPACE: 32,
  BACKSPACE: 8, BS: 8, DELETE: 46, DEL: 46, INSERT: 45, INS: 45,
  UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
  HOME: 36, END: 35, PGUP: 33, PAGEUP: 33, PGDN: 34, PAGEDOWN: 34,
  BREAK: 3 // VK_CANCEL -- the conventional Ctrl+Break virtual key
};
for (let i = 1; i <= 12; i++) VK[`F${i}`] = 111 + i;

// Keys that produce a conventional character even though they're "named" --
// apps that read raw characters rather than inspecting the virtual-key code
// (e.g. a simple readline loop checking for '\r') still see the right thing.
const CHAR_FOR = { ENTER: '\r', RETURN: '\r', TAB: '\t', SPACE: ' ', BACKSPACE: '\b', BS: '\b', ESC: '\x1b', ESCAPE: '\x1b' };

function keyAction(vk, char, ctrl, alt, shift) {
  return { type: 'key', vk, char, ctrl, alt, shift };
}

function parseKeyToken(token) {
  const parts = token.split('+').map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Empty key token: "${token}"`);

  let ctrl = false, alt = false, shift = false, keyPart = null;
  for (const part of parts) {
    if (part === 'CTRL' || part === 'CONTROL') ctrl = true;
    else if (part === 'ALT') alt = true;
    else if (part === 'SHIFT') shift = true;
    else if (keyPart !== null) throw new Error(`Key token "${token}" has more than one actual key`);
    else keyPart = part;
  }
  if (keyPart === null) throw new Error(`Key token "${token}" has only modifiers, no actual key`);

  if (VK[keyPart] !== undefined) {
    const vk = VK[keyPart];
    const baseChar = CHAR_FOR[keyPart] ?? null;
    return keyAction(vk, alt ? null : baseChar, ctrl, alt, shift);
  }
  if (/^[A-Z]$/.test(keyPart)) {
    const vk = keyPart.charCodeAt(0); // VK_A..VK_Z == 'A'..'Z' ASCII codes, no layout lookup needed
    let char = null;
    if (!alt) char = ctrl ? String.fromCharCode(keyPart.charCodeAt(0) - 64) : (shift ? keyPart : keyPart.toLowerCase());
    return keyAction(vk, char, ctrl, alt, shift);
  }
  if (/^[0-9]$/.test(keyPart)) {
    const vk = keyPart.charCodeAt(0); // VK_0..VK_9 == '0'..'9' ASCII codes
    const char = (!alt && !ctrl) ? keyPart : null;
    return keyAction(vk, char, ctrl, alt, shift);
  }
  throw new Error(
    `Unknown key "${keyPart}" in token "${token}". Use a named key (ENTER, ESC, TAB, UP/DOWN/LEFT/RIGHT, ` +
    `HOME, END, PGUP, PGDN, DELETE, BACKSPACE, INSERT, BREAK, F1-F12) or a single letter/digit, optionally ` +
    `combined with CTRL/ALT/SHIFT via "+", e.g. "CTRL+C", "ALT+F4", "CTRL+SHIFT+P".`
  );
}

// Plain typed text becomes a sequence of character-only actions (no vk, no
// modifiers) -- injected the same way as named keys, just without a virtual-key
// code, exactly like how Unicode/IME text input lands in a console.
function textToActions(text) {
  return Array.from(text).map((ch) => keyAction(0, ch, false, false, false));
}

async function doRead(pid, { withColor = false, extraScrollback = 0 } = {}) {
  const args = [READ_CONSOLE_SCRIPT, '-ProcessId', String(pid)];
  if (withColor) args.push('-WithColor');
  if (extraScrollback) args.push('-ExtraScrollback', String(extraScrollback));
  return runPwsh(args);
}

const SERVER_INSTRUCTIONS = `
This server drives genuinely visible Windows console windows -- spawn one (or several),
type into it, read exactly what's on screen, close it -- while a human watches the real
window(s) the whole time. Treat that as the point of using this server rather than a
headless alternative.

Built for fleet orchestration: spawn several terminals (each optionally running "claude"
or any other program), give each a label, send each its own task, and read each one's
output independently to decide what to do next -- one controlling session driving many.

Workflow per terminal: term_spawn -> wait ~1-2s for it to initialize -> term_send -> wait
for the target program to react -> term_read (or term_wait) to see the real result ->
repeat -> term_close when done. Always read after sending before deciding what to send
next -- do not chain multiple sends blind based on an assumption of what happened.

Identify terminals by pid (returned by term_spawn) or by the "label" you gave it -- every
tool accepts either interchangeably. term_list shows everything currently tracked.

Keys: use "text" for literal characters and "enter" to submit them -- this is delivered as
a whole block in one atomic write, not typed character by character, so length and content
(digits, symbols, multi-line) don't affect reliability. Use "keys" for actual keystrokes --
named keys (ENTER, ESC, TAB, UP/DOWN/LEFT/RIGHT, HOME, END, PGUP, PGDN, DELETE, BACKSPACE,
INSERT, BREAK, F1-F12) or a single letter/digit, optionally combined with CTRL/ALT/SHIFT via
"+", e.g. ["CTRL+C"], ["UP","UP","ENTER"], ["CTRL+SHIFT+P"], ["ALT+F4"]. This covers real
shortcuts and an interactive CLI's own keybindings (e.g. shift+enter for a newline without
submitting, inside tools like Claude Code's own TUI).

Known limitation: CTRL+C is delivered as a real keystroke (the console visibly echoes "^C"
when it arrives, confirming recognition), which reliably interrupts most interactive
programs that read it from their input stream. It does NOT reliably abort a PowerShell host
in the middle of a synchronous blocking call (e.g. a bare Read-Host prompt) -- that specific
case needs the OS's own break SIGNAL, not just the keystroke, and Windows does not expose a
way to raise that signal targeted at an unrelated already-running process from the outside.
If a worker terminal is well and truly stuck in that specific state, term_close and
term_spawn a replacement rather than expecting CTRL+C to free it.

Pace your own calls with realistic waits (seconds, not milliseconds) between term_send and
the following term_read -- reading too soon just shows stale screen content, not a failure.
Prefer term_wait over a blind sleep+read when you need to know a program has actually
produced new output or gone quiet (e.g. waiting for a worker session's response to finish).

Focus independence: term_send writes directly into the target console's own input buffer by
pid (WriteConsoleInput) -- it never touches window focus or the shared system input queue at
all. The target terminal does not need to be visible, foreground, or even unminimized, and
keystrokes will never be misdelivered to whatever window the user happens to be clicking into
or typing in at the time. This is what actually makes driving several terminals/sessions at
once, in the background, while the user keeps working on other things, safe to do.

If term_read's text doesn't make sense (garbled rendering, a TUI you can't parse from
characters alone), fall back to term_screenshot for an actual image of the window.
`.trim();

const server = new McpServer(
  { name: 'terminal-fleet-mcp', version: '0.2.0' },
  { instructions: SERVER_INSTRUCTIONS }
);

server.registerTool(
  'term_spawn',
  {
    description:
      'Open a brand-new, genuinely visible terminal window the user can watch on their own screen. ' +
      'Optionally runs a command immediately (e.g. "claude" or "claude --resume <uuid>") and/or assigns ' +
      'a friendly label you can use instead of the pid in every other tool call. Returns the pid.',
    inputSchema: {
      shell: z.enum(['powershell', 'cmd', 'wsl']).optional().default('powershell')
        .describe('Which shell hosts the window. Defaults to powershell.'),
      command: z.string().optional()
        .describe('Command to run immediately after the shell starts, e.g. "claude" or "claude --resume <uuid> --remote-control worker1". Leave empty for a blank prompt.'),
      cwd: z.string().optional().describe('Working directory to start in. Defaults to the current directory.'),
      label: z.string().optional()
        .describe('A friendly name for this terminal (e.g. "worker1") to use instead of its numeric pid in later calls. Must not already be in use by another currently-tracked terminal.'),
      env: z.record(z.string()).optional()
        .describe('Extra environment variables to set before running "command", e.g. {"NODE_ENV": "test"}.')
    }
  },
  async ({ shell, command, cwd, label, env }) => {
    if (label) {
      for (const [pid, info] of terminals) {
        if (info.label === label && isAlive(pid)) {
          return { content: [{ type: 'text', text: `Label "${label}" is already in use by pid ${pid}.` }], isError: true };
        }
      }
    }
    const args = [SEND_KEYS_SCRIPT, '-StartNew', '-StartShell', shell];
    if (cwd) args.push('-StartIn', cwd);
    if (command) args.push('-StartCommand', command);
    if (env && Object.keys(env).length) args.push('-StartEnvJson', JSON.stringify(env));

    const out = runPwsh(args);
    const m = out.match(/STARTED_PID:(\d+)/);
    if (!m) return { content: [{ type: 'text', text: `Unexpected output: ${out}` }], isError: true };

    const pid = m[1];
    terminals.set(pid, { label, shell, command, cwd, spawnedAt: Date.now() });
    const labelNote = label ? ` labeled "${label}"` : '';
    return {
      content: [{ type: 'text', text: `Spawned ${shell} terminal${labelNote}, pid ${pid}` }],
      structuredContent: { pid, label: label || null }
    };
  }
);

server.registerTool(
  'term_send',
  {
    description:
      'Send keystrokes directly into a terminal\'s own input buffer, by pid -- not by simulating a keyboard, ' +
      'so it never touches window focus and cannot be misdelivered to whatever window happens to be focused. ' +
      'The target does not need to be visible or foreground. Does not wait for a response -- call term_read ' +
      'or term_wait afterward.',
    inputSchema: {
      pid: z.string().describe('Process id or label from term_spawn/term_list'),
      text: z.string().optional().describe('Literal text to send (e.g. a command or a chat message). Delivered as one atomic block, not typed character by character -- length and content (digits, symbols, multi-line) do not affect reliability.'),
      enter: z.boolean().optional().default(false).describe('Press Enter after the text/keys.'),
      keys: z.array(z.string()).optional()
        .describe('Key combos sent in order before text, e.g. ["CTRL+C"], ["UP","UP","ENTER"], ["CTRL+SHIFT+P"], ["ALT+F4"]. Named keys: ENTER, ESC, TAB, UP, DOWN, LEFT, RIGHT, HOME, END, PGUP, PGDN, DELETE, BACKSPACE, INSERT, BREAK, F1-F12, or a single letter/digit -- optionally combined with CTRL/ALT/SHIFT via "+".')
    }
  },
  async ({ pid, text, enter, keys }) => {
    const resolved = resolvePid(pid);
    const actions = [];
    try {
      if (keys && keys.length) actions.push(...keys.map(parseKeyToken));
      if (text) actions.push(...textToActions(text));
      if (enter) actions.push(parseKeyToken('ENTER'));
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    if (!actions.length) return { content: [{ type: 'text', text: 'Nothing to send.' }] };

    // The whole action sequence goes in a single WriteConsoleInput-backed call --
    // one atomic write into the target's own buffer, not one process per key.
    try {
      const out = runPwsh([SEND_KEYS_SCRIPT, '-ProcessId', resolved, '-ActionsJson', JSON.stringify(actions)]);
      return { content: [{ type: 'text', text: out.trim() }] };
    } catch (e) {
      const msg = e.stderr ? e.stderr.toString() : e.message;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
);

server.registerTool(
  'term_read',
  {
    description:
      'Read exactly what is currently rendered on screen in a terminal window, via the real Windows Console ' +
      'API (not a screenshot) -- the same thing the user sees if they look at that window.',
    inputSchema: {
      pid: z.string().describe('Process id or label from term_spawn/term_list'),
      withColor: z.boolean().optional().default(false)
        .describe('Annotate colored text runs inline as [RED]...[/RED] etc, so errors/warnings (often colored) are distinguishable from normal output.'),
      extraScrollback: z.number().int().optional().default(0)
        .describe('Also read this many extra lines of buffer history above the currently-visible window.')
    }
  },
  async ({ pid, withColor, extraScrollback }) => {
    const resolved = resolvePid(pid);
    try {
      const out = await doRead(resolved, { withColor, extraScrollback });
      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Read failed: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'term_wait',
  {
    description:
      "Block until a terminal's output either contains specific text, or goes idle (stops changing), or a " +
      'timeout elapses -- instead of guessing a sleep duration before term_read. Useful for waiting on a slow ' +
      "command, or on a worker session to finish responding before sending its next instruction.",
    inputSchema: {
      pid: z.string().describe('Process id or label from term_spawn/term_list'),
      forText: z.string().optional()
        .describe('Stop as soon as the screen contains this substring, or matches this /regex/ (wrap in slashes to use regex).'),
      idleMs: z.number().int().optional()
        .describe('Stop once the screen is unchanged for this many milliseconds. Defaults to 1500ms if forText is not given.'),
      timeoutMs: z.number().int().optional().default(30000).describe('Give up after this many milliseconds.'),
      pollIntervalMs: z.number().int().optional().default(800).describe('How often to re-check.')
    }
  },
  async ({ pid, forText, idleMs, timeoutMs, pollIntervalMs }) => {
    const resolved = resolvePid(pid);
    const effectiveIdleMs = idleMs || (forText ? null : 1500);

    let matcher = null;
    if (forText) {
      const regexMatch = forText.match(/^\/(.*)\/([a-z]*)$/);
      matcher = regexMatch ? new RegExp(regexMatch[1], regexMatch[2]) : forText;
    }

    const start = Date.now();
    let lastText = null;
    let lastChangeAt = start;

    while (true) {
      let current;
      try {
        current = await doRead(resolved);
      } catch (e) {
        return { content: [{ type: 'text', text: `Read failed: ${e.message}` }], isError: true };
      }

      if (matcher) {
        const matched = typeof matcher === 'string' ? current.includes(matcher) : matcher.test(current);
        if (matched) {
          return {
            content: [{ type: 'text', text: current }],
            structuredContent: { matched: true, reason: 'text', elapsedMs: Date.now() - start }
          };
        }
      }

      if (current !== lastText) {
        lastText = current;
        lastChangeAt = Date.now();
      } else if (effectiveIdleMs && Date.now() - lastChangeAt >= effectiveIdleMs) {
        return {
          content: [{ type: 'text', text: current }],
          structuredContent: { matched: true, reason: 'idle', elapsedMs: Date.now() - start }
        };
      }

      if (Date.now() - start >= timeoutMs) {
        return {
          content: [{ type: 'text', text: (lastText || '') + '\n[term_wait timed out]' }],
          structuredContent: { matched: false, reason: 'timeout', elapsedMs: Date.now() - start }
        };
      }

      await sleep(pollIntervalMs);
    }
  }
);

server.registerTool(
  'term_screenshot',
  {
    description:
      "Capture an actual image (PNG) of a terminal window via PrintWindow, as a fallback for when term_read's " +
      "character-buffer text doesn't make sense -- garbled rendering, or a TUI that depends on visual layout.",
    inputSchema: { pid: z.string().describe('Process id or label from term_spawn/term_list') }
  },
  async ({ pid }) => {
    const resolved = resolvePid(pid);
    const outFile = path.join(os.tmpdir(), `term-fleet-${resolved}-${Date.now()}.png`);
    try {
      runPwsh([SCREENSHOT_SCRIPT, '-ProcessId', resolved, '-OutFile', outFile], 15000);
      const data = fs.readFileSync(outFile).toString('base64');
      fs.unlinkSync(outFile);
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    } catch (e) {
      try { fs.unlinkSync(outFile); } catch {}
      const msg = e.stderr ? e.stderr.toString() : e.message;
      return { content: [{ type: 'text', text: `Screenshot failed: ${msg}` }], isError: true };
    }
  }
);

server.registerTool(
  'term_list',
  {
    description: 'List every terminal this server has spawned and is tracking, with pid, label, shell, command, cwd, and whether it is still alive.',
    inputSchema: {}
  },
  async () => {
    const rows = [...terminals.entries()].map(([pid, info]) => ({
      pid,
      label: info.label || null,
      shell: info.shell,
      command: info.command || null,
      cwd: info.cwd || null,
      alive: isAlive(pid),
      spawnedAt: new Date(info.spawnedAt).toISOString()
    }));
    const text = rows.length
      ? rows.map((r) => `pid ${r.pid}${r.label ? ` (${r.label})` : ''} -- ${r.shell}${r.command ? ` "${r.command}"` : ''} -- ${r.alive ? 'alive' : 'DEAD'}`).join('\n')
      : 'No terminals tracked.';
    return { content: [{ type: 'text', text }], structuredContent: { terminals: rows } };
  }
);

server.registerTool(
  'term_close',
  {
    description: 'Close a terminal window and everything running inside it (terminates the whole process tree, not just the shell).',
    inputSchema: { pid: z.string().describe('Process id or label from term_spawn/term_list') }
  },
  async ({ pid }) => {
    const resolved = resolvePid(pid);
    try {
      // taskkill /T kills the whole process tree. Stop-Process alone only kills the
      // shell itself -- Windows does not auto-kill children when a parent dies, so a
      // long-lived child (e.g. a "claude" session run via term_spawn's command) would
      // otherwise keep running invisibly after its window closes. Confirmed empirically:
      // closing a terminal running "claude" left the claude.exe process alive as an orphan.
      execFileSync('taskkill.exe', ['/PID', String(Number(resolved)), '/T', '/F'], { stdio: 'ignore' });
      terminals.delete(resolved);
      return { content: [{ type: 'text', text: `Closed pid ${resolved} and its process tree` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Close failed: ${e.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
