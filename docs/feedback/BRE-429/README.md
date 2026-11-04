# BRE-429: upload-preparation contract investigation

Status: review-ready diagnostics and response-validation hardening; production delivery cause remains unconfirmed.

Production diagnostics after PR #287 show repeated `upload_prepare`, HTTP 200, `failed` results. That stage covers GraphQL rejection, malformed/missing upload metadata, rejected upload/asset destinations, and rejected PUT headers. It does not prove that any PUT or issue creation occurred on those attempts; it also cannot establish the outcome of earlier submissions.

## Primary-source contract review

- [Official SDK schema, pinned revision](https://github.com/linear/linear/blob/4d9cdbf0beb1d1da1824deb5ff3cd458c71380c9/packages/sdk/src/schema.graphql): `fileUpload` accepts required `contentType: String!`, `filename: String!`, and `size: Int!`, plus optional `makePublic: Boolean` (default false). `UploadPayload` has `success: Boolean!` and nullable `uploadFile`. `UploadFile` requires string upload/asset URLs and a non-null array of non-null key/value headers. Orca's query matches these fields and explicitly requests private storage.
- [Official upload guide](https://linear.app/developers/how-to-upload-a-file-to-linear): prepare metadata, then PUT from the server with the returned headers. It does not enumerate every possible signed-upload hostname or required header name. Therefore it cannot justify relaxing Orca's existing destination/header allowlists.
- [Official storage authentication](https://linear.app/developers/file-storage-authentication): assets are private at `uploads.linear.app`; a separate request header opts into temporarily signed asset URLs. Orca does not send that opt-in header and continues rejecting signed/public asset URLs.
- [Official GraphQL error handling](https://linear.app/developers/graphql): HTTP 200 can contain GraphQL errors/partial data. Reject errors before accepting success. Previously message-less error entries could be ignored when success metadata was also present; this patch fails closed on all nonempty/malformed error lists.

## Change and boundaries

Static reason codes distinguish `upload_graphql`, `upload_response`, `upload_url`, `asset_url`, and `upload_headers`. No upstream messages, error codes, URLs, header names/values, credentials, filenames, payloads, or user/ticket identifiers are logged. Unexpected response types and malformed headers fail closed before PUT. Destination and header allowlists, redirect rejection, private-upload flag, attachment limits, and credential handling remain unchanged.

The server-derived issue UUID, exact-payload client retry, pre-create reconciliation, and upload cache are unchanged. Failed preparation is never treated as absence of an existing ticket or permission to create another one.

This cannot identify the actual production rejection until these bounded reasons are deployed with authorization and a separately authorized attempt produces a log. No live upload-preparation mutation, file upload, feedback submission, or issue creation was used in this investigation. A real production delivery fix cannot be claimed from the current evidence. PR #288's reader-scroll work is separate and untouched.
