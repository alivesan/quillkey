# QuillKey Windows native helper

Build with `powershell -ExecutionPolicy Bypass -File native/build.ps1`. Requires Windows x64 and the Windows .NET Framework 4 compiler. Launch `native/QuillKey.Native.exe` with redirected stdin/stdout; retain the process for the app lifetime. The helper has a hidden WinForms message loop. It never logs transcript text.

## JSON-lines protocol

Each command/event is one UTF-8-compatible JSON line. All events are written on stdout. The target object is opaque and is valid only in the process that created it.

Events:

- `{"type":"ready","ok":true,"hotkey":"Ctrl+Alt+Space","reason":"ready"}`. If registration fails, `ok:false`, `reason:"hotkey-unavailable"`; the app must expose the failure.
- `{"type":"press","target":{"token":"opaque random token"}}` captures the exact foreground window, process ID and focused control. Ctrl+Alt+Space uses `RegisterHotKey` with no repeat.
- `{"type":"release"}` when any of Space, Ctrl or Alt is released.
- `{"type":"cancel"}` on Escape while held or active. Invalidates the token. No hotkey is intercepted when idle except Ctrl+Alt+Space.
- `{"type":"insert-result","id":"request-id","ok":true,"reason":"paste-sent-clipboard-restored"}`. Success confirms that Windows accepted the paste keystrokes, not that an arbitrary application actually consumed the text. Clipboard may change meanwhile: success reason then is `paste-sent-clipboard-changed`.

Commands:

- `{"type":"active","value":true}` keeps Escape cancellation active during transcription. Set false when finished/cancelled. This invalidates the target and cancels pending insertion; send false only after the insert result if insertion is wanted. The press already sets active true.
- `{"type":"insert","id":"request-id","text":"transcript","target":{"token":"opaque random token"}}`. Text must contain 1–100000 characters. A consumed token cannot be reused. On failure retain the transcript in the app for explicit copy/retry.
- `{"type":"quit"}` gracefully exits; stdin EOF also exits.

Failure reasons: `invalid-command`, `invalid-target`, `invalid-text-length`, `insertion-busy`, `cancelled`, `modifiers-held`, `focus-changed`, `password-field`, `clipboard-snapshot-failed`, `clipboard-changed-during-snapshot`, `clipboard-unavailable`, `input-blocked`. `input-blocked` includes Windows integrity-level/UIPI restrictions, such as an ordinary helper attempting to paste into an elevated program.

The helper waits asynchronously for up to 2 seconds for Ctrl/Alt/Shift/Windows/Space to be released. Escape or active:false cancels this pending request before any paste. A modifiers-held timeout retains the transcript in the app. It validates foreground and focused control immediately before pasting. The only production activation exception is restoration after a registered widget click, as described below. Native Edit/RichEdit password controls and UI Automation IsPassword inputs are refused. UI Automation errors during password detection also refuse insertion. Captured UI Automation runtime IDs protect controls sharing one HWND when providers expose distinct elements. If an application exposes no UI Automation focus identity, validation falls back to HWND/process/focused-control identity; custom browser controls that hide their accessibility identity cannot be distinguished reliably.

Every native clipboard format must be safely copied before any clipboard mutation. Strings, string arrays, byte arrays, memory streams, bitmaps and primitive integer/boolean formats are supported; unknown/unreadable formats cause conservative refusal. After a single Ctrl+V paste, restoration waits 600 ms and occurs only if the clipboard sequence still belongs to this paste. A user clipboard change is preserved. Large or unusual clipboard contents may therefore prevent automatic insertion. The focus check and SendInput have an unavoidable small cross-process timing gap.

## Isolated self-test

`native/QuillKey.Native.exe --self-test` opens its own textbox, pastes a fixed sentinel only into that textbox, verifies clipboard restoration and verifies that switching its focused textbox invalidates the captured target. It snapshots/restores the original clipboard and refuses to run when that cannot be done. It waits up to 60 seconds for its own test textbox to receive focus. Original clipboard cleanup is conditional on the test still owning the clipboard sequence; concurrent user clipboard updates are preserved. This test mode activates only its own window. It does not register a hotkey or type into other user applications.

Compile verification passed on this machine. The isolated test could not complete in the available execution session: sandboxed execution reported clipboard-snapshot-failed, and host execution reported test-window-not-focused. Both paths refused to send input. Run the test from an interactive desktop terminal for the actual paste assertion; exit code 0 and a final `self-test` event with all booleans true indicate success.

