# Contributing to spareloop

Thanks for helping! The fastest ways to make spareloop better:

## 🥇 Most valuable right now

1. **Rate-limit message samples.** When Claude Code / Codex / Cursor blocks you, the exact
   error text (redact anything personal) lets us parse reset times reliably across
   versions. Open an issue titled `rate-limit sample: <tool> <version>` with the verbatim
   message and your plan tier.
2. **Codex / Cursor adapter validation.** Both are built against documented flags but need
   real-install testing. Run a queued task, report what broke (or worked).
3. **Roadmap items** in the README — comment on an issue before starting big ones.

## Development

```bash
npm install
npm test                      # build + unit tests (node:test)
SPARELOOP_HOME=/tmp/sl-dev node dist/src/cli/index.js init   # isolated sandbox, never touches your real data
```

Rules of the codebase:

- **Never fabricate metrics.** If a tool doesn't report a number, store NULL; derived
  numbers are flagged (`cost_usd_estimated`).
- **Capability-gate, don't special-case.** Cursor has no rolling window — that's expressed
  in the type system (`RollingWindowAdapter`), not scattered `if (tool === 'cursor')`.
- **The daemon must never crash on bad input.** Parsers are defensive; logging never throws.
- Tests use `SPARELOOP_HOME` pointed at a temp dir. Tests must not spawn real AI CLIs.
- New CLI commands need a test in `test/cliEndToEnd.test.ts` that spawns the actual compiled binary
  (`execFileSync`) and checks real stdout/exit code — every other test file calls internal functions
  directly and would miss a wiring regression in `cli/index.ts` itself (a renamed flag, a broken parser).

## Regenerating the README demo GIF

`demo/demo.gif` is auto-generated with [vhs](https://github.com/charmbracelet/vhs) against a
seeded, synthetic dataset — no manual screen recording, and no real user data:

```bash
brew install vhs   # or see vhs install docs for your platform
npm run build
node demo/seed.js demo/.demo-home
SPARELOOP_REPO_DIR=$(pwd) vhs demo/demo.tape
```

`demo/seed.js` never runs `daemon tick`/log ingestion — that would pull in the real
`~/.claude` session logs on whatever machine renders it. It precomputes the pattern
directly from the synthetic events instead, so the output is reproducible.

## Regenerating the animated explainer video

`demo/explainer.mp4` is drawn frame-by-frame with Pillow (Python) and encoded with
ffmpeg — no screen recording, no manual video editor:

```bash
python3 -c "import PIL"   # Pillow; pip3 install Pillow if missing
python3 demo/render_explainer.py
```

It illustrates the prewarm mechanism itself (dead zone → prewarm ping → dead zone
eliminated), using the same numbers as the real measured pattern. Edit the `SCENES`
list and per-scene functions in `demo/render_explainer.py` to change timing or content.

## Pull requests

- One focused change per PR, with a test where behavior changed.
- `npm test` green.
- If you touch a vendor flag (e.g. `--permission-mode`), link the doc page you verified it against.
