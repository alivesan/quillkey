# Local engine integration validation

Run: `node tests/session-integration.mjs` from `prototype`, 2026-10-23.
Endpoint: `http://127.0.0.1:8765`, live local NVIDIA Nemotron engine.
Result: 4/4 checks passed; process exit 0.

| Check | Observed behavior |
| --- | --- |
| Origin rejection | HTTP status request and WebSocket upgrade with `https://untrusted.example` both returned 403. |
| Concurrent session | Second client received `Another recording is active.` and close code 1013. First client closed and server became idle. |
| Empty commit | Received `input_audio_buffer.committed`; no nonempty transcript was generated. |
| Cancellation and reuse | Terminated a session after 0.5 seconds of audio; server became idle; fresh session accepted the synthetic fixture and returned completed text. |

Fresh-session transcript: “Please send the draft tomorrow morning. We should keep the blue version”.

The integration script uses the existing `tests/fixtures/synthetic-english.wav`, checks real returned text, and cleans up its sockets. It runs sequentially and requires an idle, ready prototype. This is a synthetic speech integration test; microphone capture and subjective recognition quality require separate validation.
