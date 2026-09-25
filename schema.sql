-- FarmSense ALTER/UPDATE migration. It does not create, rename, or drop tables.
-- Existing tables and rows are preserved; only missing columns are added.

do $$ begin
 if to_regclass('public.sources') is not null then
  alter table sources add column if not exists title text;
  alter table sources add column if not exists organization text;
  alter table sources add column if not exists url text;
  alter table sources add column if not exists source_type text;
  alter table sources add column if not exists published_date date;
  alter table sources add column if not exists last_verified_at timestamptz;
  alter table sources add column if not exists region text;
  alter table sources add column if not exists language text;
  alter table sources add column if not exists trust_level int;
 end if;
 if to_regclass('public.admin_users') is not null then
  alter table admin_users add column if not exists user_id uuid;
 end if;
 if to_regclass('public.crops') is not null then
  alter table crops add column if not exists name text;
 end if;
 if to_regclass('public.crop_calendars') is not null then
  alter table crop_calendars add column if not exists crop_id uuid;
  alter table crop_calendars add column if not exists region text;
  alter table crop_calendars add column if not exists season text;
  alter table crop_calendars add column if not exists stage_name text;
  alter table crop_calendars add column if not exists day_from int;
  alter table crop_calendars add column if not exists day_to int;
  alter table crop_calendars add column if not exists source_id uuid;
 end if;
 if to_regclass('public.recommendation_rules') is not null then
  alter table recommendation_rules add column if not exists name text;
  alter table recommendation_rules add column if not exists category text;
  alter table recommendation_rules add column if not exists priority text default 'medium';
  alter table recommendation_rules add column if not exists conditions jsonb default '[]'::jsonb;
  alter table recommendation_rules add column if not exists action_template jsonb;
  alter table recommendation_rules add column if not exists source_id uuid;
  alter table recommendation_rules add column if not exists enabled boolean default true;
  alter table recommendation_rules add column if not exists version int default 1;
  alter table recommendation_rules add column if not exists created_at timestamptz default now();
 end if;
 if to_regclass('public.knowledge_articles') is not null then
  alter table knowledge_articles add column if not exists title text;
  alter table knowledge_articles add column if not exists summary text;
  alter table knowledge_articles add column if not exists body text;
  alter table knowledge_articles add column if not exists category text;
  alter table knowledge_articles add column if not exists crop text;
  alter table knowledge_articles add column if not exists language text default 'en';
  alter table knowledge_articles add column if not exists source_id uuid;
  alter table knowledge_articles add column if not exists version int default 1;
  alter table knowledge_articles add column if not exists published_at timestamptz;
  alter table knowledge_articles add column if not exists archived_at timestamptz;
  alter table knowledge_articles add column if not exists updated_at timestamptz default now();
 end if;
 if to_regclass('public.government_schemes') is not null then
  alter table government_schemes add column if not exists title text;
  alter table government_schemes add column if not exists summary text;
  alter table government_schemes add column if not exists eligibility text;
  alter table government_schemes add column if not exists benefits text;
  alter table government_schemes add column if not exists how_to_apply text;
  alter table government_schemes add column if not exists deadline date;
  alter table government_schemes add column if not exists state text;
  alter table government_schemes add column if not exists level text;
  alter table government_schemes add column if not exists source_id uuid;
  alter table government_schemes add column if not exists last_verified_at timestamptz;
  alter table government_schemes add column if not exists expires_at timestamptz;
  alter table government_schemes add column if not exists language text default 'en';
 end if;
 if to_regclass('public.financial_products') is not null then
  alter table financial_products add column if not exists title text;
  alter table financial_products add column if not exists summary text;
  alter table financial_products add column if not exists provider text;
  alter table financial_products add column if not exists eligibility text;
  alter table financial_products add column if not exists interest_rate text;
  alter table financial_products add column if not exists fees text;
  alter table financial_products add column if not exists tenure text;
  alter table financial_products add column if not exists source_id uuid;
  alter table financial_products add column if not exists last_verified_at timestamptz;
  alter table financial_products add column if not exists expires_at timestamptz;
  alter table financial_products add column if not exists language text default 'en';
 end if;
 if to_regclass('public.machinery') is not null then
  alter table machinery add column if not exists title text;
  alter table machinery add column if not exists summary text;
  alter table machinery add column if not exists category text;
  alter table machinery add column if not exists purchase_cost text;
  alter table machinery add column if not exists rental_cost text;
  alter table machinery add column if not exists source_id uuid;
  alter table machinery add column if not exists last_verified_at timestamptz;
  alter table machinery add column if not exists language text default 'en';
 end if;
 if to_regclass('public.profiles') is not null then
  alter table profiles add column if not exists user_id uuid;
  alter table profiles add column if not exists name text;
  alter table profiles add column if not exists phone text;
  alter table profiles add column if not exists age int;
  alter table profiles add column if not exists language text default 'en';
  alter table profiles add column if not exists district text;
  alter table profiles add column if not exists state text;
  alter table profiles add column if not exists taluk text;
  alter table profiles add column if not exists village text;
  alter table profiles add column if not exists latitude float8;
  alter table profiles add column if not exists longitude float8;
  alter table profiles add column if not exists location_source text;
 end if;
 if to_regclass('public.farms') is not null then
  alter table farms add column if not exists user_id uuid default auth.uid();
  alter table farms add column if not exists name text;
  alter table farms add column if not exists area numeric;
  alter table farms add column if not exists area_unit text default 'acre';
  alter table farms add column if not exists land_type text;
  alter table farms add column if not exists soil_type text;
  alter table farms add column if not exists irrigation_method text;
  alter table farms add column if not exists latitude float8;
  alter table farms add column if not exists longitude float8;
  alter table farms add column if not exists location_source text;
  alter table farms add column if not exists created_at timestamptz default now();
 end if;
 if to_regclass('public.fields') is not null then
  alter table fields add column if not exists user_id uuid default auth.uid();
  alter table fields add column if not exists farm_id uuid;
  alter table fields add column if not exists name text;
  alter table fields add column if not exists area numeric;
 end if;
 if to_regclass('public.crop_cycles') is not null then
  alter table crop_cycles add column if not exists user_id uuid default auth.uid();
  alter table crop_cycles add column if not exists farm_id uuid;
  alter table crop_cycles add column if not exists field_id uuid;
  alter table crop_cycles add column if not exists crop_id uuid;
  alter table crop_cycles add column if not exists variety text;
  alter table crop_cycles add column if not exists sowing_date date;
  alter table crop_cycles add column if not exists expected_harvest date;
  alter table crop_cycles add column if not exists planting_method text;
  alter table crop_cycles add column if not exists irrigation_method text;
  alter table crop_cycles add column if not exists active boolean default true;
 end if;
 if to_regclass('public.soil_tests') is not null then
  alter table soil_tests add column if not exists user_id uuid default auth.uid();
  alter table soil_tests add column if not exists farm_id uuid;
  alter table soil_tests add column if not exists tested_on date default current_date;
  alter table soil_tests add column if not exists soil_type text;
  alter table soil_tests add column if not exists ph numeric;
  alter table soil_tests add column if not exists nitrogen text;
  alter table soil_tests add column if not exists phosphorus text;
  alter table soil_tests add column if not exists potassium text;
  alter table soil_tests add column if not exists organic_carbon numeric;
  alter table soil_tests add column if not exists moisture text;
  alter table soil_tests add column if not exists ec numeric;
  alter table soil_tests add column if not exists kind text default 'lab';
 end if;
 if to_regclass('public.actions') is not null then
  alter table actions add column if not exists user_id uuid default auth.uid();
  alter table actions add column if not exists farm_id uuid;
  alter table actions add column if not exists crop_cycle_id uuid;
  alter table actions add column if not exists rule_id uuid;
  alter table actions add column if not exists source_id uuid;
  alter table actions add column if not exists title text;
  alter table actions add column if not exists short_description text;
  alter table actions add column if not exists reason text;
  alter table actions add column if not exists category text;
  alter table actions add column if not exists priority text;
  alter table actions add column if not exists due_date date;
  alter table actions add column if not exists template jsonb;
  alter table actions add column if not exists requires_confirmation boolean default false;
  alter table actions add column if not exists confidence text;
  alter table actions add column if not exists status text default 'new';
  alter table actions add column if not exists created_at timestamptz default now();
  alter table actions add column if not exists completed_at timestamptz;
 end if;
 if to_regclass('public.action_events') is not null then
  alter table action_events add column if not exists user_id uuid default auth.uid();
  alter table action_events add column if not exists action_id uuid;
  alter table action_events add column if not exists event text;
  alter table action_events add column if not exists note text;
  alter table action_events add column if not exists created_at timestamptz default now();
 end if;
 if to_regclass('public.notifications') is not null then
  alter table notifications add column if not exists user_id uuid default auth.uid();
  alter table notifications add column if not exists farm_id uuid;
  alter table notifications add column if not exists action_id uuid;
  alter table notifications add column if not exists title text;
  alter table notifications add column if not exists message text;
  alter table notifications add column if not exists category text;
  alter table notifications add column if not exists priority text;
  alter table notifications add column if not exists created_at timestamptz default now();
  alter table notifications add column if not exists read_at timestamptz;
 end if;
 if to_regclass('public.recommendation_runs') is not null then
  alter table recommendation_runs add column if not exists user_id uuid default auth.uid();
  alter table recommendation_runs add column if not exists farm_id uuid;
  alter table recommendation_runs add column if not exists crop_cycle_id uuid;
  alter table recommendation_runs add column if not exists rule_id uuid;
  alter table recommendation_runs add column if not exists inputs jsonb;
  alter table recommendation_runs add column if not exists output jsonb;
  alter table recommendation_runs add column if not exists created_at timestamptz default now();
 end if;
 if to_regclass('public.farmer_loans') is not null then
  alter table farmer_loans add column if not exists user_id uuid default auth.uid();
  alter table farmer_loans add column if not exists provider text;
  alter table farmer_loans add column if not exists amount numeric;
  alter table farmer_loans add column if not exists start_date date;
  alter table farmer_loans add column if not exists interest_rate numeric;
  alter table farmer_loans add column if not exists outstanding numeric;
  alter table farmer_loans add column if not exists next_payment date;
 end if;
 if to_regclass('public.feedback') is not null then
  alter table feedback add column if not exists user_id uuid default auth.uid();
  alter table feedback add column if not exists action_id uuid;
  alter table feedback add column if not exists useful boolean;
  alter table feedback add column if not exists reason text;
  alter table feedback add column if not exists created_at timestamptz default now();
 end if;
