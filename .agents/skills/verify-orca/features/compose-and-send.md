# Compose, persist and send

## Sub-features

Compose a new message, restore it after reload, add To/Cc/Bcc, add/remove attachments, and suppress duplicate delivery.

## How to get to it (user POV)

Click the Compose button in the mailbox. Fill Subject and Message body, add recipients, then Send.

## Driving it with Playwright

The existing `compose-fixture-e2e.mjs` uses `getByRole("textbox", {name:"Subject", exact:true})`, `getByRole("textbox", {name:"Message body", exact:true})`, `getByRole("combobox", {name:"Add To recipient"})` and `.compose-workspace-panel`. It reloads the real page and verifies persisted subject/body through UI and `/v1/drafts`. Two rapid Send clicks must yield exactly one `/__fixture/deliveries` entry with the correct recipients, body and remaining attachment. Evidence includes `light-draft-before-reload.png` / `dark-draft-before-reload.png` and attachment screenshots.

## Gotchas

The provider is synthetic. Saved to Orca and Gmail is product UI text, not proof of live Gmail persistence. Uploaded bytes stay in the disposable test context. Browser verification does not prove native compose.
