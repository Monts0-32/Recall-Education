-- ============================================================================
-- diagnose_rls.sql
--
-- Paste this in the Supabase SQL editor. It prints:
--   1. Your profile role and id.
--   2. Every policy on subjects / topics / lessons / lesson_blocks
--      (the USING / WITH CHECK clauses are the things that gate writes).
--   3. Whether pgcrypto is installed (needed for gen_random_bytes()).
--
-- If any policy still says role = 'staff' (singular, old form) while your
-- profile role is 'staff_author' / 'staff_reviewer' / 'admin' (new form),
-- that's the cause of "Insert was blocked by row-level security." — run
-- supabase_rls_staff_roles_fix.sql to rewrite the policies.
-- ============================================================================

-- 1. Your profile. The id here is what auth.uid() returns when you sign in.
select 'profile' as section, id, role, created_at
  from public.profiles
  where id = auth.uid();

-- 2. Every policy on the four tables we care about. The "qual" and "with_check"
-- columns are the USING and WITH CHECK expressions. If you see
--   qual: ((EXISTS ( SELECT ... p.role = 'staff' ... )))
-- you need to run supabase_rls_staff_roles_fix.sql.
select 'policy' as section,
       schemaname, tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('subjects', 'topics', 'lessons', 'lesson_blocks')
 order by tablename, policyname;

-- 3. pgcrypto. The publish flow calls _generate_lesson_code() which uses
-- gen_random_bytes(); that function lives in pgcrypto. If the extension
-- isn't installed, publish_lesson() errors with
-- "function gen_random_bytes(integer) does not exist".
select 'extension' as section, extname, extversion
  from pg_extension
 where extname in ('pgcrypto', 'pg_trgm');
