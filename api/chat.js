-- Lumos IA: limite creazione file su finestra mobile di 24 ore.
-- Eseguire UNA SOLA VOLTA nel Supabase SQL Editor del progetto Lumos IA.

create table if not exists public.lumos_creation_usage (
  id bigserial primary key,
  request_id uuid not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('free', 'base', 'premium')),
  created_at timestamptz not null default now()
);

create index if not exists lumos_creation_usage_user_created_idx
  on public.lumos_creation_usage (user_id, created_at desc);

alter table public.lumos_creation_usage enable row level security;

revoke all on table public.lumos_creation_usage from anon, authenticated;
grant all on table public.lumos_creation_usage to service_role;

create or replace function public.reserve_lumos_creation(
  p_user_id uuid,
  p_plan text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_used integer;
  v_reset_at timestamptz;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Parametri mancanti';
  end if;
  if p_plan not in ('free', 'base', 'premium') then
    raise exception 'Piano non valido';
  end if;

  v_limit := case p_plan when 'free' then 3 when 'base' then 10 when 'premium' then 15 end;

  -- Serializza le richieste dello stesso account: evita che richieste simultanee
  -- superino il limite prima che una prenotazione sia registrata.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::integer, min(created_at + interval '24 hours')
    into v_used, v_reset_at
    from public.lumos_creation_usage
   where user_id = p_user_id
     and created_at > now() - interval '24 hours';

  if v_used >= v_limit then
    return jsonb_build_object(
      'allowed', false,
      'used', v_used,
      'limit', v_limit,
      'remaining', 0,
      'reset_at', v_reset_at
    );
  end if;

  insert into public.lumos_creation_usage (request_id, user_id, plan)
  values (p_request_id, p_user_id, p_plan);

  v_used := v_used + 1;
  return jsonb_build_object(
    'allowed', true,
    'request_id', p_request_id,
    'used', v_used,
    'limit', v_limit,
    'remaining', greatest(v_limit - v_used, 0),
    'reset_at', null
  );
end;
$$;

create or replace function public.release_lumos_creation(
  p_user_id uuid,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.lumos_creation_usage
   where user_id = p_user_id and request_id = p_request_id;
  return found;
end;
$$;

revoke all on function public.reserve_lumos_creation(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_lumos_creation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_lumos_creation(uuid, text, uuid) to service_role;
grant execute on function public.release_lumos_creation(uuid, uuid) to service_role;