end $$;

-- Common crops grown across India's major agricultural regions.
do $$ begin
 if to_regclass('public.crops') is not null then
  insert into crops(name) values
 ('Rice'), ('Wheat'), ('Maize'), ('Barley'), ('Sorghum'), ('Pearl millet'), ('Finger millet'), ('Foxtail millet'), ('Little millet'), ('Kodo millet'), ('Barnyard millet'), ('Proso millet'),
 ('Chickpea'), ('Pigeon pea'), ('Green gram'), ('Black gram'), ('Lentil'), ('Field pea'), ('Cowpea'), ('Moth bean'), ('Horse gram'),
 ('Groundnut'), ('Soybean'), ('Mustard'), ('Rapeseed'), ('Sesame'), ('Sunflower'), ('Safflower'), ('Linseed'), ('Castor'), ('Niger seed'),
 ('Sugarcane'), ('Cotton'), ('Jute'), ('Mesta'), ('Tobacco'),
 ('Potato'), ('Onion'), ('Tomato'), ('Brinjal'), ('Okra'), ('Cabbage'), ('Cauliflower'), ('Peas'), ('Carrot'), ('Radish'), ('Turnip'), ('Beetroot'), ('Spinach'), ('Amaranth'), ('Cucumber'), ('Bottle gourd'), ('Bitter gourd'), ('Ridge gourd'), ('Snake gourd'), ('Pumpkin'), ('Chilli'), ('Capsicum'), ('Garlic'), ('Ginger'), ('Turmeric'),
 ('Mango'), ('Banana'), ('Citrus'), ('Guava'), ('Papaya'), ('Pomegranate'), ('Grapes'), ('Apple'), ('Pear'), ('Peach'), ('Plum'), ('Apricot'), ('Litchi'), ('Pineapple'), ('Watermelon'), ('Muskmelon'), ('Coconut'), ('Arecanut'), ('Cashew'), ('Coffee'), ('Tea'), ('Rubber'),
 ('Cardamom'), ('Black pepper'), ('Cumin'), ('Coriander'), ('Fennel'), ('Fenugreek'), ('Clove'), ('Nutmeg'), ('Tamarind'), ('Isabgol'), ('Aloe vera'), ('Ashwagandha'), ('Mentha'),
  ('Fodder maize'), ('Napier grass'), ('Berseem'), ('Lucerne')
  on conflict (name) do nothing;
 end if;
