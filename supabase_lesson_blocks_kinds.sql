-- ============================================================================
-- Recall — lesson_blocks.kind CHECK constraint (widened 2026-10-11)
--
-- lesson_blocks.kind must be in this list or every save of a lesson
-- containing the block fails with:
--   "new row for relation "lesson_blocks" violates check constraint
--    "lesson_blocks_kind_check""
--
-- The kind list must mirror BLOCK_DEFS in lesson-render.js. This version
-- adds the four interactive card kinds that were missing from the
-- original constraint: memory_game, swipe_cards, card_slideshow and
-- card_shuffle (the "Image card shuffle" block).
--
-- Re-running this file is safe: it drops and re-adds the constraint.
-- ============================================================================

alter table lesson_blocks drop constraint lesson_blocks_kind_check;

alter table lesson_blocks add constraint lesson_blocks_kind_check check (kind in (
  -- text & structure
  'heading', 'text', 'callout', 'image', 'video', 'math', 'keypoints',
  'worked_example', 'reveal', 'flashcard',
  -- interactive practice
  'mcq', 'truefalse', 'shortanswer', 'fillblank', 'match', 'ordering',
  'hotspot', 'categorise', 'denary_binary', 'password_checker',
  'slider', 'dial', 'sequence', 'connect', 'pile', 'html',
  -- layout
  'accordion', 'tabs', 'compare', 'timeline', 'steps',
  -- study aids
  'objectives', 'prerequisites', 'glossary', 'summary', 'audio',
  'divider', 'quote', 'cardset', 'mindmap', 'flashcard_stack',
  'progress_meter',
  -- interactive card kinds (2026-08 / 2026-10)
  'memory_game', 'swipe_cards', 'card_slideshow', 'card_shuffle'
));