# Styling & Design System

## Stack

- **Tailwind v4** with `@plugin "daisyui"` (15 themes + custom `"pi"` theme)
- **CSS variable bridge**: shadcn `--color-*` names mapped to daisyUI vars in `@theme inline` block
- **`tailwind-variants`** (`tv()`): used for variant/size class generation (e.g., `buttonVariants`)
- **`cn()` from `$lib/utils`**: Tailwind class merging via clsx + twMerge

## The "pi" Theme

Custom OKLCH dark theme designed for long terminal-adjacent reading sessions:

| Token | Value | Purpose |
|-------|-------|---------|
| `--color-base-100` | `oklch(20% 0.018 290)` | Main chat background (obsidian violet) |
| `--color-base-200` | `oklch(16% 0.016 290)` | Sidebars, cards |
| `--color-base-300` | `oklch(13% 0.015 290)` | Deepest accents |
| `--color-primary` | `oklch(74% 0.15 300)` | Iridescent violet accent |
| `--color-secondary` | `oklch(76% 0.11 215)` | Calm cyan accent |
| `--color-accent` | `oklch(79% 0.13 170)` | Mint/teal accent |

### Theme Radius Variables

```css
--radius-selector: 0.75rem;
--radius-field: 0.75rem;
--radius-box: 1rem;
--radius-md: 0.5rem;  /* Used by button component xs/sm sizes */
```

## Typography

- **Root**: `font-mono` applied at page level for terminal feel
- **Prose (assistant markdown)**: Overridden to `font-family: var(--font-sans, ...)` in `.prose` class — sans-serif for readable prose
- **Code blocks**: Remain monospace via `.prose code` and `.hljs` classes

## Animation Timing

Two-tier standard:

| Tier | Duration | Use |
|------|----------|-----|
| Micro-interactions | 150ms | Buttons, toggles, composer border |
| Layout transitions | 250ms | Messages (`msg-in`), sidebars |

- `msg-in`: `animation: msg-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both`
- Composer: `transition: border-color 150ms ease, box-shadow 250ms ease`

## Global CSS Classes (`app.css`)

| Class | Purpose |
|-------|---------|
| `.aurora` | Ambient radial color wash backdrop (login/empty states) |
| `.composer` | Focus-charged input surface with violet glow |
| `.shimmer-text` | Sliding gradient for "thinking…" previews |
| `.msg-in` | Message entrance animation (rise + fade) |
| `.pi-glyph` | Iridescent gradient on π character |
| `.trace-row` / `.trace-body` | Tool call trace rendering |
| `.prose` | Assistant markdown output (sans-serif override) |
| `.code-block` | Code block styling |
| `.file-link` | Inline file reference links |
| `.typing-dot` | Animated typing indicator dots |
| `.skip-link` | Accessibility skip navigation |

## Visual Effects

- **Aurora backdrop**: 3 radial gradients at 10%/7%/5% opacity blending primary/secondary/accent
- **π breathing**: `pi-breathe` keyframe, 4.5s cycle, 0.7→1.0 opacity with expanding drop-shadow
- **Composer glow**: Focus state adds 35% primary box-shadow halo
- **Selection**: Primary-tinted text selection via `::selection`

## Accessibility

- **`prefers-reduced-motion`**: Globally disables all animations/transitions
- **`touch-action: manipulation`**: Removes 300ms tap delay on interactive elements
- **Focus rings**: `.focus-ring` class with primary-tinted outline
- **Scrollbars**: Thin, theme-aware on pointer devices; hidden on mobile

## Component Patterns

- **shadcn-style UI primitives**: Compound sub-components + `index.ts` re-exports
- **bits-ui wrapping**: Dialog, Select, Tabs, Tooltip, ScrollArea, Switch, Separator
- **Data attributes**: `data-slot="button"`, `data-size="sm"` drive internal styling
- **No component unit tests** — UI tested exclusively via Playwright E2E

## Formatting

- Prettier: 2-space, single quotes, trailingComma es5, printWidth 100, prettier-plugin-svelte
