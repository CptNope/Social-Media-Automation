# F — Dashboard UX Plan

## 1. Design principles
1. **"What happened, what's next, what needs you."** Every screen answers those three questions in that order.
2. **Provenance is visible.** Every generated value can show where it came from (source chip → evidence). Every metric shows its date range and source; unavailable data is labelled "Not available from <platform>", never zero.
3. **Approval is the primary action.** Approve/Reject/Request changes are always reachable with one keystroke (`A`/`R`/`C`) in review views.
4. **Risk is color + label, never color alone.** High-risk items carry a "Needs approval: sensitive claim" text label.
5. **Kill switch is never more than one click away** for operators (header "Pause" control with confirmation).
6. **Calm density.** Agency operators handle many clients; use tables and calendars, not marketing-style cards.
7. **WCAG 2.2 AA**, keyboard-first, works at 1280px and degrades to mobile for client review.

## 2. Navigation architecture

```
Agency level (operator / admin)
├── Clients (workspace switcher + portfolio table: health, pending approvals, next publish, spend)
├── Approvals inbox (all clients)
├── Activity & audit
└── Platform settings (admin)

Workspace level (per client)
├── Overview
├── Brand
│   ├── Brand DNA (versions, diff, approve)
│   ├── Claims & evidence
│   └── Asset library
├── Plan
│   ├── Campaigns
│   └── Calendar (month / week / day)
├── Content studio
├── Approvals
├── Publishing
│   ├── Queue & history
│   └── Export packages
├── Website & search
│   ├── SEO health
│   └── Search & AI visibility (P2)
├── Competitors (P1)
├── Analytics & reports
├── Connections (integration health & capabilities)
└── Settings (automation mode, members, budgets, pause)

Client review portal (magic link)
├── This week's items (card stack, approve/reject/comment)
├── Brand DNA proposal (field-by-field confirm)
└── Monthly report
```

## 3. Wireframes (low fidelity)

### 3.1 Workspace overview
```
┌──────────────────────────────────────────────────────────────────────────┐
│ Acme Plumbing ▾   Mode: Assisted ▾          [⏸ Pause all]   Jeremy ▾      │
├──────────────────────────────────────────────────────────────────────────┤
│ NEEDS YOU (4)                         │ NEXT 7 DAYS                       │
│ • 3 posts awaiting client approval    │ Mon  FB  "Winter pipe tips"  ✅   │
│ • LinkedIn connection needs re-auth   │ Tue  GBP Offer: Furnace check ⏳  │
│                                       │ Wed  Blog draft → WordPress  ✅   │
├───────────────────────────────────────┼───────────────────────────────────┤
│ WHAT HAPPENED (last 30 days)          │ RECOMMENDED                       │
│ 18 published · 2 exported · 0 failed  │ 1. Fix 12 pages missing meta desc │
│ Website clicks from social: 214       │ 2. Add service-area page: Worcester│
│ (GA4, Sep 15–Oct 14)                  │ 3. Re-use top post format (n=6)   │
└───────────────────────────────────────┴───────────────────────────────────┘
```

### 3.2 Content studio item
```
┌ Facebook · Educational · Persona: New homeowner · Objective: Traffic ───┐
│ Hook   [ Frozen pipes cost more than a thermostat ...            ]        │
│ Body   [ ...                                                     ]        │
│ CTA    [ Book a winter check ▾ ]   Link: /winter-check?utm_...  ✓         │
│ Claims used: [Licensed in MA ✓ verified] [24/7 service ✓ verified]        │
│ Findings: ⚠ 1 warning — "cheapest" not a registered claim  [Fix]          │
│ Creative: [preview 1080×1080]  Alt text ✓                                 │
│ Risk: Medium · Requires approval in Assisted mode                         │
│ [Regenerate ▾] [Save]                 [Submit for approval]               │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Connections
```
Channel     Account            Status          Can publish        Scheduling  Analytics   Token
Facebook    Acme Plumbing      ● Connected     text,photo,video   native      yes         never expires
Instagram   @acmeplumbing      ○ Export only   (awaiting review)  —           —           —
WordPress   acmeplumbing.com   ● Connected     drafts, SEO meta   native      via GSC     app password
Bluesky     acme.bsky.social   ● Connected     text,image         platform    public cnt  ok
```

## 4. Key workflows (screens touched)
1. **Onboard:** Clients → New → Sources upload → (job) → Brand DNA diff view → send to client portal → active.
2. **Monthly plan:** Plan → Generate 30-day plan → calendar drag/drop → Approve plan → Content studio batch-generate.
3. **Batch approval:** Approvals → filter by risk → select → Approve selected (high-risk items excluded from batch, must be opened individually).
4. **Incident:** Header Pause → choose scope (all / client / channel) → reason → confirm; Publishing → item → "Delete from platform" (where supported) → audit entry + client notice template.

## 5. Visual direction
Neutral UI chrome so client brand colors in previews stand out; one accent color for primary actions; status colors paired with icons and labels; monospace for IDs/UTMs; tabular numerals in metrics.
