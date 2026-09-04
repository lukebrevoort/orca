# Feedback Kit React integration

This workspace package is vendored from
https://github.com/lukebrevoort/feedback-kit at commit
`fd79336faf9707e2f4a913544de76ca0bcb8b7bb`.

The source is kept under the existing Orca Bun workspace so the browser widget
can be type-checked and bundled with the app without exposing server-only
Linear or OpenAI adapters.

Orca keeps its local `capture.ts` compatibility layer on top of the vendored
widget so screenshots can safely serialize the app's modern CSS color values.