end $$;

create or replace function is_admin() returns boolean language sql security definer stable as $$ select exists(select 1 from admin_users where user_id=auth.uid()) $$;

do $$ declare t text; begin
 foreach t in array array['profiles','farms','fields','crop_cycles','soil_tests','actions','action_events','notifications','recommendation_runs','farmer_loans','feedback'] loop
  if to_regclass('public.' || t) is not null then
   execute format('alter table %I enable row level security', t);
   if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'own_' || t) then
    execute format('create policy "own_%1$s" on %1$I for all using (user_id=auth.uid()) with check (user_id=auth.uid())', t);
   end if;
  end if;
 end loop;
 foreach t in array array['sources','crops','crop_calendars','recommendation_rules','knowledge_articles','government_schemes','financial_products','machinery'] loop
  if to_regclass('public.' || t) is not null then
   execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'read_' || t) then
     execute format('create policy "read_%1$s" on %1$I for select to authenticated using (true)', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'admin_' || t) then
     execute format('create policy "admin_%1$s" on %1$I for all using (is_admin()) with check (is_admin())', t);
    end if;
  end if;
 end loop;
end $$;
do $$ begin
 if to_regclass('public.admin_users') is not null then
  alter table admin_users enable row level security;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'admin_users' and policyname = 'self_admin') then
   create policy "self_admin" on admin_users for select using (user_id=auth.uid());
  end if;
 end if;
end $$;

-- High-risk content must carry a source before publishing.
do $$ begin
 if to_regclass('public.government_schemes') is not null and not exists (select 1 from pg_constraint where conname = 'scheme_needs_source' and conrelid = 'government_schemes'::regclass) then
  alter table government_schemes add constraint scheme_needs_source check (source_id is not null) not valid;
 end if;
 if to_regclass('public.financial_products') is not null and not exists (select 1 from pg_constraint where conname = 'finance_needs_source' and conrelid = 'financial_products'::regclass) then
  alter table financial_products add constraint finance_needs_source check (source_id is not null) not valid;
 end if;
 if to_regclass('public.recommendation_rules') is not null and not exists (select 1 from pg_constraint where conname = 'rule_needs_source' and conrelid = 'recommendation_rules'::regclass) then
  alter table recommendation_rules add constraint rule_needs_source check (source_id is not null) not valid;
 end if;
end $$;
