# Tab Closer

Tab Closer closes a tab when its completed top-level document URL matches a saved JavaScript regular expression. It runs as a local Manifest V3 extension in Chromium or Microsoft Edge. It does not inspect sign-in state or make network requests of its own.

## Install

1. Open `chrome://extensions/` in Chromium or `edge://extensions/` in Edge.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository directory.
4. Click the Tab Closer toolbar action to open the full page settings. You can also open the extension's options from the extension manager.

The extension needs `webNavigation`, `tabs`, and `storage`. It has no host permissions or content scripts. Settings live in the browser profile's local extension storage. Browser restarts preserve them; uninstalling the extension clears them.

## Rules and tester

Enter one JavaScript regex source in each filter field, with no `/` delimiters or flags field. Use **Add filter** to create another field and **Remove** to delete one. Paste a URL into a filter and select **Add escape characters** to escape regex syntax characters in that field. Each click escapes the current text, including any backslashes already present. Blank and whitespace-only filters are ignored. Other filters are preserved exactly, including spaces. A match anywhere in the browser-provided URL counts, so use `^` and `$` to anchor it. The URL includes its query and fragment. Matching is case-sensitive by default; inline modifiers work if the installed browser supports them.

For example:

```text
^https://www\.reddit\.com/
```

The tester evaluates the editable draft against the exact string in its URL field. It lists every matching filter number. It does not navigate or close tabs. **Save filters** validates each nonblank field, then writes the whole draft as one versioned record. A failed validation or storage write leaves the previously saved filters in place. Empty saved filters close nothing. Existing newline-separated saved rules load into individual fields.

Saving, starting the extension, or restarting the browser does not scan open tabs. A later eligible document completion can close a matching tab, including a selected, background, pinned, or last tab in a window. Closing the last tab can close its window. The extension does not delay closing once its checks finish.

## Event and execution limits

The extension listens to `webNavigation.onCompleted` for active top-level documents. It checks that the same document and URL remain current before requesting removal. Iframe completion and same-document History API or fragment changes do not start a close. A redirect destination or a loaded 404 document can match. An eligible completion after cache restoration can match. Inactive prerendered documents are ignored until an eligible active completion occurs.

Native JavaScript regex matching is synchronous and has no general time bound. A syntactically valid pattern can backtrack for a long time and stall the service worker or settings tester. Syntax validation does not prove a rule is cheap to evaluate. Do not use patterns whose cost you do not trust. A stalled match also delays cancellation handlers. Navigation and settings changes are not atomic with tab removal, and a stopped service worker can miss an event. Closure is not guaranteed for every eligible load.

Browser-internal, `blob:`, extension, and other URL schemes follow the completion events the browser actually exposes. They are not guaranteed to emit them. A broad rule can match an extension manager page that does emit completion; the full page options document remains available as a recovery route.

The extension stores no visited URLs, tester input, or tab history. Error reports omit URLs and raw browser API error messages.

## Run checks

```sh
npm test
npm run test:browser
npm run test:edge
npm run test:lifecycle
```

`npm test` uses API doubles for rule behavior and cancellation races. The browser commands need local loopback binding and launch isolated, temporary browser profiles. They never use the normal browser profile. The browser harness uses the macOS Chromium and Edge application paths shown in `tests/browser.mjs` and `tests/lifecycle.mjs`. Each browser run prints an evidence directory containing `results.json`, browser logs, and an options screenshot where applicable; it removes its temporary profile at the end.

On 2026-09-25, the commands above passed with Node `v24.12.0`, Chromium `152.0.7977.82`, and Edge `153.0.4234.48` on this machine. The Chromium run observed real removal after a delayed response completed; nonmatches staying open; selected, background, pinned, and sole-window-tab removal; redirect destination and 404 closure; iframe and post-completion History API/fragment changes staying open; no scan on save followed by closure on reload; back/forward cache restoration with the same document ID and a new completion; a failed navigation staying open; and full page settings remaining usable under a broad rule. With a broad rule, an extension options page and a blob page stayed open while the browser extension manager closed. Chromium and Edge both checked adding and removing fields, filter numbering, invalid-save preservation, an injected storage-write rejection, draft tester results, and loading and saving an older multiline record without changing its rules. The Edge smoke run also observed basic completion closure and nonmatches. A separate Chromium run observed saved rules after browser restart, closure after restart, worker target disappearance after idling, and closure on the next completion.

The tests did not exercise an actual toolbar click in the browser chrome, a genuine storage write failure, prerender activation, or a forced worker stop during pending work. The toolbar action listener and cancellation paths have API-double coverage. Browser coverage is limited to the versions and cases above.
