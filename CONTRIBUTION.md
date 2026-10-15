# Contributing

Contributions are welcome through pull requests and issue reports. Before
starting substantial work, check the existing issues and discuss larger
changes in an issue so the scope and approach are clear.

## Reporting an issue

Include the browser and version, the affected site, the expected behavior, and
what happened instead. For playback problems, mention other enabled
extensions that could interact with video or tab behavior. Do not include
private account details or other sensitive information.

## Development setup

1. Install a current Node.js release and the project's package manager.
2. Clone the repository and run `npm install`.
3. Start the extension in a development browser:
   - `npm run start:chrome`
   - `npm run start:firefox`
4. To open browser developer tools with the extension, use
   `npm run debug:chrome` or `npm run debug:firefox`.

The start and debug scripts prepare the corresponding browser manifest and
launch the extension from `src/`.

## Build, lint, and tests

- `npm run build` builds the Chrome and Firefox packages under
  `web-ext-artifacts`.
- `npm run lint` runs the WebExtension linter against the Firefox manifest.
- `npm run test:e2e` runs the Playwright end-to-end tests. The current test
  configuration exercises the extension in Chromium.

Run the relevant checks before submitting a pull request, and include the
results in the pull request description. If a check cannot be run, explain
why.

## Pull requests

- Keep changes focused and describe the user-visible behavior they affect.
- Add or update tests for behavior changes where practical.
- Update the documentation when changing supported behavior or configuration.
- Include screenshots for visible UI changes when useful.
- Do not commit generated browser packages, test output, or local configuration.
