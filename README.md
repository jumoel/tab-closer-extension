# Tab Closer

Tab Closer is a browser extension for Chromium and Microsoft Edge. It closes a tab when a page finishes loading at a URL you've chosen. It is useful for leftover tabs after signing in through command-line tools, or any other page you no longer need. It closes nothing until you save a filter.

## Install

1. Open the [latest release](https://github.com/jumoel/tab-closer-extension/releases/latest) and download `tab-closer-<version>.zip`.
2. Extract the ZIP into a folder you will keep. The folder should contain `manifest.json`.
3. Open `chrome://extensions/` in Chromium or `edge://extensions/` in Edge, then enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder.
5. Open the browser's Extensions menu and select Tab Closer to open its settings. If you pin it, you can also click its toolbar icon.

The ZIP itself is not a browser installer. GitHub downloads do not update automatically. To update, extract a newer ZIP into the same folder, replace the old files, then reload the extension from the extensions page.

## Choose what to close

Add one URL filter per field. Filters are JavaScript regular expressions, and matching is case-sensitive by default. Use **Add filter** for another field. Blank fields are ignored.

For a literal URL, paste it into a filter and click **Add escape characters** once. This escapes regex punctuation such as `.` and `?`, so those characters match as written. The button does not add `^` or `$`. Clicking it again also escapes the backslashes it added the first time.

Paste a URL into **Test a URL** and click **Test draft** before saving. The tester uses your unsaved filters, highlights matches, and names them in the result. It does not visit the URL or close a tab. When the result looks right, click **Save filters**. Only saved filters affect later page loads.

For example:

```text
^https://login\.example\.com/done$
^https://docs\.example\.com/archive/
```

The first matches only that complete URL. The second matches pages under `/archive/`, such as `/archive/report`. `^` means the start of the URL, and `$` means the end. Without them, a filter can match anywhere in the URL. The URL includes its query string and `#` fragment.

Tab Closer checks a page when it finishes loading. Saving a filter does not scan tabs already open. Changing the URL without loading a new page does not trigger a close. A matching tab may be active or pinned. Closing the last tab can close its window.

For sign-in flows, choose a URL reached only on the final completion page. Tab Closer matches URLs; a page load alone does not tell it whether authentication succeeded.

Filters stay in your browser profile. The extension does not upload visited URLs or keep a tab history.

## Development

Run `npm test` for unit checks and `npm run package` to build a ZIP in `dist/`. The GitHub Actions workflow packages successful builds from `main` into timestamped releases without submitting them to browser stores.

`npm run test:browser`, `npm run test:edge`, and `npm run test:lifecycle` run browser checks on macOS with Chromium and Edge installed in `/Applications`.
