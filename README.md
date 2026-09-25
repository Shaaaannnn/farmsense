# FarmSense (HTML/CSS/JS)
1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. Put your URL + anon key in `js/config.js`. Enable Phone/Email OTP in Supabase Auth.
3. Add yourself to `admin_users`, then add content in Supabase Studio: `sources`, `crops`, `crop_calendars`, `recommendation_rules`, `knowledge_articles` (set `published_at`), `government_schemes`, `financial_products`, `machinery`. Every rule/scheme/product needs a `source_id`.
4. Serve the folder over HTTPS (e.g. `npx serve`, Netlify, Vercel static).
- Add a language: add a key in `js/locales.js`. Missing strings fall back to English.
- Rule format: `conditions: [{"f":"crop","op":"eq","v":"tomato"},{"f":"soil_moisture","op":"missing"}]`; ops: eq, neq, lt, gt, lte, gte, in, missing. Fields: crop, stage, days_since_sowing, soil_moisture, soil_ph/nitrogen/phosphorus/potassium, irrigation_method, soil_type, temp_c, rain_prob_today, rain_prob_tomorrow.
- `action_template`: `{"title","short","reason","when","how":[],"look_for","if_found","observe":"moisture","requires_confirmation":true}`.
