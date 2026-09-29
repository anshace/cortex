# UI Registry

Check here before building anything new; add to it after building. The point is
that a second "chip" or a third "confirm dialog" is a defect, not a feature.

## Shared primitives (OwnerApp.tsx unless noted)

| Component | Where | Use it for |
|---|---|---|
| `Card` / `CardTitle` | OwnerApp | any panel; `CardTitle` takes `icon` + `hue` token |
| `Chip` | OwnerApp | a short status pill: `hue`, `label`, `title` |
| `KV` | OwnerApp | a label/value row with tabular figures |
| `TwoCol` | OwnerApp | a form card beside a list |
| `RowActions` | OwnerApp | hover-revealed icon buttons; items are `{label, icon, danger?, onClick}` |
| `Empty` | OwnerApp | an empty list with a next action |
| `Section` / `PanelHead` | Settings | settings-panel chrome |
| `Logo` | Logo.tsx | the Cortex mark; `size` prop, never a raster |
| `Confirm` / `Prompt` dialogs | OwnerApp `setConfirm`/`setPrompt` | any destructive or irreversible step; supports `cta` |
| `PanelIconButton` | WorkspaceApp | rail and toolbar icon buttons |
| `Tooltip` (Chakra) | everywhere | every icon-only control, with `openDelay` |

## Feature surfaces

| Surface | File | Notes |
|---|---|---|
| Landing | `Landing.tsx` | public, pre-auth |
| Login | `Login.tsx` | split 60/40, follows colour mode |
| Owner console | `OwnerApp.tsx` | root only; sections orgs/accounts/storage/audit |
| Workspace app | `WorkspaceApp.tsx` | org surface: rail + file tree + editor |
| Chat | `ChatView.tsx`, `ChatChannels.tsx` | mentions rendered by a rehype plugin |
| AI assistant | `AiView.tsx`, `aiChatParts.tsx`, `aiDiff.tsx` | SSE turn rendering, file-tool diffs |
| Editors | `EditorPane.tsx`, `SoloEditor.tsx`, `Spreadsheet.tsx`, `Whiteboard.tsx`, `BinaryView.tsx`, `MarkdownPreview.tsx`, `HtmlPreview.tsx` | chosen by file kind |
| Settings | `Settings.tsx` | per-user prefs incl. Storage for root |
| Update/offline banner | `UpdateBanner.tsx` | **registers the service worker** — do not delete |

## To add when built

Bot identity treatment (badge/avatar marker, mention autocomplete entries, the
owner's agent-management panel) — see `feature-specs/01-chat-agents.md`.
