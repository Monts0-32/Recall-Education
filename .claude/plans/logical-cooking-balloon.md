# Plan: Supercharge the staff lesson creator with interactive blocks, layout blocks, study aids, and editor polish

## Context

`staff.html` is already a fully working staff dashboard (1,713 lines) with auth
gate (`role = 'staff'` on `profiles`), a subject → topic → lesson tree, and 10
block types: `heading`, `text` (markdown), `callout`, `image`, `video`, `math`
(KaTeX), `keypoints`, `worked_example`, `reveal`, `flashcard`. The schema in
`supabase_staff.sql` adds a `profiles.role` column, a `lesson_blocks` table
with a jsonb `data` column and CHECK-constrained `kind`, RLS policies for
staff writes, a `reorder_lesson_blocks` RPC, and seeds the 22 subjects.

You want to make the lessons "extremely engaging and interactive." The auth
5xx/429 errors are out of scope — you have those under control.

The plan extends `staff.html` and one new SQL file. All changes are additive
on the `data` jsonb column: the `kind` CHECK constraint is widened, the
default value is a sensible starter object per new kind, and the editor +
renderer split is the same pattern that already exists for the 10 existing
kinds.

## What "engaging and interactive" means in this plan

Four buckets, in priority order (you confirmed all four):

1. **Interactive practice blocks** — students can answer in-place and get
   feedback without leaving the lesson.
2. **Layout & structure blocks** — accordions, tabs, comparison tables,
   timelines.
3. **Study aid blocks** — objectives, glossary, prerequisites, summary card.
4. **Editor quality-of-life** — drag-to-reorder, keyboard shortcuts, block
   duplication, template library, image upload to Supabase Storage.

All new block data lives in the existing `lesson_blocks.data` jsonb. No
schema migration for the blocks themselves. A new SQL file handles the
Supabase Storage bucket for the image-upload feature (you said yes to
"small RLS-only bucket and a staff write policy").

## Block types to add

### Interactive practice

| `kind`     | Data shape                                                                 | Interaction model                                                                                                       |
|------------|----------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `mcq`      | `{ prompt, options: [{text, correct, feedback}], explanation, multi }`     | Radio (or checkbox if `multi`) buttons. On submit: green/red per option, reveal per-option `feedback` and the `explanation` |
| `truefalse`| `{ prompt, answer: bool, explanation }`                                    | True / False buttons. On submit: green/red, reveal `explanation`                                                          |
| `shortanswer` | `{ prompt, answers: [string] (case-insensitive trim match), explanation }` | Input + check button. On submit: exact match (or one of `answers`); reveal `explanation` regardless of right/wrong       |
| `fillblank`| `{ text, blanks: [{answer, index}] }` — `text` contains `___` placeholders  | Inline inputs in the gaps. Check button. Green/red per blank, reveal the full sentence on submit                          |
| `match`    | `{ prompt, pairs: [{left, right}] }`                                        | Two columns of buttons; student clicks a left then a right to pair. On submit: green for correct pairs, red for wrong     |
| `ordering` | `{ prompt, items: [{text, id}] }` (id is just a stable key)                | Up/down buttons next to each item, or HTML5 drag-and-drop. On check: reveal correct order                                  |
| `hotspot`  | `{ imageUrl, alt, hotspots: [{x: 0..100, y: 0..100, label, correct}] }`     | Click on the image; if x/y within ~5% of a `correct` hotspot → green label; else reveal all hotspots with their labels    |

All of these render the same way: prompt at top, interactive UI, a "Check"
button, then a feedback panel that appears below. The feedback panel is the
key engagement lever — it shows per-option/per-blank feedback and a follow-up
explanation, so students learn even when they got it wrong. The same block
also drives the editor: a two-pane layout (controls on the left, mini live
preview on the right) so staff see what students will see while they type.

### Layout & structure

