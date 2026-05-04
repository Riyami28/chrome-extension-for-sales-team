-- ClientLens – Sales Copilot — Initial Schema
-- Run in Supabase SQL editor

-- ── User Profiles ─────────────────────────────────────────────────────────────

create type user_role as enum ('admin', 'designer', 'pmm', 'sales_rep', 'viewer');

create table user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text,
  role user_role not null default 'sales_rep',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trigger to auto-create profile on sign-up
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into user_profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Design System ─────────────────────────────────────────────────────────────

create table design_systems (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  colors jsonb not null default '{}',
  typography jsonb not null default '{}',
  allowed_components text[] not null default '{}',
  templates jsonb not null default '[]',
  uploaded_by uuid references user_profiles(id),
  created_at timestamptz not null default now()
);

-- ── Brand Voice ───────────────────────────────────────────────────────────────

create table brand_voice (
  id uuid primary key default gen_random_uuid(),
  tone_adjectives text[] not null default '{}',
  avoid_words text[] not null default '{}',
  messaging_framework jsonb not null default '{}',
  icp_tone_overrides jsonb not null default '{}',
  updated_by uuid references user_profiles(id),
  created_at timestamptz not null default now()
);

-- ── Assets (uploaded docs, case studies, etc.) ────────────────────────────────

create type asset_type as enum (
  'design_system', 'brand_voice', 'case_study',
  'product_doc', 'metrics', 'competitor_intel'
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type asset_type not null,
  storage_path text not null,
  chunk_count int not null default 0,
  namespace text not null,
  uploaded_by uuid references user_profiles(id),
  created_at timestamptz not null default now()
);

-- ── Generation History ────────────────────────────────────────────────────────

create table generation_history (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  user_id uuid references user_profiles(id),
  company_name text not null,
  icp_role text not null,
  action_type text not null,
  output_type text not null,
  result jsonb,
  sources_used text[],
  brand_compliant boolean,
  hallucination_check text,
  created_at timestamptz not null default now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────

alter table user_profiles enable row level security;
alter table design_systems enable row level security;
alter table brand_voice enable row level security;
alter table assets enable row level security;
alter table generation_history enable row level security;

-- Users can read their own profile
create policy "users_read_own" on user_profiles
  for select using (auth.uid() = id);

-- Admins can read all profiles (via service key bypass in backend)
-- Service key bypasses RLS — all writes from backend use service key

-- Users can read published DS + brand voice
create policy "all_read_design_system" on design_systems
  for select using (true);

create policy "all_read_brand_voice" on brand_voice
  for select using (true);

create policy "all_read_assets" on assets
  for select using (true);

-- Users can see their own generation history
create policy "users_read_own_history" on generation_history
  for select using (auth.uid() = user_id);

-- ── Storage Buckets ───────────────────────────────────────────────────────────

-- Run separately in Supabase dashboard:
-- Create bucket: "assets" (private)
-- Create bucket: "exports" (private)
