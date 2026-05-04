-- Migration 002 — LLM proxy usage logging
-- Run in Supabase SQL editor after 001_initial_schema.sql

-- ── llm_usage ────────────────────────────────────────────────────────────────
-- One row per call through /api/v1/llm/{complete,stream}.
-- Distinct from `generation_history` which records pitch-level events;
-- a single pitch generation issues multiple LLM calls (research, retrieval,
-- ICP-personalization, brand-compliance, validation), and we want each one
-- traceable for cost attribution and rate-limit accounting.

create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references user_profiles(id) on delete set null,
  provider text not null,                 -- anthropic | groq | gemini | custom
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  duration_ms int not null default 0,
  streamed boolean not null default false,
  request_id text,                        -- provider-issued id, when available
  error text,                             -- null on success
  created_at timestamptz not null default now()
);

-- Most queries will be by user (cost view) or by created_at window.
create index llm_usage_user_idx on llm_usage (user_id, created_at desc);
create index llm_usage_created_idx on llm_usage (created_at desc);

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table llm_usage enable row level security;

-- Users see only their own rows. Backend writes via service key (bypasses RLS).
create policy "users_read_own_llm_usage" on llm_usage
  for select using (auth.uid() = user_id);

-- Admins read all (service key bypass — no policy needed for write).