| `kind`     | Data shape                                          | Notes                                                                                          |
|------------|-----------------------------------------------------|------------------------------------------------------------------------------------------------|
| `accordion`| `{ items: [{title, markdown}] }`                    | Each item is collapsible. Open/close state is local to the student (not persisted — fine for v1) |
| `tabs`     | `{ items: [{label, markdown}] }`                    | Horizontal tab bar, content area below. Active tab styled with `--blue`                         |
| `compare`  | `{ leftTitle, rightTitle, leftMarkdown, rightMarkdown }` | Two-column side-by-side. Stacks on narrow screens                                              |
| `timeline` | `{ items: [{date, title, markdown}] }`              | Vertical line with dots. Each item has a heading and a markdown body                            |

### Study aids

| `kind`          | Data shape                                                                              | Notes                                                                                            |
|-----------------|-----------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| `objectives`    | `{ items: [{text, done?}] }`                                                            | Checklist of "by the end of this lesson you will…" — students tick as they go (local state only)  |
| `prerequisites` | `{ items: [string] }`                                                                   | Static list of "you should already know…" items with links to earlier lessons (free-text href)  |
| `glossary`      | `{ items: [{term, definition}] }`                                                       | Two-column definition list                                                                       |
| `summary`       | `{ markdown, keyTakeaways: [string] }`                                                  | End-of-lesson recap. Three or four big "key takeaway" bullets above the longer recap markdown   |

### Editor quality-of-life (no new kinds, just better editing)

- **Drag-to-reorder** in the block list using native HTML5 DnD (no library).
  Reorder is local; the existing `reorder_lesson_blocks` RPC handles the
  server-side commit on save.
- **Keyboard shortcuts** in the editor: `Cmd/Ctrl+S` saves, `Cmd/Ctrl+Z`
  per-block undo (last 50 mutations per block, ring buffer), `Esc` collapses
  the preview modal.
- **Block duplication**: per-block "duplicate" icon. Copies the block data
  and inserts it directly below the source.
