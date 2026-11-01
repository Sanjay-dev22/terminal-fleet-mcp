# Motivation

## The incident

An AI coding agent was asked to launch a second, remote-controllable session on behalf of a user who was away from their primary machine, so they could continue working from a phone or browser. The agent used a standard technique: resume an existing session by ID in a new process, with remote control enabled at launch.

Unknown to the user, another window on the primary machine was still attached to that same session, sitting idle. Both processes were, in effect, pointed at the same underlying transcript file.

Over the next ~20 hours, real work was done entirely through the remote session: messages sent, files edited, a feature built. Everything appeared to work — the remote interface showed complete, successful responses throughout.

None of it was ever saved. When the user returned and resumed the session locally, the entire stretch was missing — not corrupted, not forked into a separate file, just silently absent. The idle window's stale process had clobbered it the moment it next touched the file.

## Why it went undetected for so long

The agent had no way to independently verify that what it was doing was actually landing anywhere. Its confirmation came entirely from the same channel that was failing: the remote interface itself reported success, because from its point of view, nothing *had* failed — the messages really were being sent and answered. The loss happened one layer down, in how (or whether) that activity got persisted to disk, which the remote interface had no visibility into either.

Once this was identified, the agent reproduced the failure mode deliberately, under controlled conditions, to confirm the mechanism before concluding anything about root cause.

## Reproducing it, and the second problem it exposed

To test the hypothesis safely, the agent needed to drive a second terminal process itself — one side of a two-terminal interaction — without a human needing to be the one typing. The first attempt used a headless approach (a pseudo-terminal spawned via `node-pty`/ConPTY): fast, scriptable, and — critically — **just as invisible as the original failure**. The human asking for the reproduction had no way to watch it happen; they had to take the agent's word for what the hidden terminal was doing and how it responded, which was uncomfortably close to the exact trust gap that caused the original incident.

That observation is what this project is actually about. The specific data-loss bug was real and worth finding, but the deeper problem was procedural: **an agent should not be the sole witness to its own actions when a human explicitly wants to watch.** A tool for "let the agent control a terminal" needs a visible-by-default option, not just a headless one.

## The result

`terminal-fleet-mcp` deliberately spawns a real, classic console window instead of a hidden pseudo-terminal, and reads back what's on screen through the same Windows Console API a human's own eyes are looking at — so a supervised agent action and an unsupervised one produce a terminal that looks and behaves identically to the person watching it.

The original data-loss bug itself is a separate, upstream issue in the host tool's handling of concurrent session resumption — this project doesn't fix that. What it fixes is the *inability to watch while testing for it*, which is the gap that let the original incident go unnoticed as long as it did.
