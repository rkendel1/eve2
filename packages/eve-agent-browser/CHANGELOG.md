# @eve/agent-browser

## 0.2.1

### Patch Changes

- 8f522a3: Every published export now has JSDoc, and source comments outside the public API are removed; runtime behavior is unchanged.
- Updated dependencies [4ba334a]
- Updated dependencies [1eb96d5]
- Updated dependencies [443d436]
- Updated dependencies [9e5ae93]
- Updated dependencies [e56166c]
- Updated dependencies [96996c8]
- Updated dependencies [1eb96d5]
- Updated dependencies [db0c3a7]
- Updated dependencies [05f2c46]
- Updated dependencies [8f522a3]
- Updated dependencies [90c9e7f]
- Updated dependencies [05f2c46]
- Updated dependencies [4ba334a]
- Updated dependencies [a534538]
- Updated dependencies [0c0275b]
  - eve@1.1.0

## 0.2.0

Released 2026-11-16 · [Compare with 0.1.0](https://github.com/vercel/eve/compare/%40eve%2Fagent-browser%400.1.0...%40eve%2Fagent-browser%400.2.0)

### Dependencies

- Updated eve to 1.0.1.

## 0.1.0

Released 2026-11-15 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fagent-browser%400.1.0)

### Features

- Add the experimental `@eve/agent-browser` extension for sandboxed browser automation backed by agent-browser.
  The package ports `@agent-browser/eve` with 42 browser tools, app-owned access settings, inline screenshots, per-tool overrides, and sandbox installation helpers. It targets agent-browser 0.41.1 and uses eve's environment preparation API. With content boundaries enabled, it preserves CLI boundary metadata and renders model-facing markers after screenshot filtering. The existing `extension/agent-browser` registry item now installs this package.
  Change imports from `@agent-browser/eve`, `@agent-browser/eve/tools`, and `@agent-browser/eve/sandbox` to the corresponding `@eve/agent-browser` entry points. Prepare sandbox templates with `VercelSandbox.environment({ prepare })` instead of `bootstrap`.
  Thanks @Railly for the upstream extension implementation. ([#5855](https://github.com/vercel/eve/pull/5855))

### Dependencies

- Updated eve to 1.0.0.

## 0.1.0-rc.1

Released 2026-11-09 · [Compare with 0.1.0-rc.0](https://github.com/vercel/eve/compare/%40eve%2Fagent-browser%400.1.0-rc.0...%40eve%2Fagent-browser%400.1.0-rc.1)

### Dependencies

- Updated eve to 1.0.0-rc.7.

## 0.1.0-rc.0

Released 2026-11-03 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fagent-browser%400.1.0-rc.0)

### Features

- Add the experimental `@eve/agent-browser` extension for sandboxed browser automation backed by agent-browser.
  The package ports `@agent-browser/eve` with 42 browser tools, app-owned access settings, inline screenshots, per-tool overrides, and sandbox installation helpers. It targets agent-browser 0.41.1 and uses eve's environment preparation API. With content boundaries enabled, it preserves CLI boundary metadata and renders model-facing markers after screenshot filtering. The existing `extension/agent-browser` registry item now installs this package.
  Change imports from `@agent-browser/eve`, `@agent-browser/eve/tools`, and `@agent-browser/eve/sandbox` to the corresponding `@eve/agent-browser` entry points. Prepare sandbox templates with `VercelSandbox.environment({ prepare })` instead of `bootstrap`.
  Thanks @Railly for the upstream extension implementation. ([#5855](https://github.com/vercel/eve/pull/5855))

### Dependencies

- Updated eve to 1.0.0-rc.3.