- **Template library**: a small dropdown on the "Add block" picker
  ("Insert from template…") with 4–6 starter templates (e.g. "Worked
  example — quadratic equation", "MCQ — photosynthesis", "Reveal — key
  terms"). Each template is just a `kind` + prefilled `data`. Templates are
  hardcoded in a single JS object — easy to add to.
- **Inline image upload**: the `image` block gains an "Upload" button next
  to the URL field. The button opens a file picker; on selection it
  `supabaseClient.storage.from('lesson-images').upload(path, file)` and
  fills the URL field with the public URL. Path is
  `lessons/${lessonId}/${random}.${ext}` so the RLS policy can scope writes
  to authenticated staff. (RLS check is `bucket.objects` `auth.uid() is
  not null` and a small `storage.objects` policy — see SQL section.)
- **Autosave indicator**: existing `state.dirty` flag already drives a
  yellow "Unsaved changes" pill. Add a 1.2s debounce so typing doesn't feel
  twitchy (small fix, mostly cosmetic).

## What the new SQL file does

A new `supabase_uploads.sql` is added next to `supabase_staff.sql`. It is
idempotent and assumes `supabase_staff.sql` (and therefore
`profiles.role = 'staff'`) has already been applied.

```sql
-- 1. Create a private bucket 'lesson-images' for the image-upload feature.
insert into storage.buckets (id, name, public)
values ('lesson-images', 'lesson-images', true)
on conflict (id) do nothing;

-- 2. Public read (so <img src="..."> works without signed URLs).
drop policy if exists "lesson_images_read_all" on storage.objects;
create policy "lesson_images_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'lesson-images');

-- 3. Staff write — only objects under lessons/... are allowed, and only by
--    a user whose profile.role = 'staff'.
drop policy if exists "lesson_images_staff_write" on storage.objects;
create policy "lesson_images_staff_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-images'
    and (storage.foldername(name))[1] = 'lessons'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'staff'
    )
  );

-- 4. Staff delete their own uploads (same scoping).
drop policy if exists "lesson_images_staff_delete" on storage.objects;
create policy "lesson_images_staff_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lesson-images'
    and owner = auth.uid()
  );

-- 5. Widen the lesson_blocks.kind CHECK constraint to include the 11 new
--    kinds. Idempotent: drop the old constraint by name and add the new one.
alter table public.lesson_blocks
  drop constraint if exists lesson_blocks_kind_check;

alter table public.lesson_blocks
  add constraint lesson_blocks_kind_check
  check (kind in (
    -- existing 10
    'heading','text','callout','image','video',
    'math','keypoints','worked_example','reveal','flashcard',
    -- interactive practice (7)
    'mcq','truefalse','shortanswer','fillblank','match','ordering','hotspot',
    -- layout & structure (4)
    'accordion','tabs','compare','timeline',
    -- study aids (4)
    'objectives','prerequisites','glossary','summary'
  ));
```

Total: 1 new SQL file, ~50 lines, runs after `supabase_staff.sql`.

## Files modified

1. `staff.html` — the only file that changes for the JS work. Approx +1,400
   lines, structured exactly like the existing code: one entry per new kind
   in `BLOCK_DEFS`, one new branch per kind in `renderBlockEditorBody`,
   matching CSS in the `<style>` block.
2. `supabase_uploads.sql` — **new** file, ~50 lines, the migration above.
3. No other files touched. `dashboard.html`, `index.html`, the auth pages,
   and `consent.html` are not affected by this work.

## Implementation strategy for `staff.html`

The existing 10 kinds follow a tight, repeatable pattern. I'll extend it
mechanically. New code reuses the same primitives the existing code already
defines:

- `escapeHtml`, `$, initials, toast` (staff.html:649–664) — reused as-is.
- `renderMarkdown` (staff.html:667) — reused for any field that accepts
  markdown (callout, accordion items, tab bodies, compare panels, timeline
  bodies, summary body).
- `videoEmbedUrl` (staff.html:703) — reused only by the video kind.
- `BLOCK_DEFS[kind].render` (staff.html:726) — each new kind adds one entry
  with a `label`, `defaults`, and `render` function. Same shape.
- `renderBlockEditorBody(b, i)` (staff.html:1369) — one new `case` per kind.
- `window.updateBlock(i, patch)` (staff.html:1551) — reused. The existing
  `preview` refresh logic works because each new kind's `block-body`
  contains a `.preview` element.
- `repeater` (CSS at staff.html:503) — reused for any list-of-items editor
  (MCQ options, match pairs, ordering items, accordion items, tabs, glossary,
  objectives, etc.). No new CSS for the editor side.
- `preview` styles (staff.html:395–499) — a handful of new selectors for
  the new student-facing UI: `.mcq-option`, `.fillblank-input`,
  `.hotspot-img`, `.tab-bar`, `.timeline`, `.compare-grid`, etc.

The render contract for interactive blocks is: **render the prompt and the
inputs in the static markup; wire the interactivity in JS at render time**.
The "Check" button is a `<button>` that the render function attaches an
event listener to. For the editor, the same block is rendered in a smaller
form (just the prompt + a textarea of structured data, with the live
preview pane beside it). The editor reads/writes `data` exactly like the
existing kinds.

## Drag-to-reorder (no library)

- Each `.block` element gets `draggable="true"`.
- `dragstart`: stash the dragged index on the dataTransfer.
- `dragover` on another `.block`: prevent default to allow drop, set a
  "drop-above / drop-below" visual indicator (a 2px blue line between
  blocks).
- `drop`: read the new index from the drop position, splice the block
  array, re-render.
- Pure client-side until "Save blocks" is pressed, at which point the
  existing `saveBlocks()` flow (staff.html:1635) detects the
  `order_index` change for each moved block and writes via the
  `lesson_blocks` table — no RPC call needed for individual block
  reorders, the existing update path covers it. The `reorder_lesson_blocks`
  RPC stays in place for a future bulk operation.

## Per-block undo (`Cmd/Ctrl+Z`)

- A `window.blockUndo[i] = []` array per block index, holding the last 50
  `data` snapshots.
- On any `updateBlock` call: push the previous `data` onto
  `blockUndo[i]` (capped at 50).
- `Cmd/Ctrl+Z` handler: if the active element is inside a block, pop
  `blockUndo[i]` and assign. Re-render that block.
- This is intentionally simple — true global undo across blocks is out of
  scope.

## Image upload

- The `image` block editor gains a small "Upload" button beside the URL
  field. Clicking it opens a hidden `<input type="file" accept="image/*">`.
- On file change:
  1. Validate size ≤ 8 MB; reject with a toast if not.
  2. Compute path `lessons/${state.currentLesson.id}/${crypto.randomUUID()}.${ext}`.
  3. `supabaseClient.storage.from('lesson-images').upload(path, file, { upsert: false, contentType: file.type })`.
  4. On success: get the public URL via `.getPublicUrl(path)`, write it
     into `b.data.url`, re-render the editor body (the URL field and the
     preview both update).
- Failure path: toast with the storage error message; don't clear the
  current URL.
- The image URL field stays — staff can still paste external URLs. Upload
  is a convenience, not a replacement.

## Editor keyboard shortcuts

- `Cmd/Ctrl+S` (or just `S` when no input is focused): triggers the
  "Save blocks" button.
- `Cmd/Ctrl+Enter` while inside a block's textarea: triggers "Save blocks".
- `Cmd/Ctrl+Z` while inside a block: per-block undo (see above).
- `Esc` while a modal is open: closes the modal (existing close button
  already does this; just wire the key).
- A tiny `kbd` hint in the editor header: "⌘S save · ⌘Z undo block · ⌘⏎ save+next".

## Template library

- A new dropdown in the block picker: a button labelled "+ From template".
- Clicking it opens a small popover with 6 starter templates:
  1. **Worked example — quadratic equation** (`worked_example` with
     `(x+3)(x-2)=0` worked through).
  2. **MCQ — photosynthesis** (`mcq` with 4 options, one correct).
  3. **Reveal — key terms** (5 `reveal` blocks pre-filled with biology
     terms).
  4. **Comparison — mitosis vs meiosis** (`compare` with two columns).
  5. **Timeline — WWII** (4 `timeline` items).
  6. **Glossary — atomic structure** (5 `glossary` entries).
- Selecting a template inserts one or more blocks at the end of the
  current lesson (most templates are a single block, the "Reveal — key
  terms" inserts 5).
- Templates are stored in a single JS object so adding more is trivial:
  ```js
  const TEMPLATES = {
    'mcq-photosynthesis': {
      label: 'MCQ — photosynthesis',
      blocks: [{ kind: 'mcq', data: { prompt: '...', options: [...], ... } }]
    },
    // ...
  };
  ```

## Verification

1. **Run a local server and screenshot the result.** From the project root,
   `python -m http.server 8000` and open `http://localhost:8000/staff.html`
   in a browser. Sign in as a user with `role = 'staff'` (the SQL comment
   block at the bottom of `supabase_staff.sql` already shows how to promote
   a user). Take a screenshot of:
   - The lesson tree on the left populated with seeded subjects.
   - The new block picker (should show all 21 kinds, grouped: Text &
     structure / Interactive practice / Layout / Study aids).
   - One new interactive block being edited (e.g. `mcq`) with the live
     preview pane showing the rendered MCQ.
   - The drag-to-reorder working (screenshot mid-drag, showing the drop
     indicator).
   - The image block with the "Upload" button visible.
2. **Run `supabase_uploads.sql` against the project** in the Supabase SQL
   editor and verify the migration is idempotent (re-run it, no errors).
3. **Smoke-test each new block kind** by creating one of each in a
   scratch lesson, saving, refreshing, and confirming the data round-trips
   through Supabase intact.
4. **Image upload** — sign in as staff, open the image block, click
   Upload, pick a small PNG, confirm the public URL renders in the
   preview.
5. **Keyboard shortcuts** — `Cmd+S` saves, `Cmd+Z` inside a textarea
   reverts the last change for that block.

## Out of scope (flagged but not built)

- True cross-block undo (the per-block ring buffer is enough for v1).
- Versioning / lesson history (would need a `lesson_versions` table).
- Real-time collaboration (Supabase Realtime subscriptions) — staff can
  already save; the last writer wins.
- Drag-to-reorder for *subjects / topics / lessons* in the sidebar (only
  blocks in the lesson editor get drag-reorder in this round).
- A "Preview as student" toggle that loads the dashboard lesson viewer if
  one exists (no public viewer exists yet — the preview modal here is the
  closest analogue).
