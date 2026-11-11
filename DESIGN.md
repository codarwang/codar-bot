# Design System — Codar Bot Website (codarbot.com)

## Product Context
- **What:** Self-hosted multi-bot AI team workbench on the pi runtime — a group chat where AI bots with their own models, roles, memories, and budgets collaborate on real work.
- **Audience:** Dual — developers fluent in CLI/agent tools, and AI-curious builders without professional dev skills (PMs, content creators).
- **Site type:** Marketing landing + full docs section at /docs.
- **Memorable thing:** "A room of AI helpers, working on your own machine."

## Aesthetic Direction
- **Direction:** Workshop editorial — warm paper, ink type, literary serif display, monospace machine-voice, one amber accent.
- **Decoration level:** Intentional-minimal. No gradients, no 3D mascots, no purple. The live chat-timeline artifact is the decoration.
- **Mood:** A warm, disciplined workshop: alive (chat activity, bot voices) yet controlled (approvals, budgets, audit).

## Typography
- **Display/Hero:** Fraunces (Google Fonts, variable) — workshop-literary serif with character; used for major claims and section titles. Weight 550 for a relaxed touch.
- **Body/UI:** Instrument Sans — humanist grotesque, warm-neutral, high legibility; all body copy, nav, buttons, docs.
- **Mono (machine voice):** IBM Plex Mono — npm commands, bot badges, metrics, code, activity lines.
- **Loading:** Google Fonts CDN with `display=swap` (self-host before public launch).
- **Scale:** 12 / 14 / 16 / 20 / 24 / 32 / 48 / 64 / 80px (1.25 modular ratio, clamp() on display sizes).

## Color
- **Approach:** Restrained — one warm accent on warm neutrals.
- **Paper:** `#F7F3EA` — page background (extracted from approved mockup A, 62% coverage).
- **Ink:** `#1B1916` — primary text.
- **Card surface:** `#E8E0D0` — panels, chat card, code frames.
- **Border:** `#D8CFBC` — hairlines, dividers.
- **Secondary text:** `#8A8378` — muted stone.
- **Accent (amber):** `#D97706` — links, the hero highlight word, one highlighted chat border, focus states. Never a filled wall.
- **Bot personality colors:** Chief amber `#D97706`, Writer leaf `#3D7A44`, Reviewer slate `#37536B` — avatars and names only.
- **Semantic:** success `#3D7A44`, warning `#B45309`, error `#A93226`, info `#37536B`.
- **Dark mode:** Deferred. Light-first is the differentiator in a cold-dark category.

## Layout
- **Approach:** Grid-disciplined with one editorial break — the hero chat timeline (tilt/bleed allowed only there).
- **Grid:** 12-col desktop, 6-col tablet, single-col mobile; max content width 1200px.
- **Hero:** ~45/55 split — serif claim left, chat-timeline artifact right (Variant A base).
- **Docs:** sidebar nav + content column ~72ch.
- **Border radius:** relaxed — sm 6px / md 10px / lg 16px / pill 999px. Never bubbly-uniform.

## Spacing
- **Base unit:** 8px. Scale: 4/8/16/24/32/48/64/96.
- **Density:** Comfortable-airy (marketing), comfortable (docs).

## Motion
- **Approach:** Minimal-functional + one signature move.
- **Signature:** Hero chat timeline — messages arrive with a 60ms stagger fade-rise on load (the room is alive).
- **Durations:** 120–240ms; easing: enter ease-out / exit ease-in / move ease-in-out.
- **Reduced motion:** Full respect via `prefers-reduced-motion`.

## Fusion decisions (Felix, from mockup review)
- Variant A is the base (rated 5/5).
- Variant B magazine-cover headline: optional hero strengthening — larger serif claim, full-width.
- Variant C mono badge layer: fold into hero chat card (bot badges) and feature section.
- Relaxation pass (Felix, pachat.ai-inspired, 2026-11-11): keep the workshop-editorial skeleton, loosen the mood —
  one amber word-highlight in the hero claim ("Your rules."), bot personality colors (each helper gets its own
  warm-hue avatar/name color), a cast strip (colored face + name tag row) under the chat room head, rounder radii
  (cards 16px, controls 10px), softer display weight (550), gentle card hover lift, shorter conversational hero
  copy. Formula: restrained ink-and-paper frame × playful colored cast × generous whitespace.

## Docs section scope (full, this phase)
- Quickstart (dual-path: "I write code" fast path / "new to terminals" gentle path), configuration, governance (budgets/approvals/audit), extending.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-11-11 | Initial design system | /design-consultation: 7-site visual research, workshop-editorial direction, mockup A base + B/C fusion, tokens extracted from approved mockup |
| 2026-11-11 | Relaxation pass (pachat.ai-inspired) | Felix: "loosen it up a little" — word-highlight, colored bot cast, rounder radii; visually accepted in real Chromium |
