# Windows desktop validation

## v0.3.1 long dictation — 2026-10-24

- Recording now stops gracefully at 30 minutes from engine readiness. Server and desktop watchdogs allow 32 minutes; the existing finalization deadline remains 30 seconds in the renderer.
- 39 tests pass, including virtual-time coverage past the old 125-second cutoff, automatic flush/commit at 30 minutes, exactly-once final reporting, timer cleanup on cancellation/error, and automatic-stop clipboard delivery without a second click.
- Packaged v0.3.1 synthetic microphone-to-model smoke test passed (expected phrase recognized, exit 0, clean server/helper shutdown).
- Per-user v0.3.1 installer exited 0; installed executable reports 0.3.1.0.
- These timer tests do not establish 30-minute real-audio accuracy, memory use, or GPU stability. No full 30-minute endurance run has been performed.

## v0.3.0 update — 2026-10-24

- `npm test`: 36 passing tests, including hover/click lifecycle, destroyed-window IPC regression, clipboard success verification, copy failure, stale/cancelled finals, helper exit, and timeout fallback.
- Native compilation and `--logic-test` pass, including target-cache freshness, capture concurrency, and restoration guards.
- Packaged v0.3.0 `--smoke-test` passed with the bundled model and synthetic microphone: expected phrase recognized, exit 0, speech server and native helper exited cleanly. This checks transcription and final IPC, not automatic target insertion.
- v0.3.0 NSIS installer completed with exit 0; installed executable reports 0.3.0.0. Installer is unsigned. SHA-256: `C644AB8F6EAA2B14CDCAD9435096CDB006D15A099577A939BE29AD80A9AF2421`.
- Floating microphone supports hover expansion and click-to-start/click-to-stop. Failed target capture starts copy-only dictation; refused insertion copies the final transcript and displays “Copied — press Ctrl+V”. Successful native insertion retains the existing clipboard restoration behavior. Neither path presses Enter.
- Fixed the reported shutdown `Object has been destroyed` exception by rejecting late IPC from destroyed windows/frames.
- Actual hover-driven paste into third-party apps remains unverified. Earlier interactive testing encountered Windows focus-restoration refusal; clipboard fallback is provided for that case. The mocked timeout test does not prove operating-system process termination. Do not interpret a native SendInput success as confirmation that every target app consumed text.

The results below describe the prior v0.2.0 build, not validation of every v0.3.0 interaction.

Validation date: 2026-10-23. Windows x64, RTX 2070 SUPER 8 GB, Electron 45.0.0, NeMo-Speech.cpp 0.2.0, Nemotron English 0.6B Q8.

## Completed

- `npm test`: 18 tests passed. Covers PCM capture at multiple sample rates, tail flushing, completed segments, quick release during permission/socket setup, stale commands, final emitted exactly once, cancellation, error recovery, and native-shortcut readiness reporting.
- Native helper compilation succeeds with the Windows .NET Framework compiler.
- `QuillKey.Native.exe --logic-test`: all five guards pass (invalid target, empty text, pending cancellation, no cancelled insertion execution, malformed command).
- `QuillKey.Native.exe --self-test`: interactive disposable test window passed real SendInput paste, clipboard restoration, and focus-change refusal. Test window was activated using computer-use; it closed after success. Existing clipboard was preserved.
- Real Electron `--smoke-test`: synthetic microphone -> AudioWorklet -> local WebSocket -> CUDA -> final transcript -> IPC passed. Expected phrase recognized; exit 0, server/helper shutdown exit 0. Chromium loops the fixture, so the test may return a repeated phrase. This is a synthetic integration check, not an accuracy score.
- Dependency audit: zero reported vulnerabilities after installing current pinned Electron/build tools and ws.
- Final `dist/win-unpacked/QuillKey.exe --smoke-test`: packaged executable and bundled model passed, exit 0; native helper and server exited 0.
- NSIS installer completed per-user installation with exit 0; installed executable exists under LocalAppData/Programs/QuillKey. Authenticode status is NotSigned.
- Installer size: 877,060,115 bytes. SHA-256: `2323fb1badc5c4b9c53e7412e97210aaafb225f27c8058c43b6745297664a17f`.

## Interpretation and remaining manual matrix

The desktop renderer and native paste were exercised separately. A human microphone dictation spanning the global shortcut and a third-party target application still needs hands-on testing. Native SendInput success means input was sent, not proof every app consumed text. Clipboard restoration uses a 600 ms delay and cannot confirm paste consumption universally.

| Scenario | Expected check |
| --- | --- |
| Notepad, browser textarea, editor | Hold shortcut, speak, release; exactly one final paste, original clipboard restored |
| Quick tap | Pending capture cancels; no microphone left active |
| Focus moves to another app or control | No paste; transcript remains available to copy |
| Escape while recording/finalizing | No automatic insertion; microphone released |
| Modifiers briefly held after Space release | Up to two seconds to release modifiers before insertion is refused |
| New clipboard data during restore delay | New clipboard content remains untouched |
| Password, unsupported, elevated target | Refuse unsafe insertion or retain transcript for manual copy |
| Engine exits or GPU allocation fails | Error shown, no insertion, user can restart |
| Ordinary speech / technical names / spoken correction | Measure raw recognition; no semantic cleanup guarantee |
| Offline after installation | Transcription remains local; no remote dependency required |

No AI rewriting is implemented. Installer is unsigned; broad third-party application compatibility is not yet established.