Diagnostic events contain only a fixed code and exception class (never clipboard content or transcript text).



Run `native/QuillKey.Native.exe --logic-test` for noninteractive protocol guard checks. It shows no window, registers no hotkey and calls no clipboard/global-input API. It verifies stale target rejection, empty transcript rejection, malformed command rejection, active:false invalidation and prevention of pending execution after cancellation. This test passes with exit code 0.


## Overlay capture

Send `{"type":"capture","id":"request-id"}` while the external destination still has focus. The ID must be a nonblank string of at most 256 characters. Success returns `{"type":"capture-result","id":"request-id","ok":true,"target":{"token":"opaque token"},"reason":"captured"}` and enters active state. Use that target with the ordinary insert command and finish with active:false. Capture never activates a window or sends input.

Failure returns capture-result with the same ID, ok:false, target:null and reason `capture-busy`, `no-valid-focus`, or `password-field`. Invalid IDs return an empty ID and `invalid-id`. Held, active, insertion-busy and pending-insertion states refuse capture before inspecting focus and preserve the existing target. The helper refuses its own process as an overlay destination. The desktop client must preserve external focus when interacting with its overlay; this native check cannot distinguish every separate Electron process.

The expanded --logic-test passes capture ID validation (missing, number, blank and oversized IDs) and each busy-state guard independently, including existing-token preservation. These cases do not call focus, clipboard or input APIs. Build and logic-test passed on 2026-10-23; actual capture/paste requires the interactive integration check below.

## Passive widget destination

Build with `powershell -ExecutionPolicy Bypass -File native/build-test.ps1`, then run `native/WidgetTest.exe` with stdout connected to the test runner. This opens a multiline textbox titled **QuillKey widget test target** until manually closed. Each text change writes a JSON `widget-test-text` event containing the synthetic textbox content to stdout. Use only synthetic content in this test window. It writes no files, installs no hooks, reads no clipboard, and never types or pastes automatically. The compiled executable is covered by the existing native/*.exe gitignore rule and is separate from the shipped helper.

For manual integration, focus this textbox, use the app's --synthetic-mic overlay to start and stop recording, and confirm both the visible transcript and widget-test-text event. The native helper handles capture and clipboard-preserving insertion; this passive target only observes the resulting textbox content.

Insertion focus refusals also emit `diagnostic` with code `insertion-focus-mismatch`, stage `before-snapshot` or `before-input`, and a fixed reason: `foreground-window-changed`, `foreground-process-changed`, `native-focus-unavailable`, `native-focus-changed`, `automation-focus-unavailable`, or `automation-focus-changed`. These diagnostics contain no HWND, process ID, runtime identity, window text or transcript. The insert-result remains `focus-changed`; the diagnostic only explains which existing identity check failed.

Successful overlay capture additionally emits `diagnostic` code `capture-target-metadata` with `processId`, `windowClass`, `focusClass`, `automationControlType`, and `hasAutomationIdentity`. These fields identify the destination process and generic control classes for integration diagnosis without reading field contents, accessibility names, window titles or transcript text.

## Widget focus restoration

The desktop shell registers its two current top-level windows with `{"type":"own-windows","widget":"decimal HWND","dashboard":"decimal HWND"}`. Handles are nonnegative decimal strings; zero means absent. Invalid registration preserves both previous handles. Refresh registration when either window is recreated. Both registered windows are excluded as capture destinations, including hotkey capture.

While idle, the helper samples only the external foreground identity at most once every 150ms. It caches the HWND, process, focused control and available UIA identity; it reads no field contents. The cache freezes throughout recording/transcription/insertion. If capture arrives while the registered widget has foreground, the helper may activate the cached external window only when the cache is at most five seconds old. Capture succeeds only after exact cached native/UIA focus identity matches and password checks pass. If the dashboard or an unrelated window has foreground, no such restoration occurs.

Insertion may similarly restore the original captured window only while the registered widget has foreground. It then applies the original exact HWND/process/focus/UIA checks before the usual clipboard operation. Moving to the dashboard or any unrelated application still refuses insertion. This restoration handles widget clicks that activate the overlay despite its nonfocusable configuration; it never searches for a replacement field or forces focus onto a different control. A reported paste-sent result still only confirms Windows accepted the input, so inspect the passive target's visible content for the integration assertion.

Logic tests also verify own-window membership, zero/unrelated exclusion and atomic rejection of negative/nonnumeric handle registration.
