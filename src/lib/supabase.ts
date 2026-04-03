import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Untyped client — we cast results at call sites using our own types.
// This avoids fighting with Supabase's complex generated type system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = createClient<any>(supabaseUrl, supabaseAnonKey);

// Default user for dev (no auth)
export const DEFAULT_USER_EMAIL = "nelson@subtlerealestate.com";
